"""Period review context and movable end-of-day review reservations."""
from datetime import timedelta
from django.db.models.functions import Trim
from .models import Block, DayPlan, Note, PeriodGoal, Session
from . import planning
from .services import Conflict, block_bounds, local_day, workday_bounds


def note_text(user, period, day):
    return Note.objects.filter(user=user, period=period, date=day).values_list('text', flat=True).first() or ''


def has_activity(user, first, end, period=None):
    return (Session.objects.filter(user=user, date__gte=first, date__lt=end).exclude(status='cancelled').exists()
            or DayPlan.objects.filter(user=user, date__gte=first, date__lt=end).exists()
            or Note.objects.filter(user=user, date__gte=first, date__lt=end, **({'period':'day'} if period == 'day' else {})).exclude(text='').exists())


def detail(user, prefs, now, period, day):
    from .views import day_data
    day = planning.period_date(period, day)
    end = planning.next_period(period, day)
    result = {'period': period, 'date': day.isoformat(), 'text': note_text(user, period, day),
              'has_activity': has_activity(user, day, end, period), 'context': []}
    if period == 'day':
        result['timeline'] = day_data(user, prefs, day, now)
        result['timeline']['plan'] = []
        result['reservation'] = planning.goal_detail(user, prefs, now, 'day', day)
    else:
        child = {'week': 'day', 'month': 'week', 'quarter': 'month'}[period]
        cursor = planning.period_date(child, day)
        # Boundary weeks appear in each intersecting month, labelled by their true start.
        while cursor < end:
            result['context'].append({'period': child, 'date': cursor.isoformat(),
                                      'text': note_text(user, child, cursor)})
            cursor = planning.next_period(child, cursor)
    return result


def previous_active_day(user, today):
    sessions = Session.objects.filter(user=user, date__lt=today).exclude(status='cancelled')
    notes = Note.objects.filter(user=user, period='day', date__lt=today).annotate(content=Trim('text')).exclude(content='')
    dates = [sessions.order_by('-date').values_list('date', flat=True).first(),
             notes.order_by('-date').values_list('date', flat=True).first()]
    return max((day for day in dates if day is not None), default=None)


def pending(user, prefs, now, goals):
    today = local_day(prefs, now)
    previous = previous_active_day(user, today)
    candidates = [('day', previous)] if previous else []
    for period in planning.PERIODS:
        candidates.append((period, planning.next_period(period, today, -1)))
    for goal in goals:
        from datetime import date
        candidates.append((goal['period'], planning.next_period(goal['period'], date.fromisoformat(goal['date']), -1)))
    result = []
    for period, day in dict.fromkeys(candidates):
        if not note_text(user, period, day).strip() and has_activity(user, day, planning.next_period(period, day), period):
            result.append({'period': period, 'date': day.isoformat()})
    return result


def ensure_daily(user, prefs, now, day=None):
    day = day or local_day(prefs, now)
    if day < local_day(prefs, now):
        return
    goal = PeriodGoal.objects.filter(user=user, period='day', date=day).first()
    block = Block.objects.filter(goal_plan=goal).first() if goal else None
    if block and (not block.planning_auto or block.session_set.exclude(status='cancelled').exists()):
        return
    if not prefs.daily_review_enabled:
        if block and block_bounds(block, prefs)[1] > now:
            block.deleted = True
            block.save(update_fields=['deleted'])
        return
    if goal and goal.reservation_skipped:
        return
    beginning, end = workday_bounds(day, prefs)
    start = max(beginning, end - timedelta(minutes=prefs.daily_review_minutes))
    proposal = f"{start.isoformat()}/{end.isoformat()}"
    if goal and goal.reservation_needs_choice and goal.reservation_proposal == proposal:
        return
    if block and not block.deleted and block_bounds(block, prefs) == (start, end):
        return
    if start <= now:
        if block and not block.deleted and block_bounds(block, prefs)[1] > now:
            block.deleted = True
            block.save(update_fields=["deleted"])
        return
    goal = goal or PeriodGoal.objects.create(user=user, period='day', date=day)
    try:
        planning.book(goal, prefs, start, end, auto=True)
        goal.reservation_needs_choice = False
    except (Conflict, ValueError):
        goal.reservation_needs_choice = True
        if block and not block.deleted:
            block.deleted = True
            block.save(update_fields=['deleted'])
    goal.reservation_proposal = proposal
    goal.save(update_fields=['reservation_needs_choice', 'reservation_proposal'])
