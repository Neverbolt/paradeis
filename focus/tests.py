import json
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import Client, TestCase, TransactionTestCase, override_settings

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
        self.assertContains(response, 'class="sidebar"')
        self.assertNotContains(response, "A little room to focus")
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

    def test_task_order_persists_and_sets_next_focus_task(self):
        second = Task.objects.create(user=self.user, title="Second", position=1)
        done = Task.objects.create(user=self.user, title="Done", done=True, position=8,
                                   completed_on=date(2026, 10, 7))
        ids = [second.id, self.task.id]
        response = self.post("/api/tasks/reorder/", {"ids": ids})
        self.assertEqual(response.status_code, 200, response.content)
        state = self.client.get("/api/state/").json()
        self.assertEqual([t["id"] for t in state["tasks"] if not t["done"]], ids)
        done.refresh_from_db()
        self.assertEqual(done.position, 8)
        session = self.start()
        self.assertEqual(session.allocations.get().task, second)
        self.post("/api/tasks/reorder/", {"ids": list(reversed(ids))})
        self.assertEqual(session.allocations.get().task, second)

    def test_task_reorder_rejects_stale_and_invalid_lists_atomically(self):
        second = Task.objects.create(user=self.user, title="Second", position=1)
        foreign = Task.objects.create(user=self.other, title="Private")
        done = Task.objects.create(user=self.user, title="Done", done=True)
        archived = Task.objects.create(user=self.user, title="Archived", archived=True)
        for ids in ([second.id], [second.id, second.id], [second.id, foreign.id],
                    [second.id, done.id], [second.id, archived.id]):
            with self.subTest(ids=ids):
                self.assertEqual(self.post("/api/tasks/reorder/", {"ids": ids}).status_code, 409)
                self.assertEqual(list(Task.objects.filter(user=self.user, done=False,
                    archived=False).values_list("id", flat=True)), [self.task.id, second.id])
        for ids in (None, "bad", [True, second.id], [str(self.task.id), second.id]):
            self.assertEqual(self.post("/api/tasks/reorder/", {"ids": ids}).status_code, 400)

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
        shortened = self.start()
        self.assertEqual(shortened.planned_seconds, 600)
        self.post("/api/timer/", {"action": "cancel", "id": shortened.id})
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
                {"task_id": self.task.id, "sand": 3},
                {"task_id": second.id, "sand": 1},
            ],
        }
        response = self.post(f"/api/sessions/{session.id}/review/", review)
        self.assertEqual(response.status_code, 200, response.content)
        state = self.client.get("/api/state/").json()
        self.assertEqual(state["day"]["summary"]["effort"], 4)
        self.assertEqual(len(state["day"]["sessions"][0]["allocations"]), 2)
        review["allocations"][0]["sand"] = 5
        self.assertEqual(self.post(f"/api/sessions/{session.id}/review/", review).status_code, 400)
        self.assertEqual(list(session.allocations.values_list("sand", flat=True)), [3, 1])

    def test_task_completion_stays_with_local_day_and_pending_tasks_carry_forward(self):
        pending = Task.objects.create(user=self.user, title="Tomorrow", position=1)
        late = datetime(2026, 10, 7, 21, 59, tzinfo=timezone.utc)
        self.assertEqual(self.post(f"/api/tasks/{self.task.id}/", {"action": "toggle"}, late).status_code, 200)
        self.task.refresh_from_db()
        self.assertEqual(self.task.completed_on, date(2026, 10, 7))
        with patch("focus.views.timezone.now", return_value=late + timedelta(minutes=2)):
            today = self.client.get("/api/state/").json()
            previous = self.client.get("/api/state/?date=2026-10-07").json()
        self.assertEqual(today["today"], "2026-10-08")
        self.assertEqual([t["id"] for t in today["tasks"]], [pending.id])
        self.assertEqual(previous["day"]["completed_tasks"][0]["id"], self.task.id)
        self.assertEqual(set(t["id"] for t in previous["tasks"]), {self.task.id, pending.id})
        self.assertEqual(Task.objects.filter(user=self.user).count(), 2)
        history = self.client.get("/api/history/?start=2026-10-07&end=2026-10-08").json()
        self.assertEqual(len(history["days"][0]["completed_tasks"]), 1)
        self.assertEqual(history["days"][1]["completed_tasks"], [])
        self.post(f"/api/tasks/{self.task.id}/", {"action": "archive"})
        history = self.client.get("/api/history/?start=2026-10-07&end=2026-10-08").json()
        self.assertEqual(history["days"][0]["completed_tasks"][0]["id"], self.task.id)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get("/api/state/").json()["day"]["completed_tasks"], [])

    def test_day_reset_setting_is_saved_and_invalid_times_are_rejected(self):
        data = dict(timezone="Europe/Brussels", day_start="09:00", day_end="17:00",
                    day_rollover="04:00", focus_minutes=25, short_break=5,
                    long_break=15, long_every=4)
        self.assertEqual(self.post("/api/settings/", data).status_code, 200)
        self.prefs.refresh_from_db()
        self.assertEqual(self.prefs.day_rollover, time(4))
        self.assertEqual(self.client.get("/api/state/").json()["preferences"]["day_rollover"], "04:00")
        data["day_rollover"] = "25:00"
        self.assertEqual(self.post("/api/settings/", data).status_code, 400)
        self.prefs.refresh_from_db()
        self.assertEqual(self.prefs.day_rollover, time(4))

    def test_configured_day_boundary_preserves_completions_until_four(self):
        self.prefs.day_rollover = time(4)
        self.prefs.save()
        self.post(f"/api/tasks/{self.task.id}/", {"action": "toggle"})
        night = datetime(2026, 10, 8, 1, 59, tzinfo=timezone.utc)  # 03:59 Brussels
        with patch("focus.views.timezone.now", return_value=night):
            state = self.client.get("/api/state/").json()
        self.assertEqual(state["today"], "2026-10-07")
        self.assertEqual(state["preferences"]["day_rollover"], "04:00")
        self.assertEqual(state["tasks"][0]["completed_on"], "2026-10-07")
        session = self.start(at=night)
        self.assertEqual(session.date, date(2026, 10, 7))
        self.finish(session, night + timedelta(minutes=1))
        with patch("focus.views.timezone.now", return_value=night + timedelta(minutes=1)):
            state = self.client.get("/api/state/").json()
        self.assertEqual(state["today"], "2026-10-08")
        self.assertEqual(state["tasks"], [])
        self.task.refresh_from_db()
        self.assertEqual(self.task.completed_on, date(2026, 10, 7))
        # Changing the cutoff does not rewrite stored completion dates.
        self.prefs.day_rollover = time(0)
        self.prefs.save()
        self.task.refresh_from_db()
        self.assertEqual(self.task.completed_on, date(2026, 10, 7))

    def test_early_morning_blocks_remain_real_reservations_with_late_rollover(self):
        self.prefs.day_rollover = time(4)
        self.prefs.save()
        block = self.block(start=time(1), end=time(2), day=date(2026, 10, 8))
        night = datetime(2026, 10, 7, 23, 30, tzinfo=timezone.utc)  # 01:30 Oct 8
        with patch("focus.views.timezone.now", return_value=night):
            state = self.client.get("/api/state/").json()
        self.assertEqual(state["today"], "2026-10-07")
        self.assertEqual(state["live_block"]["id"], block.id)
        self.assertEqual(state["day"]["blocks"][0]["date"], "2026-10-08")
        self.assertEqual(self.post("/api/timer/", {"action": "start"}, night).status_code, 409)
        session = self.start(at=night, block_id=block.id)
        self.assertEqual(session.date, date(2026, 10, 7))
        with patch("focus.views.timezone.now", return_value=night):
            history = self.client.get("/api/history/?start=2026-10-07&end=2026-10-08").json()
        self.assertEqual(history["days"][0]["sessions"][0]["id"], session.id)
        self.assertEqual(history["days"][1]["blocks"], [])

    def test_day_boundary_handles_dst_without_day_going_backwards(self):
        from .services import local_day
        self.prefs.day_rollover = time(2, 30)
        # Brussels repeats 02:00–03:00 on Oct 25; the first cutoff wins.
        for value in [datetime(2026, 10, 25, 0, 35, tzinfo=timezone.utc),
                      datetime(2026, 10, 25, 1, 15, tzinfo=timezone.utc)]:
            self.assertEqual(local_day(self.prefs, value), date(2026, 10, 25))
        # A nonexistent 02:30 spring cutoff advances when the clock jumps to 03:00.
        self.assertEqual(local_day(self.prefs, datetime(2026, 3, 29, 0, 59, tzinfo=timezone.utc)),
                         date(2026, 3, 28))
        self.assertEqual(local_day(self.prefs, datetime(2026, 3, 29, 1, 0, tzinfo=timezone.utc)),
                         date(2026, 3, 29))

    def test_reopening_clears_completion_and_redo_uses_new_day(self):
        self.post(f"/api/tasks/{self.task.id}/", {"action": "toggle"})
        tomorrow = NOW + timedelta(days=1)
        self.post(f"/api/tasks/{self.task.id}/", {"action": "toggle"}, tomorrow)
        self.task.refresh_from_db()
        self.assertFalse(self.task.done)
        self.assertIsNone(self.task.completed_on)
        self.post(f"/api/tasks/{self.task.id}/", {"action": "toggle"}, tomorrow)
        self.task.refresh_from_db()
        self.assertEqual(self.task.completed_on, date(2026, 10, 8))

    def test_undated_tasks_are_retained_and_can_be_attached_explicitly(self):
        self.task.done = True
        self.task.save()
        self.assertIsNone(self.client.get("/api/state/").json()["tasks"][0]["completed_on"])
        self.assertEqual(self.client.get("/api/state/").json()["day"]["completed_tasks"], [])
        url = f"/api/tasks/{self.task.id}/"
        self.assertEqual(self.post(url, {"action": "date_completed", "date": "2026-10-08"}).status_code, 400)
        self.client.force_login(self.other)
        self.assertEqual(self.post(url, {"action": "date_completed", "date": "2026-10-06"}).status_code, 404)
        self.client.force_login(self.user)
        self.assertEqual(self.post(url, {"action": "date_completed", "date": "2026-10-06"}).status_code, 200)
        self.assertEqual(self.post(url, {"action": "date_completed", "date": "2026-10-07"}).status_code, 400)
        history = self.client.get("/api/history/?start=2026-10-06&end=2026-10-07").json()
        self.assertEqual(history["days"][0]["completed_tasks"][0]["title"], self.task.title)
        self.assertEqual(history["days"][1]["completed_tasks"], [])

    def test_completed_history_does_not_use_up_pending_task_limit(self):
        self.task.done = True
        self.task.completed_on = date(2026, 10, 6)
        self.task.save()
        Task.objects.bulk_create([Task(user=self.user, title=str(i), done=True,
                                      completed_on=date(2026, 10, 6)) for i in range(200)])
        self.assertEqual(self.post("/api/tasks/", {"title": "Next task"}).status_code, 201)

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
                {"effort": 1, "allocations": [{"task_id": foreign_task.id, "sand": 1}]},
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
            {"effort": 0, "allocations": [{"sand": 0, "label": "Thinking"}]},
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

    def recurring(self, day="2026-10-09", interval=2):
        response = self.post(
            "/api/blocks/",
            {
                "date": day,
                "start": "14:00",
                "end": "14:30",
                "kind": "meeting",
                "title": "Recurring call",
                "repeat": {"interval_weeks": interval},
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        return Block.objects.get(pk=response.json()["id"]).template

    def edit_template(self, template, **changes):
        data = {
            "title": "Changed call",
            "kind": template.kind,
            "start": "15:00",
            "end": "15:30",
            "weekday": template.weekday,
            "interval_weeks": template.interval_weeks,
            "anchor_date": template.anchor_date.isoformat(),
            **changes,
        }
        response = self.post(f"/api/recurrences/{template.id}/", data)
        self.assertEqual(response.status_code, 200, response.content)

    def test_recurrence_interval_and_future_edits_preserve_exceptions(self):
        t = self.recurring()
        days = self.client.get("/api/history/?start=2026-10-09&end=2026-11-07").json()["days"]
        self.assertEqual(
            [d["date"] for d in days if d["blocks"]], ["2026-10-09", "2026-10-23", "2026-11-06"]
        )
        edited = Block.objects.get(template=t, date="2026-10-23")
        deleted = Block.objects.get(template=t, date="2026-11-06")
        self.assertEqual(
            self.post(
                f"/api/blocks/{edited.id}/",
                {
                    "title": "Exception",
                    "date": "2026-10-24",
                    "start": "16:00",
                    "end": "17:00",
                    "kind": "meeting",
                },
            ).status_code,
            200,
        )
        self.assertEqual(
            self.post(f"/api/blocks/{deleted.id}/", {"action": "delete"}).status_code, 200
        )
        self.edit_template(t)
        days = self.client.get("/api/history/?start=2026-10-09&end=2026-11-07").json()["days"]
        visible = {d["date"]: d["blocks"] for d in days if d["blocks"]}
        self.assertEqual(set(visible), {"2026-10-09", "2026-10-24"})
        self.assertEqual(visible["2026-10-09"][0]["start_time"], "15:00")
        self.assertEqual(visible["2026-10-24"][0]["title"], "Exception")
        self.assertTrue(Block.objects.get(pk=deleted.id).deleted)

    def test_weekday_change_does_not_recreate_fixed_exception_in_same_week(self):
        t = self.recurring()
        b = Block.objects.get(template=t)
        self.post(f"/api/blocks/{b.id}/", {"action": "delete"})
        self.edit_template(t, weekday=3)
        history = self.client.get("/api/history/?start=2026-10-08&end=2026-10-23").json()
        self.assertEqual([d["date"] for d in history["days"] if d["blocks"]], ["2026-10-22"])

    def test_today_and_unopened_elapsed_occurrences_freeze_before_template_change(self):
        t = self.recurring("2026-10-07", 1)
        future_now = NOW + timedelta(days=14)
        with patch("focus.views.timezone.now", return_value=future_now):
            self.client.get("/api/state/")
        self.edit_template(t)
        fixed = list(
            Block.objects.filter(template=t, date__lte=date(2026, 10, 21)).order_by("date")
        )
        self.assertEqual([b.start for b in fixed], [time(14), time(14), time(14)])
        self.assertTrue(all(b.fixed for b in fixed))

    def test_recurrence_delete_keeps_today_and_edited_future(self):
        t = self.recurring("2026-10-07", 1)
        self.client.get("/api/history/?start=2026-10-07&end=2026-10-28")
        edited = Block.objects.get(template=t, date="2026-10-14")
        self.post(
            f"/api/blocks/{edited.id}/",
            {
                "date": "2026-10-14",
                "start": "16:00",
                "end": "17:00",
                "title": "Fixed",
                "kind": "meeting",
            },
        )
        self.assertEqual(
            self.post(f"/api/recurrences/{t.id}/", {"action": "delete"}).status_code, 200
        )
        self.assertEqual(
            list(Block.objects.filter(template=t).order_by("date").values_list("date", flat=True)),
            [date(2026, 10, 7), date(2026, 10, 14)],
        )

    def test_recurring_conflicts_detected_without_loading_future_days(self):
        self.recurring()
        data = {
            "date": "2026-10-23",
            "start": "14:15",
            "end": "15:00",
            "kind": "break",
            "title": "Lunch",
        }
        self.assertEqual(self.post("/api/blocks/", data).status_code, 409)
        data.update(date="2026-10-16", repeat={"interval_weeks": 3})
        self.assertEqual(self.post("/api/blocks/", data).status_code, 409)
        data["repeat"]["interval_weeks"] = 2
        self.assertEqual(self.post("/api/blocks/", data).status_code, 200)

    def daily_schedule(self, **changes):
        data = dict(
            title="Daily call",
            kind="meeting",
            start="14:00",
            end="14:30",
            frequency="daily",
            weekday=2,
            interval_weeks=1,
            anchor_date="2026-10-08",
        )
        data.update(changes)
        response = self.post("/api/recurrences/", data)
        self.assertEqual(response.status_code, 200, response.content)
        from .models import BlockTemplate

        return BlockTemplate.objects.get(id=response.json()["templates"][-1]["id"])

    def test_daily_creation_and_exceptions_do_not_suppress_neighbouring_days(self):
        t = self.daily_schedule()
        self.client.get("/api/history/?start=2026-10-08&end=2026-10-14")
        self.assertEqual(Block.objects.filter(template=t).count(), 7)
        deleted = Block.objects.get(template=t, date="2026-10-09")
        edited = Block.objects.get(template=t, date="2026-10-10")
        self.post(f"/api/blocks/{deleted.id}/", {"action": "delete"})
        self.post(
            f"/api/blocks/{edited.id}/",
            dict(title="Exception", kind="meeting", date="2026-10-10", start="16:00", end="16:30"),
        )
        self.edit_template(t, frequency="daily")
        days = self.client.get("/api/history/?start=2026-10-08&end=2026-10-14").json()["days"]
        self.assertEqual(
            [d["date"] for d in days if d["blocks"]],
            ["2026-10-08", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"],
        )
        self.assertEqual(days[2]["blocks"][0]["title"], "Exception")
        self.assertEqual(days[3]["blocks"][0]["start_time"], "15:00")
        # Started days freeze before later schedule edits.
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(days=5)):
            self.client.get("/api/state/")
            self.edit_template(t, frequency="daily", start="17:00", end="17:30")
        self.assertEqual(Block.objects.get(template=t, date="2026-10-12").start, time(15))

    def test_daily_collisions_with_weekly_patterns_in_both_directions(self):
        self.recurring()
        response = self.post(
            "/api/recurrences/",
            dict(
                title="Daily",
                kind="meeting",
                start="14:15",
                end="15:00",
                frequency="daily",
                weekday=0,
                interval_weeks=1,
                anchor_date="2026-10-08",
            ),
        )
        self.assertEqual(response.status_code, 409)
        t = self.daily_schedule(start="16:00", end="16:30")
        response = self.post(
            "/api/recurrences/",
            dict(
                title="Weekly",
                kind="meeting",
                start="16:15",
                end="17:00",
                frequency="weekly",
                weekday=0,
                interval_weeks=2,
                anchor_date="2026-10-08",
            ),
        )
        self.assertEqual(response.status_code, 409)
        self.client.force_login(self.other)
        self.assertEqual(
            self.post(f"/api/recurrences/{t.id}/", {"action": "delete"}).status_code, 404
        )

    def test_daily_repeat_from_block_and_route_reload(self):
        response = self.post(
            "/api/blocks/",
            dict(
                title="Daily",
                kind="break",
                date="2026-10-08",
                start="12:00",
                end="12:30",
                repeat={"frequency": "daily", "interval_weeks": 1},
            ),
        )
        self.assertEqual(response.status_code, 200, response.content)
        days = self.client.get("/api/history/?start=2026-10-08&end=2026-10-10").json()["days"]
        self.assertEqual([len(d["blocks"]) for d in days], [1, 1, 1])
        for path in ["/overview", "/settings", "/recurring"]:
            self.assertEqual(self.client.get(path).status_code, 200)
            self.client.logout()
            self.assertEqual(self.client.get(path).status_code, 302)
            self.client.force_login(self.user)

    def test_recurrences_are_user_scoped(self):
        t = self.recurring()
        self.client.force_login(self.other)
        self.assertEqual(self.client.get("/api/recurrences/").json()["templates"], [])
        self.assertEqual(
            self.post(f"/api/recurrences/{t.id}/", {"action": "delete"}).status_code, 404
        )

    def test_shortened_focus_and_ignore_break_allowance(self):
        self.block(start=time(9, 20), end=time(10))
        s = self.start()
        self.assertEqual(s.planned_seconds, 900)
        self.post("/api/timer/", {"action": "cancel", "id": s.id})
        s = self.start(ignore_break=True)
        self.assertEqual(s.planned_seconds, 1200)
        self.assertEqual(
            self.post("/api/timer/", {"action": "overrun", "id": s.id}).status_code, 409
        )

    def test_next_duration_consumed_once_and_running_resize_keeps_elapsed(self):
        self.assertEqual(
            self.post("/api/timer/", {"action": "set_next", "seconds": 600}).status_code, 200
        )
        s = self.start()
        self.assertEqual(s.planned_seconds, 600)
        self.prefs.refresh_from_db()
        self.assertIsNone(self.prefs.next_focus_seconds)
        self.assertEqual(
            self.post(
                "/api/timer/",
                {"action": "resize", "id": s.id, "seconds": 300},
                NOW + timedelta(minutes=3),
            ).status_code,
            200,
        )
        s.refresh_from_db()
        self.assertEqual(s.planned_seconds, 480)
        self.assertEqual(s.elapsed_seconds, 180)
        self.assertEqual(s.deadline, NOW + timedelta(minutes=8))

    def test_natural_overrun_counts_gap_as_work_and_reopens_review(self):
        s = self.start()
        self.finish(s)
        self.post(
            f"/api/sessions/{s.id}/review/",
            {"allocations": [{"label": "Writing", "sand": 4}]},
            NOW + timedelta(minutes=25),
        )
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "overrun", "id": s.id}, NOW + timedelta(minutes=27)
            ).status_code,
            200,
        )
        s.refresh_from_db()
        self.assertEqual(s.status, "running")
        self.assertFalse(s.reviewed)
        self.assertEqual(s.elapsed_seconds, 1620)
        self.assertEqual(s.deadline, NOW + timedelta(minutes=32))
        self.finish(s, NOW + timedelta(minutes=32))
        s.refresh_from_db()
        self.assertEqual(s.elapsed_seconds, 1920)

    def test_meeting_overrun_extends_only_occurrence_and_counts_break_cycle(self):
        t = self.recurring("2026-10-07", 1)
        b = Block.objects.get(template=t)
        at = NOW + timedelta(hours=5)
        s = self.start(at, block_id=b.id)
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "overrun", "id": s.id}, at + timedelta(minutes=20)
            ).status_code,
            200,
        )
        b.refresh_from_db()
        t.refresh_from_db()
        self.assertEqual(b.end, time(14, 35))
        self.assertEqual(t.end, time(14, 30))
        self.prefs.long_every = 1
        self.prefs.save()
        self.finish(s, at + timedelta(minutes=35))
        s.refresh_from_db()
        self.assertEqual(s.break_until - s.ended_at, timedelta(minutes=15))
        self.assertEqual(
            self.post(
                f"/api/sessions/{s.id}/review/", {"allocations": [{"label": "Call", "sand": 3}]}
            ).status_code,
            200,
        )

    def test_history_range_limit_and_grouped_notes(self):
        self.post("/api/notes/", {"period": "week", "date": "2026-10-07", "text": "Week"})
        self.post("/api/notes/", {"period": "month", "date": "2026-10-07", "text": "Month"})
        history = self.client.get("/api/history/?start=2026-09-01&end=2026-11-30").json()
        self.assertEqual(len(history["days"]), 91)
        self.assertEqual(history["notes"]["week:2026-10-05"], "Week")
        self.assertEqual(history["notes"]["month:2026-10-01"], "Month")
        self.assertEqual(
            self.client.get("/api/history/?start=2026-01-01&end=2026-12-31").status_code, 400
        )

    def test_recurring_dst_invalid_occurrence_is_skipped(self):
        from .models import BlockTemplate

        t = BlockTemplate.objects.create(
            user=self.user,
            title="Early Sunday",
            kind="break",
            timezone="Europe/Brussels",
            start=time(2, 30),
            end=time(3, 30),
            weekday=6,
            interval_weeks=1,
            anchor_date=date(2026, 10, 18),
            effective_from=date(2026, 10, 18),
        )
        history = self.client.get("/api/history/?start=2026-10-18&end=2026-11-01")
        self.assertEqual(history.status_code, 200, history.content)
        self.assertEqual(
            list(Block.objects.filter(template=t).order_by("date").values_list("date", flat=True)),
            [date(2026, 10, 18), date(2026, 11, 1)],
        )

    def test_paused_resize_preserves_accounting_and_override_matches_plan(self):
        self.post("/api/timer/", {"action": "set_next", "seconds": 600})
        state = self.client.get("/api/state/").json()
        slot = state["day"]["plan"][0]
        self.assertEqual(
            datetime.fromisoformat(slot["end"]) - datetime.fromisoformat(slot["start"]),
            timedelta(minutes=10),
        )
        s = self.start()
        self.post("/api/timer/", {"action": "pause", "id": s.id}, NOW + timedelta(minutes=3))
        self.post(
            "/api/timer/",
            {"action": "resize", "id": s.id, "seconds": 120},
            NOW + timedelta(minutes=5),
        )
        self.post("/api/timer/", {"action": "resume", "id": s.id}, NOW + timedelta(minutes=10))
        self.finish(s, NOW + timedelta(minutes=12))
        s.refresh_from_db()
        self.assertEqual(s.elapsed_seconds, 300)

    def test_overrun_cannot_reopen_manual_completion_or_another_users_timer(self):
        s = self.start()
        self.finish(s, NOW + timedelta(minutes=2))
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "overrun", "id": s.id}, NOW + timedelta(minutes=3)
            ).status_code,
            409,
        )
        self.client.force_login(self.other)
        self.assertEqual(
            self.post("/api/timer/", {"action": "resize", "id": s.id, "seconds": 60}).status_code,
            404,
        )

    def test_past_meeting_results_without_starting_timer(self):
        b = self.block(start=time(8), end=time(8, 30))
        response = self.post("/api/timer/", {"action": "record_meeting", "block_id": b.id})
        self.assertEqual(response.status_code, 200, response.content)
        session = Session.objects.get(pk=response.json()["session"]["id"])
        self.assertEqual(session.elapsed_seconds, 1800)
        self.assertEqual(session.kind, "meeting")
        self.assertEqual(
            self.post(
                f"/api/sessions/{session.id}/review/",
                {
                    "reflection": "Decision made",
                    "allocations": [
                        {"label": "Design review", "sand": 3},
                        {"label": "Actions", "sand": 2},
                    ],
                },
            ).status_code,
            200,
        )
        self.post("/api/timer/", {"action": "record_meeting", "block_id": b.id})
        self.assertEqual(Session.objects.filter(block=b).count(), 1)
        data = self.client.get("/api/state/").json()["day"]
        self.assertEqual(data["summary"]["effort"], 5)
        self.assertEqual(data["sessions"][0]["reflection"], "Decision made")

    def test_meeting_results_reject_future_breaks_and_foreign_blocks(self):
        future = self.block()
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "record_meeting", "block_id": future.id}
            ).status_code,
            409,
        )
        rest = self.block(kind="break", start=time(8), end=time(8, 30))
        self.assertEqual(
            self.post("/api/timer/", {"action": "record_meeting", "block_id": rest.id}).status_code,
            404,
        )
        foreign = self.block(user=self.other, start=time(8), end=time(8, 30))
        self.assertEqual(
            self.post(
                "/api/timer/", {"action": "record_meeting", "block_id": foreign.id}
            ).status_code,
            404,
        )
        self.assertEqual(Session.objects.count(), 0)


