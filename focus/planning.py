"""Calendar goals, hierarchy context, and optional advance planning reservations."""
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from django.db.models import Q
from django.utils import timezone

from .models import Block, PeriodGoal, PlanningRule, Session
from .services import Conflict, block_bounds, calendar_day, check_room, instant, local_day, serialize_block

PERIODS = ("quarter", "month", "week")


def period_date(period, day):
    if period == "day":
        return day
    if period == "week":
        return day - timedelta(days=day.weekday())
    if period == "month":
        return day.replace(day=1)
    if period == "quarter":
        return day.replace(month=((day.month - 1) // 3) * 3 + 1, day=1)
    raise ValueError("Choose day, week, month, or quarter.")


def next_period(period, day, step=1):
    day = period_date(period, day)
    if period == "day":
        return day + timedelta(days=step)
    if period == "week":
        return day + timedelta(weeks=step)
    months = step * (3 if period == "quarter" else 1)
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def weekdays(value):
    if not isinstance(value, list) or not value or any(type(v) is not int or not 0 <= v <= 6 for v in value) or len(set(value)) != len(value):
        raise ValueError("Choose at least one weekday, without duplicates.")
    return sorted(value)


def trigger_date(rule, target, workdays):
    if rule.period == "week":
        return target - timedelta(days=7) + timedelta(days=rule.weekday)
    last = target - timedelta(days=1)
    if rule.trigger_mode == "day":
        return last.replace(day=min(rule.day_of_month, last.day))
    while last.weekday() not in workdays:
        last -= timedelta(days=1)
    return last


def rule_for(user, period):
    return PlanningRule.objects.filter(user=user, period=period).first() or SimpleNamespace(
        period=period, enabled=False, weekday=4, trigger_mode="last_workday", day_of_month=31,
        time=time(17, 30) if period != "week" else time(17), minutes=25)


def proposed(rule, target, prefs):
    day = trigger_date(rule, target, prefs.planning_workdays)
    # Resolve a rare DST gap/repeated local trigger forward to a valid wall time.
    wall = datetime.combine(day, rule.time)
    for _ in range(181):
        try:
            start = instant(wall.date(), wall.time(), prefs)
            end = start + timedelta(minutes=rule.minutes)
            local_end = end.astimezone(ZoneInfo(prefs.timezone))
            instant(local_end.date(), local_end.time().replace(tzinfo=None), prefs)
            return start, end
        except ValueError:
            wall += timedelta(minutes=1)
    raise ValueError("Choose another planning trigger time.")


def reservation_room(user, prefs, start, end, ignore=None):
    from .recurrence import materialize
    materialize(user, calendar_day(prefs, start), calendar_day(prefs, end), calendar_day(prefs))
    local_end = end.astimezone(ZoneInfo(prefs.timezone))
    instant(local_end.date(), local_end.time().replace(tzinfo=None), prefs)
    if start.astimezone(ZoneInfo(prefs.timezone)).date() != local_end.date():
        raise ValueError("A planning pomo must end on the same calendar day.")
    check_room(user, prefs, start, end, ignore, kind="planning")
    for session in Session.objects.filter(user=user, started_at__lt=end).exclude(status="cancelled").filter(
            Q(ended_at__gt=start) | Q(status__in=["running", "paused"])):
        session_end = session.ended_at or (timezone.now() + timedelta(seconds=session.remaining_seconds) if session.status == "paused" else session.deadline)
        if session_end > start and session.block_id != ignore:
            raise Conflict("This planning time overlaps a session. Choose another time.")


def book(goal, prefs, start, end, auto=False):
    block = Block.objects.filter(goal_plan=goal).first()
    if block and block.session_set.exclude(status="cancelled").exists():
        raise Conflict("This planning pomo has already been tracked.")
    reservation_room(goal.user, prefs, start, end, block.id if block else None)
    zone = ZoneInfo(prefs.timezone)
    first, last = start.astimezone(zone), end.astimezone(zone)
    if block is None:
        block = Block(user=goal.user, goal_plan=goal)
    block.date, block.start, block.end = first.date(), first.time().replace(tzinfo=None), last.time().replace(tzinfo=None)
    block.timezone, block.kind, block.fixed, block.deleted = prefs.timezone, "planning", True, False
    block.title = "Daily review" if goal.period == "day" else f"{ {'week':'Weekly', 'month':'Monthly', 'quarter':'Quarterly'}[goal.period]} review & planning"
    block.planning_auto = auto
    block.save()
    return block


def ensure_reservations(user, prefs, now, first=None, last=None):
    first = first or local_day(prefs, now)
    last = last or first + timedelta(days=100)
    for rule in PlanningRule.objects.filter(user=user, enabled=True):
        target = period_date(rule.period, first)
        stop = next_period(rule.period, last)
        goals = {goal.date: goal for goal in PeriodGoal.objects.filter(user=user, period=rule.period,
                 date__range=(target, stop)).select_related("reservation")}
        while target <= stop and target.year <= 2100:
            start, end = proposed(rule, target, prefs)
            if first <= start.astimezone(ZoneInfo(prefs.timezone)).date() <= last and start >= now:
                goal = goals.get(target)
                if goal is None:
                    goal = PeriodGoal.objects.create(user=user, period=rule.period, date=target)
                existing = getattr(goal, "reservation", None)
                if not goal.reservation_skipped and not goal.reservation_needs_choice and not goal.text.strip() and not (existing and not existing.deleted):
                    try:
                        book(goal, prefs, start, end, auto=True)
                    except (Conflict, ValueError):
                        goal.reservation_needs_choice = True
                        goal.save(update_fields=["reservation_needs_choice"])
            target = next_period(rule.period, target)


def goal_value(user, period, day):
    day = period_date(period, day)
    goal = PeriodGoal.objects.filter(user=user, period=period, date=day).first()
    return {"period": period, "date": day.isoformat(), "text": goal.text if goal else ""}


def context(user, period, day):
    last = next_period(period, day) - timedelta(days=1)
    levels = ["month", "quarter"] if period == "week" else ["quarter"] if period == "month" else []
    result = []
    for larger in levels:
        cursor = period_date(larger, day)
        while cursor <= last:
            result.append(goal_value(user, larger, cursor))
            cursor = next_period(larger, cursor)
    return result


def goal_detail(user, prefs, now, period, day):
    if period not in (*PERIODS, "day"):
        raise ValueError("Choose week, month, or quarter goals.")
    day = period_date(period, day)
    result = goal_value(user, period, day)
    result["context"] = context(user, period, day)
    result["previous"] = goal_value(user, period, next_period(period, day, -1))
    rule = rule_for(user, period)
    result["minutes"] = prefs.daily_review_minutes if period == "day" else rule.minutes
    goal = PeriodGoal.objects.filter(user=user, period=period, date=day).first()
    block = Block.objects.filter(goal_plan=goal, deleted=False).first() if goal else None
    result["reservation"] = serialize_block(block, prefs) if block else None
    if block:
        result["reservation"]["tracked"] = block.session_set.exclude(status="cancelled").exists()
    result["reservation_conflict"] = "Choose a time for the daily review; its automatic slot is occupied." if period == "day" and goal and goal.reservation_needs_choice else ""
    if rule.enabled and not block and not (goal and goal.reservation_skipped):
        start, end = proposed(rule, day, prefs)
        result["suggested_date"] = start.astimezone(ZoneInfo(prefs.timezone)).date().isoformat()
        result["suggested_start"] = start.astimezone(ZoneInfo(prefs.timezone)).strftime("%H:%M")
        if goal and goal.reservation_needs_choice:
            result["reservation_conflict"] = "The automatic planning reservation conflicted. Choose a time to reserve it."
        elif start < now:
            result["reservation_conflict"] = "The suggested planning time has passed. Choose a time if you want a planning pomo."
        else:
            try:
                reservation_room(user, prefs, start, end)
            except (Conflict, ValueError) as error:
                result["reservation_conflict"] = f"Planning time is occupied. {error}"
    return result


def snapshot(user, prefs, now):
    today = local_day(prefs, now)
    pending = []
    for period in PERIODS:
        current = period_date(period, today)
        if not goal_value(user, period, current)["text"].strip():
            pending.append({"period": period, "date": current.isoformat()})
        rule = rule_for(user, period)
        following = next_period(period, current)
        if rule.enabled and proposed(rule, following, prefs)[0] <= now and not goal_value(user, period, following)["text"].strip():
            pending.append({"period": period, "date": following.isoformat()})
    from . import reviews
    return {"pending": pending, "reviews": reviews.pending(user, prefs, now, pending), "weekly": goal_value(user, "week", today)}
