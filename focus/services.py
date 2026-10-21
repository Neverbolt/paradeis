"""Timer and scheduling rules. All timer mutations run in a database transaction."""

import math
from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from django.utils import timezone

from .models import Allocation, Block, Preferences, Session, Task, TaskFocusSpan


class Conflict(ValueError):
    pass


def preferences(user):
    return Preferences.objects.get_or_create(user=user)[0]


def calendar_day(prefs, now=None):
    return (now or timezone.now()).astimezone(ZoneInfo(prefs.timezone)).date()


def local_day(prefs, now=None):
    local = (now or timezone.now()).astimezone(ZoneInfo(prefs.timezone))
    day = local.date()
    cutoff = getattr(prefs, "day_rollover", time(0))
    boundary = datetime.combine(day, cutoff).replace(tzinfo=local.tzinfo, fold=0)
    utc_boundary = boundary.astimezone(dt_timezone.utc)
    if utc_boundary.astimezone(local.tzinfo).replace(tzinfo=None) != boundary.replace(tzinfo=None):
        # A skipped cutoff advances at the first valid wall time after the jump.
        before = local.time() < cutoff
    else:
        # The first occurrence of a repeated cutoff wins; the day never rolls back.
        before = local.astimezone(dt_timezone.utc) < utc_boundary
    if before:
        day -= timedelta(days=1)
    return day


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


def work_at(user, prefs, now):
    for block in Block.objects.filter(user=user, kind="work", deleted=False,
                                     date=calendar_day(prefs, now)):
        start, end = block_bounds(block, prefs)
        if start <= now < end:
            return block
    return None


def session_topic(session):
    if session.topic_mode == "work":
        return None, session.work_topic
    if session.topic_mode == "open":
        return None, "Open focus"
    if session.topic_mode == "task" and session.selected_task_id:
        task = session.selected_task
        if not task.done and not task.archived:
            return task, task.title
    task = session.user.task_set.filter(done=False, archived=False).first()
    return task, task.title if task else "Open focus"


def choose_topic(session, prefs, now, topic=None):
    session.selected_task = None
    session.work_topic = ""
    if topic == "open":
        session.topic_mode = "open"
    elif topic not in [None, ""]:
        if not isinstance(topic, str) or not topic.isdecimal():
            raise ValueError("Choose a valid focus topic.")
        if not 1 <= int(topic) <= 2**53 - 1:
            raise ValueError("Choose a valid focus topic.")
        session.selected_task = Task.objects.get(user=session.user, id=int(topic),
                                                done=False, archived=False)
        session.topic_mode = "task"
    else:
        work = work_at(session.user, prefs, now)
        session.topic_mode = "work" if work else "queue"
        session.work_topic = work.title if work else ""
    session.title = session_topic(session)[1]


def track_top_task(session, now):
    """Record the chosen topic, or the changing queue, during active focus time."""
    if not session or session.kind != "focus":
        return
    span = session.task_spans.filter(ended_at__isnull=True).first()
    task, label = session_topic(session)
    if span and (session.status != "running" or span.task_id != (task.id if task else None)
                 or (not task and span.label != label)):
        close_task_span(session, now)
        span = None
    if session.status == "running" and span is None:
        TaskFocusSpan.objects.create(session=session, task=task, label=label, started_at=now)


def close_task_span(session, now):
    span = session.task_spans.filter(ended_at__isnull=True).first()
    if span:
        span.ended_at = max(span.started_at, min(now, session.deadline))
        span.save(update_fields=["ended_at"])


def collect_focus_tasks(session):
    totals = {}
    for span in session.task_spans.filter(ended_at__isnull=False):
        key = span.task_id if span.task_id else ("deleted", span.label)
        if key not in totals:
            totals[key] = [span, 0]
        totals[key][1] += (span.ended_at - span.started_at).total_seconds()
    qualifying = [span for span, seconds in totals.values() if seconds >= 30]
    if not qualifying:
        return  # Keep a useful description for a very short focus session.
    session.allocations.filter(automatic=True).delete()
    existing = list(session.allocations.all())
    for span in qualifying:
        if not any((span.task_id and a.task_id == span.task_id) or
                   (a.task_id is None and a.label == span.label)
                   for a in existing):
            allocation = Allocation.objects.create(session=session, task_id=span.task_id,
                label=span.label, automatic=True)
            existing.append(allocation)
    session.title = " + ".join(a.label for a in existing)[:200]


