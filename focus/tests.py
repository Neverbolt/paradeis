import json
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import Client, TestCase, override_settings

from .models import Block, Session, Task
from .services import block_bounds, instant, plan, preferences

NOW = datetime(2026, 10, 7, 7, 0, tzinfo=timezone.utc)  # 09:00 Brussels


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class AppTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("alice", password="a-test-password")
        self.other = get_user_model().objects.create_user("bob", password="another-password")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.task = Task.objects.create(user=self.user, title="Write the proposal")
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def post(self, path, data, at=NOW):
        with patch("focus.views.timezone.now", return_value=at):
            return self.client.post(path, json.dumps(data), content_type="application/json")

    def start(self, at=NOW, **kwargs):
        response = self.post("/api/timer/", {"action": "start", **kwargs}, at)
        self.assertEqual(response.status_code, 201, response.content)
        return Session.objects.get(id=response.json()["id"])

    def finish(self, session, at=NOW + timedelta(minutes=25)):
        return self.post("/api/timer/", {"action": "finish", "id": session.id}, at)

    def block(self, kind="meeting", start=time(10), end=time(11), user=None, day=date(2026, 10, 7)):
        return Block.objects.create(
            user=user or self.user, date=day, start=start, end=end, kind=kind, title="Design review"
        )

    def test_authenticated_shell_and_security_headers(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "A little room to focus")
        self.assertIn("script-src 'self'", response["Content-Security-Policy"])
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response["X-Frame-Options"], "DENY")
        self.client.logout()
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.get("/api/state/").status_code, 401)

    def test_new_user_defaults_work_without_existing_preferences(self):
        self.client.force_login(self.other)
        response = self.client.get("/api/state/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["preferences"]["day_start"], "09:00")

    def test_timer_persists_default_task_and_prevents_duplicates(self):
        session = self.start()
        self.assertEqual(session.allocations.get().task, self.task)
        self.assertEqual(session.deadline, NOW + timedelta(minutes=25))
        self.assertEqual(self.post("/api/timer/", {"action": "start"}).status_code, 409)
        self.assertEqual(self.client.get("/api/state/").json()["active"]["id"], session.id)

    def test_pause_resume_excludes_paused_time(self):
        session = self.start()
        paused = NOW + timedelta(minutes=10)
        self.assertEqual(
            self.post("/api/timer/", {"action": "pause", "id": session.id}, paused).status_code, 200
        )
        resumed = paused + timedelta(minutes=10)
        self.assertEqual(
            self.post("/api/timer/", {"action": "resume", "id": session.id}, resumed).status_code,
            200,
        )
        session.refresh_from_db()
        self.assertEqual(session.deadline, NOW + timedelta(minutes=35))
        self.finish(session, NOW + timedelta(minutes=30))
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 20 * 60)
        self.assertEqual(session.status, "completed")

    def test_late_refresh_completes_at_deadline_without_inventing_sessions(self):
        session = self.start()
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(hours=8)):
            state = self.client.get("/api/state/").json()
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 1500)
        self.assertEqual(session.ended_at, NOW + timedelta(minutes=25))
        self.assertIsNone(state["active"])
        self.assertIsNone(state["break_until"])
        self.assertEqual(Session.objects.count(), 1)

    def test_completion_at_deadline_and_repeated_finish_are_idempotent(self):
        session = self.start()
        self.assertEqual(self.finish(session).status_code, 200)
        self.assertEqual(self.finish(session).status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.status, "completed")
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=26)):
            self.client.get("/api/state/")
            self.client.get("/api/state/")
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 1500)

    def test_finish_early_records_only_worked_seconds_and_starts_break(self):
        session = self.start()
        self.finish(session, NOW + timedelta(minutes=7))
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 420)
        self.assertEqual(session.break_until, NOW + timedelta(minutes=12))

    def test_cancel_does_not_count_as_effort_or_time(self):
        session = self.start()
        self.post("/api/timer/", {"action": "cancel", "id": session.id})
        state = self.client.get("/api/state/").json()
        self.assertEqual(state["day"]["summary"]["count"], 0)
        self.assertEqual(state["day"]["sessions"], [])

    def test_reservations_prevent_start_and_resume_overlaps(self):
        self.block(start=time(9, 15), end=time(10))
        self.assertEqual(self.post("/api/timer/", {"action": "start"}).status_code, 409)
        Block.objects.all().delete()
        session = self.start()
        self.post("/api/timer/", {"action": "pause", "id": session.id}, NOW + timedelta(minutes=5))
        self.block(start=time(9, 40), end=time(10))
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "resume", "id": session.id}, NOW + timedelta(minutes=30)
            ).status_code,
            409,
        )

    def test_meeting_is_one_session_and_cannot_be_started_early_or_twice(self):
        block = self.block(start=time(9, 30), end=time(11))
        self.assertEqual(
            self.post("/api/timer/", {"action": "start", "block_id": block.id}).status_code, 409
        )
        session = self.start(NOW + timedelta(minutes=40), block_id=block.id)
        self.assertEqual(session.planned_seconds, 80 * 60)
        self.assertEqual(session.kind, "meeting")
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "pause", "id": session.id}, NOW + timedelta(minutes=45)
            ).status_code,
            409,
        )
        self.finish(session, NOW + timedelta(minutes=50))
        self.assertEqual(
            self.post(
                "/api/timer/",
                {"action": "start", "block_id": block.id},
                NOW + timedelta(minutes=55),
            ).status_code,
            409,
        )
        self.assertEqual(
            self.post(f"/api/blocks/{block.id}/", {"action": "delete"}).status_code, 409
        )

    def test_review_supports_multiple_tasks_and_counts_effort_once(self):
        second = Task.objects.create(user=self.user, title="Answer mail")
        session = self.start()
        self.finish(session, NOW + timedelta(minutes=20))
        review = {
            "effort": 4,
            "reflection": "Good progress",
            "allocations": [
                {"task_id": self.task.id, "percent": 70},
                {"task_id": second.id, "percent": 30},
            ],
        }
        response = self.post(f"/api/sessions/{session.id}/review/", review)
        self.assertEqual(response.status_code, 200, response.content)
        state = self.client.get("/api/state/").json()
        self.assertEqual(state["day"]["summary"]["effort"], 4)
        self.assertEqual(len(state["day"]["sessions"][0]["allocations"]), 2)
        review["allocations"][0]["percent"] = 60
        self.assertEqual(self.post(f"/api/sessions/{session.id}/review/", review).status_code, 400)
        self.assertEqual(list(session.allocations.values_list("percent", flat=True)), [70, 30])

    def test_task_snapshots_survive_rename_archive_and_reorder(self):
        second = Task.objects.create(user=self.user, title="Second", position=1)
        self.post(f"/api/tasks/{second.id}/", {"action": "first"})
        session = self.start()
        self.assertEqual(session.title, "Second")
        self.post(f"/api/tasks/{second.id}/", {"action": "rename", "title": "Renamed"})
        self.post(f"/api/tasks/{second.id}/", {"action": "archive"})
        self.assertEqual(session.allocations.get().label, "Second")

    def test_cross_user_objects_are_inaccessible(self):
        foreign_task = Task.objects.create(user=self.other, title="Private")
        foreign_block = self.block(user=self.other)
        self.assertEqual(
            self.post(f"/api/tasks/{foreign_task.id}/", {"action": "toggle"}).status_code, 404
        )
        self.assertEqual(
            self.post(f"/api/blocks/{foreign_block.id}/", {"action": "delete"}).status_code, 404
        )
        self.assertEqual(
            self.post("/api/timer/", {"action": "start", "block_id": foreign_block.id}).status_code,
            404,
        )
        session = self.start()
        self.finish(session, NOW + timedelta(minutes=5))
        self.assertEqual(
            self.post(
                f"/api/sessions/{session.id}/review/",
                {"effort": 1, "allocations": [{"task_id": foreign_task.id, "percent": 100}]},
            ).status_code,
            404,
        )
        self.client.force_login(self.other)
        self.assertEqual(
            self.post(f"/api/sessions/{session.id}/review/", {"effort": 1}).status_code, 404
        )
        state = self.client.get("/api/state/").json()
        self.assertEqual(state["day"]["sessions"], [])
        self.assertNotIn(self.task.id, [t["id"] for t in state["tasks"]])

    def test_notes_normalize_week_and_month_and_are_private(self):
        for period, expected in [
            ("day", "2026-10-07"),
            ("week", "2026-10-05"),
            ("month", "2026-10-01"),
        ]:
            response = self.post(
                "/api/notes/", {"period": period, "date": "2026-10-07", "text": "Reflection"}
            )
            self.assertEqual(response.json()["date"], expected)
        self.client.force_login(self.other)
        self.assertEqual(
            self.client.get("/api/notes/?period=week&date=2026-10-08").json()["text"], ""
        )

    def test_history_is_bounded_to_seven_days(self):
        for day in [date(2026, 9, 1), date(2026, 10, 7), date(2026, 11, 1)]:
            self.block(day=day)
        response = self.client.get("/api/history/?start=2026-10-05").json()
        self.assertEqual(len(response["days"]), 7)
        self.assertEqual(sum(len(d["blocks"]) for d in response["days"]), 1)
        self.assertEqual(response["previous"], "2026-09-28")

    def test_schedule_fits_full_pomos_around_meeting_and_lunch(self):
        meeting = self.block(start=time(10), end=time(11))
        lunch = self.block(kind="break", start=time(12), end=time(13))
        result = plan(date(2026, 10, 7), self.prefs, [meeting, lunch], [], NOW)
        for slot in result:
            start, end = datetime.fromisoformat(slot["start"]), datetime.fromisoformat(slot["end"])
            for block in [meeting, lunch]:
                bs, be = block_bounds(block, self.prefs)
                self.assertFalse(start < be and end > bs)
            if slot["kind"] == "focus":
                self.assertEqual(end - start, timedelta(minutes=25))
        self.assertEqual(plan(date(2026, 10, 6), self.prefs, [], [], NOW), [])

    def test_block_validation_and_active_session_collision(self):
        data = {
            "date": "2026-10-07",
            "start": "10:00",
            "end": "11:00",
            "kind": "meeting",
            "title": "Call",
        }
        self.assertEqual(self.post("/api/blocks/", data).status_code, 200)
        self.assertEqual(self.post("/api/blocks/", data).status_code, 409)
        data["end"] = "09:00"
        self.assertEqual(self.post("/api/blocks/", data).status_code, 400)
        self.start()
        data.update(start="09:10", end="09:30")
        self.assertEqual(self.post("/api/blocks/", data).status_code, 409)

    def test_dst_nonexistent_and_ambiguous_times_are_rejected(self):
        for day in [date(2026, 3, 29), date(2026, 10, 25)]:
            with self.assertRaises(ValueError):
                instant(day, time(2, 30), self.prefs)
        self.assertEqual(instant(date(2026, 10, 25), time(9), self.prefs).hour, 8)

    def test_zero_effort_is_distinct_from_unrated(self):
        session = self.start()
        self.finish(session, NOW + timedelta(minutes=1))
        self.post(
            f"/api/sessions/{session.id}/review/",
            {"effort": 0, "allocations": [{"percent": 100, "label": "Thinking"}]},
        )
        summary = self.client.get("/api/state/").json()["day"]["summary"]
        self.assertEqual(summary["effort"], 0)
        self.assertEqual(summary["unrated"], 0)

    def test_settings_validation(self):
        data = {
            "timezone": "Europe/Brussels",
            "day_start": "09:00",
            "day_end": "17:00",
            "focus_minutes": 25,
            "short_break": 5,
            "long_break": 15,
            "long_every": 4,
        }
        self.assertEqual(self.post("/api/settings/", data).status_code, 200)
        for field, value in [
            ("timezone", "Neverland/Nowhere"),
            ("focus_minutes", 0),
            ("long_every", True),
            ("day_end", "08:00"),
        ]:
            self.assertEqual(self.post("/api/settings/", {**data, field: value}).status_code, 400)

    def test_csrf_is_required_and_logout_is_post_only(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.assertEqual(
            client.post(
                "/api/tasks/", json.dumps({"title": "Fail"}), content_type="application/json"
            ).status_code,
            403,
        )
        client.get("/")
        token = client.cookies["csrftoken"].value
        self.assertEqual(
            client.post(
                "/api/tasks/",
                json.dumps({"title": "Safe"}),
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
            ).status_code,
            201,
        )
        self.assertEqual(client.get("/logout/").status_code, 405)

    def test_login_rate_limit(self):
        self.client.logout()
        for _ in range(10):
            response = self.client.post("/login/", {"username": "alice", "password": "wrong"})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.client.post("/login/", {"username": "alice", "password": "wrong"}).status_code, 429
        )
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=16)):
            self.assertEqual(
                self.client.post(
                    "/login/", {"username": "alice", "password": "a-test-password"}
                ).status_code,
                302,
            )

    def test_database_enforces_one_active_timer(self):
        session = self.start()
        with self.assertRaises(IntegrityError), transaction.atomic():
            Session.objects.create(
                user=self.user,
                date=session.date,
                started_at=NOW,
                deadline=session.deadline,
                resumed_at=NOW,
                remaining_seconds=1500,
                planned_seconds=1500,
            )

    def test_fourth_pomo_gets_long_break(self):
        for i in range(4):
            start = NOW + timedelta(minutes=i * 30)
            session = self.start(start)
            with patch("focus.views.timezone.now", return_value=start + timedelta(minutes=25)):
                self.client.get("/api/state/")
        session.refresh_from_db()
        self.assertEqual(session.break_until - session.ended_at, timedelta(minutes=15))
