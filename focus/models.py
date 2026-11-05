from datetime import time

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone


def workdays_default():
    return [0, 1, 2, 3, 4]


def weekdays_default():
    return list(range(7))


class Preferences(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    timezone = models.CharField(max_length=64, default="Europe/Brussels")
    day_rollover = models.TimeField(default=time(0, 0))
    day_start = models.TimeField(default=time(9, 0))
    day_end = models.TimeField(default=time(17, 0))
    focus_minutes = models.PositiveSmallIntegerField(default=25)
    short_break = models.PositiveSmallIntegerField(default=5)
    long_break = models.PositiveSmallIntegerField(default=15)
    long_every = models.PositiveSmallIntegerField(default=4)
    next_focus_seconds = models.PositiveIntegerField(null=True, blank=True)
    frozen_through = models.DateField(null=True, blank=True)
    auto_focus = models.BooleanField(default=False)
    auto_break = models.BooleanField(default=True)
    auto_armed = models.BooleanField(default=False)
    planning_workdays = models.JSONField(default=workdays_default)


class BlockTemplate(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    kind = models.CharField(max_length=8, choices=[("meeting", "Meeting"), ("work", "Work"), ("break", "Break")])
    timezone = models.CharField(max_length=64)
    start = models.TimeField()
    end = models.TimeField()
    weekday = models.PositiveSmallIntegerField()
    weekdays = models.JSONField(default=weekdays_default)
    frequency = models.CharField(
        max_length=6, choices=[("daily", "Daily"), ("weekly", "Weekly")], default="weekly"
    )
    interval_weeks = models.PositiveSmallIntegerField(default=1)
    anchor_date = models.DateField()
    effective_from = models.DateField()
    active = models.BooleanField(default=True)

    class Meta:
        indexes = [models.Index(fields=["user", "active"])]
        constraints = [
            models.CheckConstraint(
                condition=Q(end__gt=models.F("start")), name="template_positive_length"
            ),
            models.CheckConstraint(
                condition=Q(frequency__in=["daily", "weekly"]), name="template_frequency"
            ),
            models.CheckConstraint(condition=Q(weekday__lte=6), name="template_weekday"),
            models.CheckConstraint(
                condition=Q(interval_weeks__gte=1) & Q(interval_weeks__lte=12),
                name="template_interval",
            ),
        ]


class Task(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    position = models.PositiveIntegerField(default=0)
    done = models.BooleanField(default=False)
    completed_on = models.DateField(null=True, blank=True)
    archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    goal_date = models.DateField(null=True, blank=True)
    carried_from = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL,
                                     related_name="carried_goals")

    class Meta:
        ordering = ["position", "id"]
        constraints = [models.UniqueConstraint(fields=["user", "goal_date", "carried_from"],
                                               name="one_goal_carry_per_day")]
        indexes = [models.Index(fields=["user", "goal_date"]),
                   models.Index(fields=["user", "archived", "position"]),
                   models.Index(fields=["user", "completed_on"])]


class DayPlan(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    date = models.DateField()
    started_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "date"], name="one_day_plan")]


class DayHours(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    date = models.DateField()
    start = models.TimeField()
    end = models.TimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "date"], name="one_day_hours"),
            models.CheckConstraint(condition=Q(end__gt=models.F("start")), name="day_hours_positive_length"),
        ]


class PeriodGoal(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    period = models.CharField(max_length=7, choices=[("week", "Week"), ("month", "Month"), ("quarter", "Quarter")])
    date = models.DateField()
    text = models.TextField(max_length=10000, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    reservation_skipped = models.BooleanField(default=False)
    reservation_needs_choice = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "period", "date"], name="one_period_goal")]


class PlanningRule(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    period = models.CharField(max_length=7, choices=[("week", "Week"), ("month", "Month"), ("quarter", "Quarter")])
    enabled = models.BooleanField(default=False)
    weekday = models.PositiveSmallIntegerField(default=4)
    trigger_mode = models.CharField(max_length=16, default="last_workday")
    day_of_month = models.PositiveSmallIntegerField(default=31)
    time = models.TimeField(default=time(17))
    minutes = models.PositiveSmallIntegerField(default=25)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "period"], name="one_planning_rule")]