def complete(session, prefs, now):
    close_task_span(session, now)
    if session.kind == "focus":
        collect_focus_tasks(session)
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
    session.pending_break_seconds = 0 if prefs.auto_break else minutes * 60
    session.break_until = end + timedelta(minutes=minutes) if prefs.auto_break else None
    if session.break_until:
        _, reserved = next_focus(session.user, prefs, end, True)
        if reserved:
            session.break_until = min(session.break_until, max(end, block_bounds(reserved, prefs)[0]))
    session.save()
    return session


def settle(user, prefs, now):
    current = Session.objects.filter(user=user, status__in=["running", "paused"]).first()
    if current and current.status == "running" and current.deadline <= now:
        complete(current, prefs, current.deadline)
        return None
    return current


def check_room(user, prefs, start, end, ignore_block=None, kind=None):
    first, last = calendar_day(prefs, start), calendar_day(prefs, end)
    for block in Block.objects.filter(user=user, date__range=(first, last), deleted=False):
        if block.id == ignore_block:
            continue
        if (kind == "work") != (block.kind == "work"):
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
        date__range=(calendar_day(prefs, now), calendar_day(prefs, now) + timedelta(days=1)),
    ).exclude(kind="work"):
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


def start_session(user, prefs, now, block_id=None, ignore_break=False, topic=None, auto=False):
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
    if auto:
        seconds = min(seconds, max(0, int((auto_window_end(user, prefs, now) - now).total_seconds())))
    if seconds < 1:
        raise Conflict("No focus time available before the reserved block.")
    end = now + timedelta(seconds=seconds)
    if block:
        end = block_bounds(block, prefs)[1]
    check_room(user, prefs, now, end, block.id if block else None)
    Session.objects.filter(user=user, break_until__gt=now).update(break_until=now)
    Session.objects.filter(user=user, pending_break_seconds__gt=0).update(pending_break_seconds=0)
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
    if kind == "focus":
        choose_topic(session, prefs, now, topic)
        session.save(update_fields=["title", "topic_mode", "work_topic", "selected_task"])
        task, title = session_topic(session)
    Allocation.objects.create(session=session, task=task, label=title, automatic=kind == "focus")
    track_top_task(session, now)
    prefs.next_focus_seconds = None
    prefs.auto_armed = prefs.auto_focus
    prefs.save(update_fields=["next_focus_seconds", "auto_armed"])
    return session


