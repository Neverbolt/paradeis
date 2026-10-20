"""Reservation edits, flexible work topics, and opt-in automatic cycles."""
from datetime import date, time, timedelta
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model

from .models import Block, Session, Task
from .services import preferences
from .tests import NOW
import json


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class SchedulingTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("scheduler")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.task = Task.objects.create(user=self.user, title="Inbox")
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def post(self, path, data, minutes=0):
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=minutes)):
            return self.client.post(path, json.dumps(data), content_type="application/json")

    def state(self, minutes=0):
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=minutes)):
            response = self.client.get("/api/state/")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def start(self, minutes=0, **extra):
        response = self.post("/api/timer/", {"action": "start", **extra}, minutes)
        self.assertEqual(response.status_code, 201, response.content)
        return Session.objects.get(pk=response.json()["id"])

    def reserve(self, kind="meeting", start="09:20", end="10:00", minutes=5, title="Call"):
        return self.post("/api/blocks/", {"kind": kind, "title": title, "date": "2026-10-07",
                                         "start": start, "end": end}, minutes)

    def configure(self, minutes=0, **flags):
        response = self.post("/api/timer/", {"action": "configure_auto", **flags}, minutes)
        self.assertEqual(response.status_code, 200, response.content)

    def test_new_meeting_shortens_focus_and_preserves_worked_time(self):
        session = self.start()
        self.assertEqual(self.reserve().status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 300)
        self.assertEqual(session.remaining_seconds, 600)
        self.assertEqual(session.planned_seconds, 900)
        self.assertEqual(session.deadline, NOW + timedelta(minutes=15))
        state = self.state(15)
        self.assertIsNone(state["active"])
        self.assertEqual(state["last_completed"]["elapsed"], 900)
        self.assertEqual(state["break_until"], (NOW + timedelta(minutes=20)).isoformat())

    def test_immediate_meeting_finishes_focus_without_losing_work(self):
        session = self.start()
        response = self.reserve(start="09:05", end="10:00")
        self.assertEqual(response.status_code, 200, response.content)
        session.refresh_from_db()
        self.assertEqual(session.status, "completed")
        self.assertEqual(session.elapsed_seconds, 300)
        self.assertEqual(session.ended_at, NOW + timedelta(minutes=5))
        meeting = self.start(5, block_id=response.json()["id"])
        self.assertEqual(meeting.kind, "meeting")

    def test_backdated_meeting_cannot_erase_recorded_work(self):
        session = self.start()
        self.assertEqual(self.reserve(start="09:04").status_code, 409)
        session.refresh_from_db()
        self.assertEqual(session.planned_seconds, 1500)
        self.assertEqual(Block.objects.count(), 0)

    def test_edit_and_pause_shorten_only_remaining_time(self):
        response = self.reserve(start="10:00", end="11:00", minutes=0)
        session = self.start()
        self.post("/api/timer/", {"action": "pause", "id": session.id}, 5)
        response = self.post(f'/api/blocks/{response.json()["id"]}/', {
            "kind": "meeting", "title": "Earlier call", "date": "2026-10-07",
            "start": "09:20", "end": "10:00"}, 7)
        self.assertEqual(response.status_code, 200, response.content)
        session.refresh_from_db()
        self.assertEqual(session.status, "paused")
        self.assertEqual(session.elapsed_seconds, 300)
        self.assertEqual(session.remaining_seconds, 8 * 60)
        self.assertEqual(self.post("/api/timer/", {"action": "resume", "id": session.id}, 10).status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.remaining_seconds, 5 * 60)
        self.assertEqual(session.deadline, NOW + timedelta(minutes=15))

    def test_invalid_repeating_block_rolls_back_timer_shortening(self):
        session = self.start()
        response = self.post("/api/blocks/", {"kind": "meeting", "title": "Call", "date": "2026-10-07",
            "start": "09:10", "end": "10:00", "repeat": {"frequency": "invalid", "interval_weeks": 1}}, 5)
        self.assertEqual(response.status_code, 400)
        session.refresh_from_db()
        self.assertEqual(session.status, "running")
        self.assertEqual(session.planned_seconds, 1500)

    def test_work_overlaps_fixed_reservations_but_not_other_work(self):
        self.assertEqual(self.reserve("work", "15:00", "17:00", title="Strategy").status_code, 200)
        self.assertEqual(self.reserve("meeting", "15:40", "16:00").status_code, 200)
        self.assertEqual(self.reserve("break", "16:25", "16:30", title="Tea").status_code, 200)
        self.assertEqual(self.reserve("work", "16:00", "18:00", title="Other").status_code, 409)
        self.assertEqual(self.reserve("break", "15:45", "15:55", title="Overlap").status_code, 409)
        state = self.state(360)
        self.assertIsNone(state["live_block"])
        self.assertEqual(state["default_topic"], "Strategy")
        projections = [p for p in state["day"]["plan"] if p["kind"] == "focus" and p["title"] == "Strategy"]
        self.assertGreaterEqual(len(projections), 2)
        self.assertTrue(all(not (p["start"] < (NOW + timedelta(hours=7)).isoformat() and
            p["end"] > (NOW + timedelta(hours=6, minutes=40)).isoformat()) for p in projections))

    def test_work_default_is_normal_focus_and_can_be_overridden(self):
        self.reserve("work", "09:00", "11:00", title="Strategy", minutes=0)
        session = self.start()
        self.assertEqual(session.kind, "focus")
        self.assertEqual(session.title, "Strategy")
        self.assertIsNone(session.block_id)
        self.assertEqual(session.planned_seconds, 1500)
        self.post("/api/tasks/", {"title": "Another task"}, 1)
        self.assertEqual(self.state(1)["active"]["title"], "Strategy")
        self.assertEqual(self.post("/api/timer/", {"action": "set_topic", "topic": str(self.task.id)}, 2).status_code, 200)
        self.post("/api/timer/", {"action": "finish", "id": session.id}, 4)
        self.assertEqual(list(session.allocations.values_list("label", flat=True)), ["Strategy", "Inbox"])
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 240)

    def test_selected_topic_on_start_is_owned_and_work_remains_flexible(self):
        self.reserve("work", "09:00", "11:00", minutes=0, title="Strategy")
        session = self.start(topic=str(self.task.id))
        self.assertEqual(session.title, "Inbox")
        self.post("/api/timer/", {"action": "cancel", "id": session.id}, 1)
        other = get_user_model().objects.create_user("other")
        foreign = Task.objects.create(user=other, title="Private")
        self.assertEqual(self.post("/api/timer/", {"action": "start", "topic": str(foreign.id)}, 1).status_code, 404)
        self.assertFalse(Session.objects.filter(status="running").exists())
        self.assertEqual(self.start(1, topic="open").title, "Open focus")

    def test_adding_work_does_not_cut_a_running_focus(self):
        session = self.start()
        self.assertEqual(self.reserve("work", "09:00", "11:00", title="Strategy").status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.deadline, NOW + timedelta(minutes=25))

    def test_recurring_work_can_contain_recurring_meetings(self):
        data = {"title": "Strategy", "kind": "work", "frequency": "daily", "weekday": 3,
                "start": "15:00", "end": "17:00", "anchor_date": "2026-10-08", "interval_weeks": 1}
        self.assertEqual(self.post("/api/recurrences/", data).status_code, 200)
        data.update(kind="meeting", title="Call", start="15:30", end="16:00")
        self.assertEqual(self.post("/api/recurrences/", data).status_code, 200)
        data.update(kind="work", title="Other")
        self.assertEqual(self.post("/api/recurrences/", data).status_code, 409)

    def test_auto_focus_waits_for_break_and_is_idempotent(self):
        self.configure(auto_focus=True, auto_break=True)
        self.assertFalse(self.state()["can_auto_start"])
        first = self.start()
        self.state(25)
        self.assertFalse(self.state(29)["can_auto_start"])
        self.assertTrue(self.state(30)["can_auto_start"])
        response = self.post("/api/timer/", {"action": "auto_start"}, 30)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertNotEqual(response.json()["id"], first.id)
        self.assertEqual(self.post("/api/timer/", {"action": "auto_start"}, 30).status_code, 200)
        self.assertEqual(Session.objects.count(), 2)

    def test_manual_break_can_start_later_or_be_skipped(self):
        self.configure(auto_focus=True, auto_break=False)
        session = self.start()
        state = self.state(25)
        self.assertIsNone(state["break_until"])
        self.assertEqual(state["pending_break"]["pending_break_seconds"], 300)
        self.assertFalse(state["can_auto_start"])
        self.assertEqual(self.post("/api/timer/", {"action": "start_break"}, 40).status_code, 200)
        self.assertEqual(self.state(40)["break_until"], (NOW + timedelta(minutes=45)).isoformat())
        self.assertFalse(self.state(44)["can_auto_start"])
        self.post("/api/timer/", {"action": "skip_break"}, 44)
        self.assertTrue(self.state(44)["can_auto_start"])
        session.refresh_from_db()
        self.assertEqual(session.elapsed_seconds, 1500)

    def test_auto_focus_stops_for_fixed_blocks_cancel_and_day_end(self):
        self.configure(auto_focus=True)
        session = self.start()
        self.reserve(start="09:30", end="10:00", minutes=0)
        self.state(25)
        self.assertFalse(self.state(30)["can_auto_start"])
        self.assertEqual(self.post("/api/timer/", {"action": "auto_start"}, 30).status_code, 409)
        self.assertTrue(self.state(60)["can_auto_start"])
        response = self.post("/api/timer/", {"action": "auto_start"}, 60)
        self.post("/api/timer/", {"action": "cancel", "id": response.json()["id"]}, 61)
        self.assertFalse(self.state(62)["can_auto_start"])
        self.configure(auto_focus=True)
        self.assertFalse(self.state(8 * 60)["can_auto_start"])

    def test_auto_focus_does_not_backfill_or_carry_into_next_day(self):
        self.configure(auto_focus=True)
        self.start()
        self.assertTrue(self.state(6 * 60)["can_auto_start"])
        response = self.post("/api/timer/", {"action": "auto_start"}, 6 * 60)
        session = Session.objects.get(pk=response.json()["id"])
        self.assertEqual(session.started_at, NOW + timedelta(hours=6))
        self.assertEqual(Session.objects.count(), 2)
        self.assertFalse(self.state(24 * 60)["can_auto_start"])

    def test_auto_controls_validate_booleans(self):
        self.assertEqual(self.post("/api/timer/", {"action": "configure_auto", "auto_focus": "true"}).status_code, 400)

    def test_auto_focus_can_use_work_outside_regular_hours_and_caps_at_its_end(self):
        self.reserve("work", "18:00", "18:20", title="Evening", minutes=0)
        self.configure(auto_focus=True)
        self.start()
        response = self.post("/api/timer/", {"action": "auto_start"}, 9 * 60)
        self.assertEqual(response.status_code, 201, response.content)
        session = Session.objects.get(id=response.json()["id"])
        self.assertEqual(session.title, "Evening")
        self.assertEqual(session.planned_seconds, 20 * 60)

    def test_long_break_is_capped_before_the_next_fixed_reservation(self):
        self.prefs.long_every = 1
        self.prefs.save()
        self.reserve(start="09:30", end="10:00", minutes=0)
        self.start()
        state = self.state(25)
        self.assertEqual(state["break_until"], (NOW + timedelta(minutes=30)).isoformat())

    def test_resuming_a_custom_duration_does_not_reset_to_default_focus_length(self):
        self.post("/api/timer/", {"action": "set_next", "seconds": 3600})
        session = self.start()
        self.post("/api/timer/", {"action": "pause", "id": session.id}, 5)
        self.post("/api/timer/", {"action": "resume", "id": session.id}, 10)
        session.refresh_from_db()
        self.assertEqual(session.remaining_seconds, 55 * 60)

    def test_automatic_break_request_respects_the_latest_toggle(self):
        self.configure(auto_break=False)
        self.start()
        self.state(25)
        self.assertEqual(self.post("/api/timer/", {"action": "auto_break"}, 26).status_code, 409)
        self.assertIsNotNone(self.state(26)["pending_break"])
        self.configure(minutes=26, auto_break=True)
        self.assertEqual(self.post("/api/timer/", {"action": "auto_break"}, 26).status_code, 200)
        self.assertEqual(self.state(26)["break_until"], (NOW + timedelta(minutes=31)).isoformat())

    def test_work_projects_pomos_outside_workday_without_filling_the_gap(self):
        self.reserve("work", "18:00", "18:20", title="Evening", minutes=0)
        projection = self.state()["day"]["plan"]
        evening = [p for p in projection if p["kind"] == "focus" and p["title"] == "Evening"]
        self.assertEqual(len(evening), 1)
        self.assertEqual(evening[0]["start"], (NOW + timedelta(hours=9)).isoformat())
        self.assertEqual(evening[0]["end"], (NOW + timedelta(hours=9, minutes=20)).isoformat())
        self.assertFalse(any(p["start"] >= (NOW + timedelta(hours=8)).isoformat() and
                             p["start"] < (NOW + timedelta(hours=9)).isoformat() for p in projection))