class Block(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    date = models.DateField()
    timezone = models.CharField(max_length=64, default="Europe/Brussels")
    start = models.TimeField()
    end = models.TimeField()
    kind = models.CharField(max_length=8, choices=[("meeting", "Meeting"), ("work", "Work"), ("break", "Break"), ("planning", "Planning")])
    title = models.CharField(max_length=200)
    goal_plan = models.OneToOneField(PeriodGoal, null=True, blank=True, on_delete=models.SET_NULL, related_name="reservation")
    planning_auto = models.BooleanField(default=False)
    template = models.ForeignKey(BlockTemplate, null=True, blank=True, on_delete=models.SET_NULL)
    occurrence_date = models.DateField(null=True, blank=True)
    fixed = models.BooleanField(default=True)
    deleted = models.BooleanField(default=False)

    class Meta:
        ordering = ["date", "start"]
        indexes = [models.Index(fields=["user", "date"])]
        constraints = [
            models.UniqueConstraint(
                fields=["template", "occurrence_date"], name="unique_template_occurrence"
            ),
            models.CheckConstraint(
                condition=Q(end__gt=models.F("start")), name="block_positive_length"
            ),
        ]


class Session(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    date = models.DateField()  # Local day at start; historical grouping survives timezone changes.
    kind = models.CharField(
        max_length=8, default="focus", choices=[("focus", "Focus"), ("meeting", "Meeting")]
    )
    block = models.ForeignKey(Block, null=True, blank=True, on_delete=models.SET_NULL)
    title = models.CharField(max_length=200, default="Open focus")
    status = models.CharField(
        max_length=10,
        default="running",
        choices=[
            ("running", "Running"),
            ("paused", "Paused"),
            ("completed", "Completed"),
            ("cancelled", "Cancelled"),
        ],
    )
    started_at = models.DateTimeField()
    deadline = models.DateTimeField()
    ended_at = models.DateTimeField(null=True)
    remaining_seconds = models.PositiveIntegerField()
    planned_seconds = models.PositiveIntegerField()
    elapsed_seconds = models.PositiveIntegerField(default=0)
    resumed_at = models.DateTimeField()
    break_until = models.DateTimeField(null=True)
    effort = models.PositiveSmallIntegerField(null=True)
    focus_score = models.PositiveSmallIntegerField(null=True, blank=True)
    reflection = models.TextField(blank=True, max_length=2000)
    reviewed = models.BooleanField(default=False)
    pending_break_seconds = models.PositiveIntegerField(default=0)
    notify_live = models.BooleanField(default=True)
    topic_mode = models.CharField(max_length=8, default="queue")
    work_topic = models.CharField(max_length=200, blank=True)
    selected_task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL,
                                      related_name="selected_sessions")

    class Meta:
        ordering = ["started_at"]
        indexes = [models.Index(fields=["user", "date", "status"])]
        constraints = [
            models.UniqueConstraint(
                fields=["user"],
                condition=Q(status__in=["running", "paused"]),
                name="one_active_session",
            ),
            models.UniqueConstraint(
                fields=["block"], condition=~Q(status="cancelled"), name="one_session_per_block"
            ),
            models.CheckConstraint(
                condition=Q(effort__isnull=True) | Q(effort__lte=5), name="effort_zero_to_five"
            ),
            models.CheckConstraint(
                condition=Q(focus_score__isnull=True) | Q(focus_score__lte=3),
                name="focus_zero_to_three",
            ),
        ]


class Allocation(models.Model):
    session = models.ForeignKey(Session, related_name="allocations", on_delete=models.CASCADE)
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL)
    label = models.CharField(max_length=200)  # Snapshot keeps history meaningful after task edits.
    sand = models.PositiveSmallIntegerField(default=0)
    automatic = models.BooleanField(default=False)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(condition=Q(sand__lte=5), name="allocation_sand_range")
        ]


class Note(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    period = models.CharField(
        max_length=7, choices=[("day", "Day"), ("week", "Week"), ("month", "Month"), ("quarter", "Quarter")]
    )
    date = models.DateField()
    text = models.TextField(max_length=10000, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "period", "date"], name="unique_period_note")
        ]


class LoginAttempt(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    window_start = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)


class TaskFocusSpan(models.Model):
    session = models.ForeignKey(Session, related_name="task_spans", on_delete=models.CASCADE)
    task = models.ForeignKey(Task, null=True, on_delete=models.SET_NULL)
    label = models.CharField(max_length=200)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True)

    class Meta:
        ordering = ["started_at", "id"]
        constraints = [
            models.UniqueConstraint(fields=["session"], condition=Q(ended_at__isnull=True),
                                    name="one_open_task_span"),
        ]


class PushIdentity(models.Model):
    # One durable application-server key pair, shared by the web and push worker.
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    private_key = models.TextField()
    public_key = models.CharField(max_length=100)
    subject = models.URLField(max_length=255)
    worker_seen_at = models.DateTimeField(null=True)


class PushSubscription(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    endpoint = models.URLField(max_length=4096, unique=True)
    p256dh = models.CharField(max_length=100)
    auth = models.CharField(max_length=32)
    label = models.CharField(max_length=80, default="Companion device")
    created_at = models.DateTimeField(default=timezone.now)
    last_test_at = models.DateTimeField(null=True)


class PushDelivery(models.Model):
    subscription = models.ForeignKey(PushSubscription, on_delete=models.CASCADE)
    session = models.ForeignKey(Session, null=True, on_delete=models.CASCADE)
    key = models.CharField(max_length=150)
    kind = models.CharField(max_length=8)
    event_at = models.DateTimeField()
    title = models.CharField(max_length=80)
    body = models.CharField(max_length=250)
    next_attempt_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    finished_at = models.DateTimeField(null=True)
    outcome = models.CharField(max_length=12, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["subscription", "key"], name="one_device_push_event")]
        indexes = [models.Index(fields=["finished_at", "next_attempt_at"])]
