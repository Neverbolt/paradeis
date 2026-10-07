"""Lazy projections plus immutable occurrences and deletion tombstones.

Before changing a template, freeze its elapsed days. Future projections can be
rebuilt; edited/deleted occurrences retain their original occurrence key forever.
"""

import math
from datetime import timedelta

from .models import Block, BlockTemplate


def matches(template, day):
    return (
        day >= template.effective_from
        and day.weekday() == template.weekday
        and ((day - template.anchor_date).days // 7) % template.interval_weeks == 0
    )


def occurrence_days(template, first, last):
    first = max(first, template.effective_from)
    day = first + timedelta(days=(template.weekday - first.weekday()) % 7)
    offset = ((day - template.anchor_date).days // 7) % template.interval_weeks
    if offset:
        day += timedelta(weeks=template.interval_weeks - offset)
    while day <= last:
        yield day
        day += timedelta(weeks=template.interval_weeks)


def materialize(user, first, last, today):
    from types import SimpleNamespace

    from .services import block_bounds

    templates = BlockTemplate.objects.filter(user=user, active=True)
    for template in templates:
        fixed_weeks = {
            b.occurrence_date - timedelta(days=b.occurrence_date.weekday())
            for b in Block.objects.filter(
                template=template,
                fixed=True,
                occurrence_date__isnull=False,
                occurrence_date__gte=first - timedelta(days=6),
                occurrence_date__lte=last + timedelta(days=6),
            )
        }
        for day in occurrence_days(template, first, last):
            if day - timedelta(days=day.weekday()) in fixed_weeks:
                continue
            try:
                block_bounds(
                    SimpleNamespace(
                        date=day, start=template.start, end=template.end, timezone=template.timezone
                    ),
                    None,
                )
            except ValueError:
                # A weekly wall-clock reservation skips a DST-invalid occurrence.
                continue
            Block.objects.get_or_create(
                template=template,
                occurrence_date=day,
                defaults={
                    "user": user,
                    "date": day,
                    "timezone": template.timezone,
                    "start": template.start,
                    "end": template.end,
                    "title": template.title,
                    "kind": template.kind,
                    "fixed": day <= today,
                },
            )
    Block.objects.filter(user=user, date__lte=today, fixed=False).update(fixed=True)


def freeze_elapsed(user, prefs, today):
    if prefs.frozen_through is None:
        first = min(
            [today]
            + list(BlockTemplate.objects.filter(user=user).values_list("effective_from", flat=True))
        )
    else:
        first = prefs.frozen_through + timedelta(days=1)
    if first <= today:
        materialize(user, first, today, today)
        prefs.frozen_through = today
        prefs.save(update_fields=["frozen_through"])


def validate_template(template, today, ignore_block=None):
    """Catch infinite weekly pattern collisions without generating infinite days."""
    from .services import Conflict, block_bounds

    for other in BlockTemplate.objects.filter(user=template.user, active=True).exclude(
        pk=template.pk
    ):
        if (
            other.weekday != template.weekday
            or template.start >= other.end
            or template.end <= other.start
        ):
            continue
        difference = (template.anchor_date - other.anchor_date).days // 7
        if difference % math.gcd(template.interval_weeks, other.interval_weeks) == 0:
            raise Conflict(f"This schedule overlaps recurring block “{other.title}”.")
    # Fixed exceptions win. Reject a new pattern that would collide with one,
    # instead of overwriting it or silently producing overlapping reservations.
    exceptions = (
        {
            b.occurrence_date - timedelta(days=b.occurrence_date.weekday())
            for b in Block.objects.filter(
                template=template, fixed=True, occurrence_date__isnull=False
            )
        }
        if template.pk
        else set()
    )
    for block in Block.objects.filter(
        user=template.user, fixed=True, deleted=False, date__gt=today
    ).exclude(pk=ignore_block):
        if block.date - timedelta(days=block.date.weekday()) in exceptions or not matches(
            template, block.date
        ):
            continue
        from types import SimpleNamespace

        proposed = SimpleNamespace(
            date=block.date, start=template.start, end=template.end, timezone=template.timezone
        )
        try:
            start, end = block_bounds(proposed, None)
        except ValueError:
            continue
        bs, be = block_bounds(block, None)
        if start < be and end > bs:
            raise Conflict(f"This schedule overlaps fixed block “{block.title}” on {block.date}.")


def rebuild_future(template, today):
    Block.objects.filter(template=template, fixed=False, date__gt=today).delete()