class EffortMigrationTests(TransactionTestCase):
    def test_existing_split_reviews_keep_total_sand_and_labels(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        old = [("focus", "0002_alter_preferences_day_end_and_more")]
        new = [("focus", "0003_blocktemplate_and_more")]
        executor = MigrationExecutor(connection)
        executor.migrate(old)
        try:
            apps = executor.loader.project_state(old).apps
            User = apps.get_model("auth", "User")
            OldSession = apps.get_model("focus", "Session")
            OldAllocation = apps.get_model("focus", "Allocation")
            user = User.objects.create(username="migration-user")
            session = OldSession.objects.create(
                resumed_at=NOW,
                user=user,
                date=NOW.date(),
                status="completed",
                started_at=NOW,
                ended_at=NOW + timedelta(minutes=25),
                deadline=NOW + timedelta(minutes=25),
                planned_seconds=1500,
                remaining_seconds=0,
                elapsed_seconds=1500,
                effort=4,
                reviewed=True,
            )
            OldAllocation.objects.create(session=session, label="Proposal", percent=70)
            OldAllocation.objects.create(session=session, label="Mail", percent=30)
            executor = MigrationExecutor(connection)
            executor.migrate(new)
            session = Session.objects.get(pk=session.pk)
            self.assertEqual(session.effort, 4)
            self.assertEqual(
                list(session.allocations.values_list("label", "sand")),
                [("Proposal", 3), ("Mail", 1)],
            )
            self.assertEqual(session.elapsed_seconds, 1500)
        finally:
            MigrationExecutor(connection).migrate(new)
