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
    count = (
        Session.objects.filter(user=session.user, date=session.date, status="completed").count() + 1
    )
    minutes = prefs.long_break if count % prefs.long_every == 0 else prefs.short_break
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
    for block in Block.objects.filter(user=user, date__range=(first, last), deleted=False):
        if block.id == ignore_block:
            continue
        bs, be = block_bounds(block, prefs)
        if start < be and end > bs:
            raise Conflict(
                f"This session would overlap “{block.title}”. Wait for the block or adjust the plan."
            )


def next_focus(user, prefs, now, ignore_break=False):
    requested = prefs.next_focus_seconds or prefs.focus_minutes * 60
    upcoming = None
    for block in Block.objects.filter(
        user=user,
        deleted=False,
        date__range=(local_day(prefs, now), local_day(prefs, now) + timedelta(days=1)),
    ):
        start, end = block_bounds(block, prefs)
        if start <= now < end:
            return 0, block
        if start > now and (upcoming is None or start < block_bounds(upcoming, prefs)[0]):
            upcoming = block
    if upcoming:
        available = math.floor((block_bounds(upcoming, prefs)[0] - now).total_seconds())
        requested = min(
            requested, max(0, available - (0 if ignore_break else prefs.short_break * 60))
        )
    return requested, upcoming


def start_session(user, prefs, now, block_id=None, ignore_break=False):
    if Session.objects.filter(user=user, status__in=["running", "paused"]).exists():
        raise Conflict("A timer is already active. Refresh to see it.")
    task = user.task_set.filter(done=False, archived=False).first()
    block = None
    kind, title = "focus", task.title if task else "Open focus"
    seconds, upcoming = next_focus(user, prefs, now, ignore_break)
    if block_id:
        block = Block.objects.get(id=block_id, user=user, kind="meeting", deleted=False)
        start, end = block_bounds(block, prefs)
        if not start <= now < end:
            raise Conflict("Start this meeting during its scheduled time.")
        if block.session_set.exclude(status="cancelled").exists():
            raise Conflict("This meeting has already been tracked.")
        seconds = math.ceil((end - now).total_seconds())
        kind, title, task = "meeting", block.title, None
    if seconds < 1:
        raise Conflict("No focus time available before the reserved block.")
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
    prefs.next_focus_seconds = None
    prefs.save(update_fields=["next_focus_seconds"])
    return session


def record_meeting(user, prefs, now, block_id):
    """Explicitly record a past reservation when its timer was not started."""
    block = Block.objects.get(user=user, pk=block_id, kind="meeting", deleted=False)
    existing = block.session_set.exclude(status="cancelled").first()
    if existing:
        if existing.status != "completed":
            raise Conflict("Finish the meeting timer before reviewing it.")
        return existing
    start, end = block_bounds(block, prefs)
    if end > now:
        raise Conflict("Record results after the meeting ends.")
    for other in Session.objects.filter(user=user, started_at__lt=end).exclude(status="cancelled"):
        other_end = other.ended_at or (
            now + timedelta(seconds=other.remaining_seconds)
            if other.status == "paused"
            else other.deadline
        )
        if other_end > start:
            raise Conflict("This meeting overlaps recorded work.")
    seconds = int((end - start).total_seconds())
    session = Session.objects.create(
        user=user,
        block=block,
        date=block.date,
        kind="meeting",
        title=block.title,
        started_at=start,
        resumed_at=start,
        deadline=end,
        ended_at=end,
        planned_seconds=seconds,
        remaining_seconds=0,
        elapsed_seconds=seconds,
        status="completed",
    )
    count = Session.objects.filter(user=user, date=block.date, status="completed").count()
    minutes = prefs.long_break if count % prefs.long_every == 0 else prefs.short_break
    session.break_until = end + timedelta(minutes=minutes)
    session.save(update_fields=["break_until"])
    block.fixed = True
    block.save(update_fields=["fixed"])
    Allocation.objects.create(session=session, label=block.title)
    return session


def resize_session(session, user, prefs, now, seconds, overrun=False):
    """Edit remaining time without losing worked time; reopen a natural completion."""
    if session.status == "completed":
        latest = (
            Session.objects.filter(user=user)
            .exclude(status="cancelled")
            .order_by("-started_at")
            .first()
        )
        if (
            not overrun
            or latest.id != session.id
            or session.ended_at != session.deadline
            or now - session.ended_at > timedelta(hours=1)
        ):
            raise Conflict("Only the latest naturally completed timer can overrun.")
        session.resumed_at = session.ended_at
        session.status = "running"
        session.ended_at = None
        session.break_until = None
        session.reviewed = False
    if session.status == "running":
        session.elapsed_seconds += max(0, int((now - session.resumed_at).total_seconds()))
        session.resumed_at = now
    end = now + timedelta(seconds=seconds)
    check_room(user, prefs, now, end, session.block_id)
    if session.block_id:
        block = session.block
        local_end = end.astimezone(ZoneInfo(block.timezone))
        if local_end.date() != block.date:
            raise Conflict("A meeting block must end on the same day.")
        # Round the reservation up to a minute so it covers the entire timer.
        reserved_end = datetime.fromtimestamp(
            math.ceil(local_end.timestamp() / 60) * 60, ZoneInfo(block.timezone)
        )
        if reserved_end.date() != block.date:
            raise Conflict("A meeting block must end on the same day.")
        check_room(user, prefs, now, reserved_end, block.id)
        block.end, block.fixed = reserved_end.time().replace(tzinfo=None), True
        block.save(update_fields=["end", "fixed"])
    session.deadline = end
    session.remaining_seconds = seconds
    session.planned_seconds = session.elapsed_seconds + seconds
    session.save()
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
        "can_overrun": session.status in ["running", "paused"]
        or (
            session.status == "completed"
            and session.ended_at == session.deadline
            and now - session.ended_at <= timedelta(hours=1)
        ),
        "reflection": session.reflection,
        "allocations": [
            {"task_id": a.task_id, "label": a.label, "sand": a.sand}
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
        "template_id": block.template_id,
        "fixed": block.fixed,
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
    count = sum(s.status == "completed" for s in sessions)
    for session in sessions:
        end = session.ended_at or (
            now + timedelta(seconds=session.remaining_seconds)
            if session.status == "paused"
            else session.deadline
        )
        if session.status in ["running", "paused"]:
            count += 1
            minutes = prefs.long_break if count % prefs.long_every == 0 else prefs.short_break
            end += timedelta(minutes=minutes)
        occupied.append((session.started_at, max(end, session.break_until or end)))
    occupied.sort()
    result = []
    first_duration = prefs.next_focus_seconds if day == local_day(prefs, now) else None

    def fill_gap(cursor, limit, count, reserved=False):
        nonlocal first_duration
        while cursor < limit:
            seconds = min(
                first_duration or prefs.focus_minutes * 60,
                int((limit - cursor).total_seconds()) - (prefs.short_break * 60 if reserved else 0),
            )
            if seconds < 60:
                break
            slot_duration = timedelta(seconds=seconds)
            if not reserved and slot_duration < timedelta(
                seconds=first_duration or prefs.focus_minutes * 60
            ):
                break
            result.append(
                {
                    "kind": "focus",
                    "start": cursor.isoformat(),
                    "end": (cursor + slot_duration).isoformat(),
                }
            )
            first_duration = None
            cursor += slot_duration
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
        count = fill_gap(start, min(busy_start, stop), count, reserved=True)
        start = max(start, busy_end)
        if start >= stop:
            break
    fill_gap(start, stop, count)
    return result
