from datetime import time

from django.conf import settings
from django.db import models
from django.db.models import Q


class Preferences(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    timezone = models.CharField(max_length=64, default="Europe/Brussels")
    day_start = models.TimeField(default=time(9, 0))
    day_end = models.TimeField(default=time(17, 0))
    focus_minutes = models.PositiveSmallIntegerField(default=25)
    short_break = models.PositiveSmallIntegerField(default=5)
    long_break = models.PositiveSmallIntegerField(default=15)
    long_every = models.PositiveSmallIntegerField(default=4)
    next_focus_seconds = models.PositiveIntegerField(null=True, blank=True)
    frozen_through = models.DateField(null=True, blank=True)


class BlockTemplate(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    kind = models.CharField(max_length=8, choices=[("meeting", "Meeting"), ("break", "Break")])
    timezone = models.CharField(max_length=64)
    start = models.TimeField()
    end = models.TimeField()
    weekday = models.PositiveSmallIntegerField()
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
    archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]
        indexes = [models.Index(fields=["user", "archived", "position"])]


class Block(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    date = models.DateField()
    timezone = models.CharField(max_length=64, default="Europe/Brussels")
    start = models.TimeField()
    end = models.TimeField()
    kind = models.CharField(max_length=8, choices=[("meeting", "Meeting"), ("break", "Break")])
    title = models.CharField(max_length=200)
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
    reflection = models.TextField(blank=True, max_length=2000)
    reviewed = models.BooleanField(default=False)

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
        ]


class Allocation(models.Model):
    session = models.ForeignKey(Session, related_name="allocations", on_delete=models.CASCADE)
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL)
    label = models.CharField(max_length=200)  # Snapshot keeps history meaningful after task edits.
    sand = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(condition=Q(sand__lte=5), name="allocation_sand_range")
        ]


class Note(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    period = models.CharField(
        max_length=5, choices=[("day", "Day"), ("week", "Week"), ("month", "Month")]
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
