import hashlib
import json
from datetime import date, time, timedelta
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView
from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.http import require_GET

from .models import Allocation, Block, BlockTemplate, LoginAttempt, Note, Session, Task
from .recurrence import freeze_elapsed, materialize, rebuild_future, validate_template
from .services import (
    Conflict,
    block_bounds,
    check_room,
    complete,
    instant,
    local_day,
    next_focus,
    plan,
    preferences,
    resize_session,
    serialize_block,
    serialize_session,
    settle,
    start_session,
    summary,
)


def api(methods):
    def decorate(fn):
        @wraps(fn)
        def wrapped(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return JsonResponse(
                    {"error": "Your session has expired. Please sign in again."}, status=401
                )
            if request.method not in methods:
                return JsonResponse({"error": "Method not allowed."}, status=405)
            try:
                data = json.loads(request.body or b"{}") if request.method != "GET" else {}
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object.")
                with transaction.atomic():
                    prefs = preferences(request.user)
                    now = timezone.now()
                    today = local_day(prefs, now)
                    freeze_elapsed(request.user, prefs, today)
                    materialize(request.user, today, today + timedelta(days=1), today)
                    active = settle(request.user, prefs, now)
                    return fn(request, data, prefs, now, active, *args, **kwargs)
            except Conflict as error:
                return JsonResponse({"error": str(error)}, status=409)
            except (ValueError, TypeError, KeyError, ZoneInfoNotFoundError) as error:
                return JsonResponse({"error": str(error) or "Invalid input."}, status=400)
            except (
                Task.DoesNotExist,
                Session.DoesNotExist,
                Block.DoesNotExist,
                BlockTemplate.DoesNotExist,
            ):
                return JsonResponse({"error": "Item not found."}, status=404)
            except IntegrityError:
                return JsonResponse(
                    {"error": "This changed in another tab. Refresh and try again."}, status=409
                )

        return wrapped

    return decorate


def text(data, key, limit, default=""):
    value = data.get(key, default)
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{key} must be text, at most {limit} characters.")
    return value.strip()


def integer(data, key, minimum, maximum):
    value = data.get(key)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be a whole number from {minimum} to {maximum}.")
    return value


def parse_day(value):
    day = date.fromisoformat(value)
    if not date(1970, 1, 1) <= day <= date(2100, 12, 31):
        raise ValueError("Choose a date between 1970 and 2100.")
    return day


def clock(value):
    parsed = time.fromisoformat(value)
    if parsed.tzinfo or parsed.second or parsed.microsecond:
        raise ValueError("Use a local time in HH:MM format.")
    return parsed


def period_date(period, day):
    if period == "day":
        return day
    if period == "week":
        return day - timedelta(days=day.weekday())
    if period == "month":
        return day.replace(day=1)
    raise ValueError("Choose day, week, or month.")


class ThrottledLoginView(LoginView):
    template_name = "registration/login.html"
    redirect_authenticated_user = True

    def post(self, request, *args, **kwargs):
        now = timezone.now()
        # REMOTE_ADDR is deliberately not taken from an untrusted forwarded header.
        keys = [
            ("ip:" + request.META.get("REMOTE_ADDR", ""), 30),
            ("user:" + request.POST.get("username", "").strip().casefold()[:150], 10),
        ]
        denied = False
        with transaction.atomic():
            LoginAttempt.objects.filter(window_start__lt=now - timedelta(days=1)).delete()
            for raw, limit in keys:
                key = hashlib.sha256(raw.encode()).hexdigest()
                attempt, _ = LoginAttempt.objects.get_or_create(
                    key=key, defaults={"window_start": now}
                )
                if attempt.window_start < now - timedelta(minutes=15):
                    attempt.window_start, attempt.count = now, 0
                attempt.count += 1
                attempt.save()
                denied |= attempt.count > limit
        if denied:
            response = render(
                request,
                self.template_name,
                {"form": self.get_form(), "throttled": True},
                status=429,
            )
            response["Retry-After"] = "900"
            return response
        return super().post(request, *args, **kwargs)


@login_required
@require_GET
def home(request):
    return render(request, "focus/app.html")


@require_GET
def health(request):
    return HttpResponse("ok", content_type="text/plain")


@require_GET
def service_worker(request):
    response = HttpResponse(
        (Path(settings.BASE_DIR) / "static" / "sw.js").read_text(),
        content_type="application/javascript",
    )
    response["Cache-Control"] = "no-cache"
    return response


def day_data(user, prefs, day, now, sessions=None, blocks=None):
    sessions = (
        list(
            Session.objects.filter(user=user, date=day)
            .exclude(status="cancelled")
            .prefetch_related("allocations")
        )
        if sessions is None
        else sessions
    )
    if blocks is None:
        materialize(user, day, day, local_day(prefs, now))
        blocks = list(Block.objects.filter(user=user, date=day, deleted=False))
    return {
        "date": day.isoformat(),
        "sessions": [serialize_session(s, now) for s in sessions],
        "blocks": [serialize_block(b, prefs) for b in blocks],
        "plan": plan(day, prefs, blocks, sessions, now),
        "summary": summary(sessions),
    }


@api(["GET"])
def state(request, data, prefs, now, active):
    day = parse_day(request.GET.get("date", local_day(prefs, now).isoformat()))
    rest = (
        Session.objects.filter(user=request.user, status="completed", break_until__gt=now)
        .order_by("-ended_at")
        .first()
    )
    pending = (
        Session.objects.filter(user=request.user, status="completed", reviewed=False)
        .prefetch_related("allocations")
        .order_by("-ended_at")[:10]
    )
    tasks = list(
        Task.objects.filter(user=request.user, archived=False).values(
            "id", "title", "done", "position"
        )
    )
    live_block = None
    for block in Block.objects.filter(user=request.user, date=local_day(prefs, now), deleted=False):
        start, end = block_bounds(block, prefs)
        if start <= now < end:
            live_block = serialize_block(block, prefs)
            live_block["tracked"] = block.session_set.exclude(status="cancelled").exists()
            break
    next_seconds, next_block = next_focus(request.user, prefs, now)
    latest = (
        Session.objects.filter(user=request.user, date=local_day(prefs, now), status="completed")
        .prefetch_related("allocations")
        .order_by("-ended_at")
        .first()
    )
    return JsonResponse(
        {
            "now": now.isoformat(),
            "today": local_day(prefs, now).isoformat(),
            "preferences": {
                "timezone": prefs.timezone,
                "day_start": str(prefs.day_start)[:5],
                "day_end": str(prefs.day_end)[:5],
                "focus_minutes": prefs.focus_minutes,
                "short_break": prefs.short_break,
                "long_break": prefs.long_break,
                "long_every": prefs.long_every,
            },
            "tasks": tasks,
            "live_block": live_block,
            "next_seconds": next_seconds,
            "next_requested": prefs.next_focus_seconds or prefs.focus_minutes * 60,
            "next_block": serialize_block(next_block, prefs) if next_block else None,
            "last_completed": serialize_session(latest, now) if latest else None,
            "active": serialize_session(active, now) if active else None,
            "break_until": rest.break_until.isoformat() if rest else None,
            "pending": [serialize_session(s, now) for s in pending],
            "day": day_data(request.user, prefs, day, now),
        }
    )


@api(["GET"])
def history(request, data, prefs, now, active):
    start = parse_day(request.GET.get("start", local_day(prefs, now).isoformat()))
    end = parse_day(request.GET["end"]) if "end" in request.GET else start + timedelta(days=6)
    if not 0 <= (end - start).days <= 111:
        raise ValueError("Load at most 112 days at a time.")
    materialize(request.user, start, end, local_day(prefs, now))
    sessions = list(
        Session.objects.filter(user=request.user, date__range=(start, end))
        .exclude(status="cancelled")
        .prefetch_related("allocations")
    )
    blocks = list(Block.objects.filter(user=request.user, date__range=(start, end), deleted=False))
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    note_rows = list(
        Note.objects.filter(user=request.user, date__range=(start.replace(day=1), end))
    )
    period_summaries = {}
    for session in sessions:
        for period in ["week", "month"]:
            key = f"{period}:{period_date(period, session.date)}"
            period_summaries.setdefault(key, []).append(session)
    return JsonResponse(
        {
            "days": [
                day_data(
                    request.user,
                    prefs,
                    day,
                    now,
                    [s for s in sessions if s.date == day],
                    [b for b in blocks if b.date == day],
                )
                for day in days
            ],
            "summary": summary(sessions),
            "notes": {f"{n.period}:{n.date}": n.text for n in note_rows},
            "period_summaries": {key: summary(rows) for key, rows in period_summaries.items()},
            "previous": (start - timedelta(days=7)).isoformat(),
            "next": (end + timedelta(days=1)).isoformat(),
        }
    )


@api(["POST"])
def task_create(request, data, prefs, now, active):
    title = text(data, "title", 200)
    if not title:
        raise ValueError("Give your task a name.")
    if Task.objects.filter(user=request.user, archived=False).count() >= 200:
        raise ValueError("Archive completed tasks before adding more (200 active tasks maximum).")
    last = Task.objects.filter(user=request.user).aggregate(last=Max("position"))["last"] or 0
    task = Task.objects.create(user=request.user, title=title, position=last + 1)
    return JsonResponse({"id": task.id}, status=201)


@api(["POST"])
def task_update(request, data, prefs, now, active, pk):
    task = Task.objects.get(id=pk, user=request.user)
    action = data.get("action")
    if action == "rename":
        task.title = text(data, "title", 200)
        if not task.title:
            raise ValueError("Give your task a name.")
    elif action == "toggle":
        task.done = not task.done
    elif action == "archive":
        task.archived = True
    elif action == "first":
        others = Task.objects.filter(user=request.user, archived=False).exclude(id=pk)
        from django.db.models import F

        others.update(position=F("position") + 1)
        task.position = 0
    else:
        raise ValueError("Unknown task action.")
    task.save()
    return JsonResponse({"ok": True})


@api(["POST"])
def timer(request, data, prefs, now, active):
    action = data.get("action")
    if action == "set_next":
        prefs.next_focus_seconds = integer(data, "seconds", 1, 7200)
        prefs.save(update_fields=["next_focus_seconds"])
        return JsonResponse({"ok": True})
    if action == "start":
        block_id = data.get("block_id")
        if block_id is not None:
            block_id = integer(data, "block_id", 1, 2**53 - 1)
        if type(data.get("ignore_break", False)) is not bool:
            raise ValueError("Invalid break option.")
        session = start_session(request.user, prefs, now, block_id, data.get("ignore_break", False))
        return JsonResponse({"id": session.id}, status=201)
    if action == "skip_break":
        Session.objects.filter(user=request.user, break_until__gt=now).update(break_until=now)
        return JsonResponse({"ok": True})
    if action in ["resize", "overrun"]:
        pk = integer(data, "id", 1, 2**53 - 1)
        session = Session.objects.get(user=request.user, id=pk)
        if active and active.id != pk:
            raise Conflict("A different timer is active.")
        if session.status not in ["running", "paused", "completed"]:
            raise Conflict("This timer cannot be extended.")
        if action == "overrun":
            remaining = (
                max(0, int((session.deadline - now).total_seconds()))
                if session.status == "running"
                else session.remaining_seconds
            )
            seconds = remaining + 300
        else:
            seconds = integer(data, "seconds", 1, 43200)
        resize_session(session, request.user, prefs, now, seconds, action == "overrun")
        return JsonResponse({"ok": True})
    if (
        not active
        and action == "finish"
        and Session.objects.filter(
            user=request.user, id=data.get("id"), status="completed"
        ).exists()
    ):
        return JsonResponse({"ok": True})
    if not active or data.get("id") != active.id:
        raise Conflict("The timer changed. Refresh and try again.")
    if action == "pause":
        if active.kind == "meeting":
            raise Conflict("Meetings run until their scheduled end. Finish early if you leave.")
        if active.status != "running":
            raise Conflict("This timer is already paused.")
        elapsed = min(
            active.remaining_seconds, max(0, int((now - active.resumed_at).total_seconds()))
        )
        active.remaining_seconds -= elapsed
        active.elapsed_seconds += elapsed
        active.status = "paused"
    elif action == "resume":
        if active.status != "paused":
            raise Conflict("This timer is already running.")
        active.deadline = now + timedelta(seconds=active.remaining_seconds)
        check_room(request.user, prefs, now, active.deadline)
        active.resumed_at = now
        active.status = "running"
    elif action == "finish":
        complete(active, prefs, now)
    elif action == "cancel":
        active.status = "cancelled"
        active.ended_at = now
    else:
        raise ValueError("Unknown timer action.")
    active.save()
    return JsonResponse({"ok": True})


@api(["POST"])
def review(request, data, prefs, now, active, pk):
    session = Session.objects.get(id=pk, user=request.user, status="completed")
    reflection = text(data, "reflection", 2000)
    splits = data.get("allocations")
    if not isinstance(splits, list) or not 1 <= len(splits) <= 10:
        raise ValueError("Add between one and ten tasks.")
    allocations = []
    for split in splits:
        if not isinstance(split, dict):
            raise ValueError("Invalid task allocation.")
        sand = integer(split, "sand", 0, 5)
        task = (
            Task.objects.get(user=request.user, id=integer(split, "task_id", 1, 2**53 - 1))
            if split.get("task_id") is not None
            else None
        )
        label = text(split, "label", 200)
        if not label:
            label = task.title if task else "Open focus"
        allocations.append(Allocation(session=session, task=task, label=label, sand=sand))
    effort = sum(a.sand for a in allocations)
    if effort > 5:
        raise ValueError("Use up to five sand in total.")
    session.allocations.all().delete()
    Allocation.objects.bulk_create(allocations)
    session.effort, session.reflection, session.reviewed = effort, reflection, True
    session.title = " + ".join(a.label for a in allocations)[:200]
    session.save()
    return JsonResponse({"ok": True})


@api(["POST"])
def block_save(request, data, prefs, now, active, pk=None):
    block = (
        Block.objects.get(id=pk, user=request.user, deleted=False)
        if pk
        else Block(user=request.user)
    )
    if pk and block.session_set.exclude(status="cancelled").exists():
        raise Conflict("A tracked meeting cannot be rescheduled or deleted.")
    if data.get("action") == "delete":
        if not pk:
            raise ValueError("Choose a block to delete.")
        if block.template_id:
            block.deleted, block.fixed = True, True
            block.save(update_fields=["deleted", "fixed"])
        else:
            block.delete()
        return JsonResponse({"ok": True})
    block.date = parse_day(data["date"])
    block.timezone = prefs.timezone
    block.start, block.end = clock(data["start"]), clock(data["end"])
    block.kind = data.get("kind")
    block.title = text(data, "title", 200)
    block.fixed = True
    if block.kind not in ["meeting", "break"] or not block.title:
        raise ValueError("Choose a meeting or break and give it a name.")
    if block.start >= block.end:
        raise ValueError("End time must be later than start time on the same day.")
    start, end = block_bounds(block, prefs)
    if end - start > timedelta(hours=12):
        raise ValueError("Blocks can be at most 12 hours long.")
    materialize(request.user, block.date, block.date, local_day(prefs, now))
    check_room(request.user, prefs, start, end, pk)
    sessions = (
        Session.objects.filter(user=request.user)
        .exclude(status="cancelled")
        .filter(started_at__lt=end)
    )
    for session in sessions.filter(
        Q(status__in=["running", "paused"])
        | Q(date__gte=block.date - timedelta(days=1), date__lte=block.date)
    ):
        session_end = session.ended_at or (
            now + timedelta(seconds=session.remaining_seconds)
            if session.status == "paused"
            else session.deadline
        )
        if session_end > start:
            raise Conflict("This block overlaps a tracked or active session.")
    block.save()
    if data.get("repeat") and not pk:
        repeat = data["repeat"]
        if not isinstance(repeat, dict):
            raise ValueError("Invalid repeat schedule.")
        template = BlockTemplate(
            user=request.user,
            title=block.title,
            kind=block.kind,
            timezone=block.timezone,
            start=block.start,
            end=block.end,
            weekday=block.date.weekday(),
            interval_weeks=integer(repeat, "interval_weeks", 1, 12),
            anchor_date=block.date,
            effective_from=max(block.date, local_day(prefs, now) + timedelta(days=1)),
        )
        validate_template(template, local_day(prefs, now), block.id)
        template.save()
        block.template, block.occurrence_date = template, block.date
        block.fixed = block.date <= local_day(prefs, now)
        block.save()
    return JsonResponse({"id": block.id})


@api(["GET", "POST"])
def recurrences(request, data, prefs, now, active, pk=None):
    today = local_day(prefs, now)
    if request.method == "POST":
        template = BlockTemplate.objects.get(user=request.user, id=pk)
        if data.get("action") == "delete":
            template.active = False
            template.save(update_fields=["active"])
            rebuild_future(template, today)
        else:
            template.title = text(data, "title", 200)
            template.kind = data["kind"]
            template.start, template.end = clock(data["start"]), clock(data["end"])
            template.weekday = integer(data, "weekday", 0, 6)
            template.interval_weeks = integer(data, "interval_weeks", 1, 12)
            template.anchor_date = parse_day(data["anchor_date"])
            template.anchor_date += timedelta(
                days=template.weekday - template.anchor_date.weekday()
            )
            template.effective_from = today + timedelta(days=1)
            if (
                not template.title
                or template.kind not in ["meeting", "break"]
                or template.start >= template.end
            ):
                raise ValueError("Choose a title, type, and valid time range.")
            if (
                instant(template.anchor_date, template.end, prefs)
                - instant(template.anchor_date, template.start, prefs)
            ).total_seconds() > 43200:
                raise ValueError("Blocks can be at most 12 hours long.")
            validate_template(template, today)
            template.save()
            rebuild_future(template, today)
    return JsonResponse(
        {
            "templates": [
                {
                    "id": t.id,
                    "title": t.title,
                    "kind": t.kind,
                    "start": str(t.start)[:5],
                    "end": str(t.end)[:5],
                    "weekday": t.weekday,
                    "interval_weeks": t.interval_weeks,
                    "anchor_date": t.anchor_date.isoformat(),
                }
                for t in BlockTemplate.objects.filter(user=request.user, active=True).order_by(
                    "weekday", "start"
                )
            ]
        }
    )


@api(["GET", "POST"])
def notes(request, data, prefs, now, active):
    source = request.GET if request.method == "GET" else data
    period = source.get("period", "day")
    day = period_date(period, parse_day(source["date"]))
    if request.method == "POST":
        value = text(data, "text", 10000)
        Note.objects.update_or_create(
            user=request.user, period=period, date=day, defaults={"text": value}
        )
    note = Note.objects.filter(user=request.user, period=period, date=day).first()
    return JsonResponse(
        {"text": note.text if note else "", "date": day.isoformat(), "period": period}
    )


@api(["POST"])
def settings_save(request, data, prefs, now, active):
    zone = text(data, "timezone", 64)
    ZoneInfo(zone)
    start, end = clock(data["day_start"]), clock(data["day_end"])
    if start >= end:
        raise ValueError("Workday end must be after its start.")
    if zone != prefs.timezone and (
        active
        or Block.objects.filter(
            user=request.user, date__gte=local_day(prefs, now), deleted=False
        ).exists()
        or BlockTemplate.objects.filter(user=request.user, active=True).exists()
    ):
        raise Conflict("Finish your timer and remove upcoming blocks before changing timezone.")
    prefs.timezone, prefs.day_start, prefs.day_end = zone, start, end
    instant(local_day(prefs, now), start, prefs)
    instant(local_day(prefs, now), end, prefs)
    for field, low, high in [
        ("focus_minutes", 5, 120),
        ("short_break", 1, 60),
        ("long_break", 1, 120),
        ("long_every", 1, 12),
    ]:
        setattr(prefs, field, integer(data, field, low, high))
    prefs.save()
    return JsonResponse({"ok": True})
