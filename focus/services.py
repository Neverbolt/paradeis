"""Timer and scheduling rules. All timer mutations run in a database transaction."""

import math
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from django.utils import timezone

from .models import Allocation, Block, Preferences, Session


class Conflict(ValueError):
    pass


def preferences(user):
    return Preferences.objects.get_or_create(user=user)[0]


def local_day(prefs, now=None):
    return (now or timezone.now()).astimezone(ZoneInfo(prefs.timezone)).date()


def instant(day, clock, prefs):
    """Reject nonexistent/ambiguous wall times rather than silently moving a block."""
    naive = datetime.combine(day, clock)
    zone = ZoneInfo(prefs.timezone)
    value = naive.replace(tzinfo=zone)
    if value.astimezone(dt_timezone.utc).astimezone(zone).replace(tzinfo=None) != naive:
        raise ValueError("That time does not exist because the clocks change. Choose another time.")
    if value.utcoffset() != naive.replace(tzinfo=zone, fold=1).utcoffset():
        raise ValueError("That time occurs twice because the clocks change. Choose another time.")
    return value.astimezone(dt_timezone.utc)


def block_bounds(block, prefs):
    zone = SimpleNamespace(timezone=block.timezone)
    return instant(block.date, block.start, zone), instant(block.date, block.end, zone)


def complete(session, prefs, now):
    if session.status == "running":
        end = min(now, session.deadline)
        session.elapsed_seconds += max(0, int((end - session.resumed_at).total_seconds()))
    else:
        end = now
    session.elapsed_seconds = min(session.elapsed_seconds, session.planned_seconds)
    session.status = "completed"
    session.ended_at = end
    session.remaining_seconds = 0
    count = Session.objects.filter(
        user=session.user, date=session.date, status="completed", kind="focus"
    ).count() + (session.kind == "focus")
    minutes = (
        prefs.long_break
        if session.kind == "focus" and count % prefs.long_every == 0
        else prefs.short_break
    )
    session.break_until = end + timedelta(minutes=minutes)
    session.save()
    return session


def settle(user, prefs, now):
    current = Session.objects.filter(user=user, status__in=["running", "paused"]).first()
    if current and current.status == "running" and current.deadline <= now:
        complete(current, prefs, current.deadline)
        return None
    return current


def check_room(user, prefs, start, end, ignore_block=None):
    first, last = local_day(prefs, start), local_day(prefs, end)
    for block in Block.objects.filter(user=user, date__range=(first, last)):
        if block.id == ignore_block:
            continue
        bs, be = block_bounds(block, prefs)
        if start < be and end > bs:
            raise Conflict(
                f"This session would overlap “{block.title}”. Wait for the block or adjust the plan."
            )


def start_session(user, prefs, now, block_id=None):
    if Session.objects.filter(user=user, status__in=["running", "paused"]).exists():
        raise Conflict("A timer is already active. Refresh to see it.")
    task = user.task_set.filter(done=False, archived=False).first()
    block = None
    kind, title = "focus", task.title if task else "Open focus"
    seconds = prefs.focus_minutes * 60
    if block_id:
        block = Block.objects.get(id=block_id, user=user, kind="meeting")
        start, end = block_bounds(block, prefs)
        if not start <= now < end:
            raise Conflict("Start this meeting during its scheduled time.")
        if block.session_set.exclude(status="cancelled").exists():
            raise Conflict("This meeting has already been tracked.")
        seconds = math.ceil((end - now).total_seconds())
        kind, title, task = "meeting", block.title, None
    end = now + timedelta(seconds=seconds)
    if block:
        end = block_bounds(block, prefs)[1]
    check_room(user, prefs, now, end, block.id if block else None)
    Session.objects.filter(user=user, break_until__gt=now).update(break_until=now)
    session = Session.objects.create(
        user=user,
        date=local_day(prefs, now),
        kind=kind,
        title=title,
        block=block,
        started_at=now,
        deadline=end,
        resumed_at=now,
        remaining_seconds=seconds,
        planned_seconds=seconds,
    )
    Allocation.objects.create(session=session, task=task, label=title)
    return session


def serialize_session(session, now):
    remaining = (
        max(0, math.ceil((session.deadline - now).total_seconds()))
        if session.status == "running"
        else session.remaining_seconds
    )
    return {
        "id": session.id,
        "block_id": session.block_id,
        "date": session.date.isoformat(),
        "kind": session.kind,
        "title": session.title,
        "status": session.status,
        "start": session.started_at.isoformat(),
        "end": (session.ended_at or session.deadline).isoformat(),
        "remaining": remaining,
        "planned": session.planned_seconds,
        "elapsed": session.elapsed_seconds,
        "effort": session.effort,
        "reviewed": session.reviewed,
        "reflection": session.reflection,
        "allocations": [
            {"task_id": a.task_id, "label": a.label, "percent": a.percent}
            for a in session.allocations.all()
        ],
    }


def serialize_block(block, prefs):
    start, end = block_bounds(block, prefs)
    return {
        "id": block.id,
        "kind": block.kind,
        "title": block.title,
        "date": block.date.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "start_time": str(block.start)[:5],
        "end_time": str(block.end)[:5],
    }


def summary(sessions):
    completed = [s for s in sessions if s.status == "completed"]
    return {
        "count": len(completed),
        "seconds": sum(s.elapsed_seconds for s in completed),
        "effort": sum(s.effort or 0 for s in completed),
        "unrated": sum(s.effort is None for s in completed),
    }


def plan(day, prefs, blocks, sessions, now):
    """Project complete pomos into free time only; never fabricate historical work."""
    if day < local_day(prefs, now):
        return []
    start = max(instant(day, prefs.day_start, prefs), now)
    stop = instant(day, prefs.day_end, prefs)
    occupied = [block_bounds(b, prefs) for b in blocks]
    count = sum(s.status == "completed" and s.kind == "focus" for s in sessions)
    for session in sessions:
        end = session.ended_at or (
            now + timedelta(seconds=session.remaining_seconds)
            if session.status == "paused"
            else session.deadline
        )
        if session.status in ["running", "paused"]:
            count += session.kind == "focus"
            minutes = prefs.long_break if count % prefs.long_every == 0 else prefs.short_break
            end += timedelta(minutes=minutes)
        occupied.append((session.started_at, max(end, session.break_until or end)))
    occupied.sort()
    result = []
    duration = timedelta(minutes=prefs.focus_minutes)

    def fill_gap(cursor, limit, count):
        while cursor + duration <= limit:
            result.append(
                {
                    "kind": "focus",
                    "start": cursor.isoformat(),
                    "end": (cursor + duration).isoformat(),
                }
            )
            cursor += duration
            count += 1
            rest = timedelta(
                minutes=prefs.long_break if count % prefs.long_every == 0 else prefs.short_break
            )
            rest_end = min(cursor + rest, limit)
            if rest_end > cursor:
                result.append(
                    {"kind": "break", "start": cursor.isoformat(), "end": rest_end.isoformat()}
                )
            cursor = rest_end
        return count

    for busy_start, busy_end in occupied:
        if busy_end <= start:
            continue
        count = fill_gap(start, min(busy_start, stop), count)
        start = max(start, busy_end)
        if start >= stop:
            break
    fill_gap(start, stop, count)
    return result