def record_focus(user, prefs, now, start, minutes, title):
    """Record past focus explicitly, without starting a timer or adding a break."""
    from .recurrence import materialize

    end = start + timedelta(minutes=minutes)
    if end > now:
        raise ValueError("A completed pomo must end in the past.")
    materialize(user, calendar_day(prefs, start), calendar_day(prefs, end), calendar_day(prefs, now))
    check_room(user, prefs, start, end)
    for other in Session.objects.filter(user=user, started_at__lt=end).exclude(status="cancelled"):
        other_end = other.ended_at or (
            now + timedelta(seconds=other.remaining_seconds)
            if other.status == "paused" else other.deadline
        )
        if other_end > start:
            raise Conflict("This pomo overlaps recorded time. Choose a different time range.")
    seconds = minutes * 60
    session = Session.objects.create(user=user, date=local_day(prefs, start), kind="focus",
        title=title, started_at=start, resumed_at=start, deadline=end, ended_at=end,
        planned_seconds=seconds, remaining_seconds=0, elapsed_seconds=seconds, status="completed")
    Allocation.objects.create(session=session, label=title)
    latest = Session.objects.filter(user=user).order_by("-started_at", "-id").first()
    if latest.id == session.id:
        prefs.auto_armed = False
        prefs.save(update_fields=["auto_armed"])
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
        date=local_day(prefs, start),
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
    count = Session.objects.filter(user=user, date=session.date, status="completed").count()
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
    track_top_task(session, now)
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
        "focus_score": session.focus_score,
        "reviewed": session.reviewed,
        "can_overrun": session.status in ["running", "paused"]
        or (
            session.status == "completed"
            and session.ended_at == session.deadline
            and now - session.ended_at <= timedelta(hours=1)
        ),
        "reflection": session.reflection,
        "pending_break_seconds": session.pending_break_seconds,
        "topic_choice": (str(session.selected_task_id) if session.topic_mode == "task"
                         and session.selected_task_id else "open" if session.topic_mode == "open" else ""),
        "topic_default": session.work_topic if session.topic_mode == "work" else "",
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
    schedule_day = day + timedelta(days=int(prefs.day_start < prefs.day_rollover))
    windows = [(instant(schedule_day, prefs.day_start, prefs), instant(schedule_day, prefs.day_end, prefs))]
    windows.extend(block_bounds(b, prefs) for b in blocks if b.kind == "work")
    merged = []
    for first, last in sorted(windows):
        if merged and first <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(last, merged[-1][1]))
        else:
            merged.append((first, last))
    start, stop = max(merged[0][0], now), merged[-1][1]
    excluded_gaps = [(left[1], right[0]) for left, right in zip(merged, merged[1:])]
    occupied = [block_bounds(b, prefs) for b in blocks if b.kind != "work"] + excluded_gaps
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

    def fill_gap(cursor, limit, count, reserved=False, soft_end=False):
        nonlocal first_duration
        while cursor < limit:
            seconds = min(
                first_duration or prefs.focus_minutes * 60,
                int((limit - cursor).total_seconds()) - (prefs.short_break * 60 if reserved else 0),
            )
            if seconds < 60:
                break
            slot_duration = timedelta(seconds=seconds)
            if not reserved and not soft_end and slot_duration < timedelta(
                seconds=first_duration or prefs.focus_minutes * 60
            ):
                break
            result.append(
                {
                    "kind": "focus",
                    "title": next((b.title for b in blocks if b.kind == "work"
                                   and block_bounds(b, prefs)[0] <= cursor < block_bounds(b, prefs)[1]), "Focus"),
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
        soft_end = (busy_start, busy_end) in excluded_gaps
        count = fill_gap(start, min(busy_start, stop), count, reserved=not soft_end, soft_end=soft_end)
        start = max(start, busy_end)
        if start >= stop:
            break
    work_end = any(b.kind == "work" and block_bounds(b, prefs)[1] == stop for b in blocks)
    fill_gap(start, stop, count, soft_end=work_end)
    # Keep breaks between activities, but omit rest after the day's final activity.
    if result and result[-1]["kind"] == "break":
        rest_start = datetime.fromisoformat(result[-1]["start"])
        later_block = any(b.kind != "work" and block_bounds(b, prefs)[1] > rest_start for b in blocks)
        later_session = any((s.ended_at or s.deadline) > rest_start for s in sessions)
        if not later_block and not later_session:
            result.pop()
    return result


def fit_focus_before(session, prefs, now, start):
    """Preserve worked time while making room for a newly reserved fixed block."""
    if not session or session.kind != "focus" or start < now:
        return
    worked = (max(0, int((now - session.resumed_at).total_seconds()))
              if session.status == "running" else 0)
    remaining = max(0, session.remaining_seconds - worked)
    available = max(0, int((start - now).total_seconds()) - prefs.short_break * 60)
    if remaining <= available:
        return
    if session.status == "running":
        session.elapsed_seconds += worked
        session.resumed_at = now
    session.remaining_seconds = available
    session.planned_seconds = session.elapsed_seconds + available
    session.deadline = now + timedelta(seconds=available)
    if available == 0:
        complete(session, prefs, now)
        if session.break_until:
            session.break_until = min(session.break_until, start)
    session.save()


def pending_break(user, prefs, now):
    latest = Session.objects.filter(user=user).order_by("-started_at", "-id").first()
    return latest if (latest and latest.status == "completed" and
                      latest.date == local_day(prefs, now) and latest.pending_break_seconds) else None


def start_break(user, prefs, now):
    session = pending_break(user, prefs, now)
    if not session or Session.objects.filter(user=user, status__in=["running", "paused"]).exists():
        raise Conflict("There is no break waiting to start.")
    _, upcoming = next_focus(user, prefs, now, True)
    seconds = session.pending_break_seconds
    if upcoming:
        seconds = min(seconds, max(0, int((block_bounds(upcoming, prefs)[0] - now).total_seconds())))
    if seconds < 1:
        raise Conflict("A reserved block is in progress.")
    session.break_until = now + timedelta(seconds=seconds)
    session.pending_break_seconds = 0
    session.save(update_fields=["break_until", "pending_break_seconds"])


def auto_window_end(user, prefs, now):
    day = calendar_day(prefs, now)
    start, end = instant(day, prefs.day_start, prefs), instant(day, prefs.day_end, prefs)
    if start <= now < end:
        return end
    work = work_at(user, prefs, now)
    return block_bounds(work, prefs)[1] if work else now


def can_auto_start(user, prefs, now, active=None):
    if active or not prefs.auto_focus or not prefs.auto_armed:
        return False
    latest = Session.objects.filter(user=user).order_by("-started_at", "-id").first()
    if not latest or latest.status != "completed" or latest.date != local_day(prefs, now):
        return False
    if latest.pending_break_seconds or (latest.break_until and latest.break_until > now):
        return False
    if auto_window_end(user, prefs, now) < now + timedelta(seconds=60):
        return False
    return next_focus(user, prefs, now)[0] >= 60
