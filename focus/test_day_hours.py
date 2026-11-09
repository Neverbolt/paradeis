"""Day-specific work hours affect planning without editing existing activity."""
import json
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from .models import Block, DayHours, DayPlan, Session
from .services import auto_window_end, preferences, workday_bounds
from .tests import NOW


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DayHoursTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("day-hours")
        self.other = get_user_model().objects.create_user("other-hours")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.prefs.daily_review_enabled = False
        self.prefs.save(update_fields=["daily_review_enabled"])
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def save_hours(self, **extra):
        payload = {"date": "2026-10-07", "start": "10:00", "end": "12:00", **extra}
        return self.client.post("/api/day-hours/", json.dumps(payload), content_type="application/json")

    def state(self, day="2026-10-07"):
        return self.client.get(f"/api/state/?date={day}").json()

    def test_default_hours_and_override_only_affect_the_selected_day(self):
        default = self.state()["day"]["workday"]
        self.assertEqual((default["start_time"], default["end_time"], default["customized"]), ("09:00", "17:00", False))
        self.assertEqual(self.save_hours().status_code, 200)
        day = self.state()["day"]
        self.assertEqual((day["workday"]["start_time"], day["workday"]["end_time"], day["workday"]["customized"]), ("10:00", "12:00", True))
        self.assertEqual(day["plan"][0]["start"], day["workday"]["start"])
        self.assertTrue(all(s["end"] <= day["workday"]["end"] for s in day["plan"]))
        self.assertEqual(self.state("2026-10-08")["day"]["workday"]["start_time"], "09:00")
        self.prefs.refresh_from_db()
        self.assertEqual((self.prefs.day_start, self.prefs.day_end), (time(9), time(17)))
        self.save_hours(start="11:00")
        self.assertEqual(DayHours.objects.filter(user=self.user).count(), 1)

    def test_override_is_private_and_visible_in_history(self):
        self.save_hours()
        days = self.client.get("/api/history/?start=2026-10-07&end=2026-10-08").json()["days"]
        self.assertEqual([day["workday"]["customized"] for day in days], [True, False])
        self.client.force_login(self.other)
        self.assertFalse(self.state()["day"]["workday"]["customized"])
        self.save_hours(start="08:00")
        self.assertEqual(DayHours.objects.get(user=self.user).start, time(10))

    def test_reset_restores_current_defaults_and_other_dates_are_untouched(self):
        self.save_hours()
        self.save_hours(date="2026-10-08", end="13:00")
        self.prefs.day_start = time(8)
        self.prefs.save()
        self.assertEqual(self.save_hours(reset=True).status_code, 200)
        day = self.state()["day"]
        self.assertFalse(day["workday"]["customized"])
        self.assertEqual(day["workday"]["start_time"], "08:00")
        self.assertTrue(self.state("2026-10-08")["day"]["workday"]["customized"])

    def test_invalid_times_and_dates_leave_the_saved_hours_unchanged(self):
        self.save_hours()
        for data in [{"start": "12:00"}, {"end": "09:00"}, {"start": "25:00"},
                     {"end": "12:00:30"}, {"date": "bad"}, {"date": "2101-01-01"}]:
            self.assertEqual(self.save_hours(**data).status_code, 400)
        self.assertEqual(DayHours.objects.get(user=self.user).start, time(10))

    def test_explicit_hours_reject_nonexistent_and_ambiguous_dst_times(self):
        self.assertEqual(self.save_hours(date="2026-03-29", start="02:30", end="05:00").status_code, 400)
        self.assertEqual(self.save_hours(date="2026-10-25", start="02:30", end="05:00").status_code, 400)
        self.assertFalse(DayHours.objects.exists())

    def test_early_morning_hours_use_the_correct_calendar_day_after_reset(self):
        self.prefs.day_rollover = time(4)
        self.prefs.save()
        self.save_hours(start="01:00", end="03:00")
        start, end = workday_bounds(date(2026, 10, 7), self.prefs)
        self.assertEqual(start, datetime(2026, 10, 7, 23, 0, tzinfo=timezone.utc))
        self.assertEqual(end, datetime(2026, 10, 8, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(auto_window_end(self.user, self.prefs, start + timedelta(minutes=30)), end)
        self.assertEqual(self.state()["day"]["workday"]["start"], start.isoformat())

    def test_changing_hours_keeps_running_sessions_and_fixed_blocks_intact(self):
        started = self.client.post("/api/timer/", json.dumps({"action": "start"}), content_type="application/json")
        session = Session.objects.get(id=started.json()["id"])
        block = Block.objects.create(user=self.user, date=NOW.date(), start=time(13), end=time(14), kind="meeting", title="Call")
        self.save_hours(start="10:00", end="11:00")
        session.refresh_from_db()
        block.refresh_from_db()
        self.assertEqual(session.deadline, NOW + timedelta(minutes=25))
        self.assertEqual(session.status, "running")
        self.assertEqual((block.start, block.end), (time(13), time(14)))
        self.assertEqual(self.state()["day"]["blocks"][0]["id"], block.id)

    def test_work_reservations_still_project_focus_outside_regular_day_hours(self):
        Block.objects.create(user=self.user, date=NOW.date(), start=time(18), end=time(19), kind="work", title="Evening")
        self.save_hours()
        slots = self.state()["day"]["plan"]
        self.assertTrue(any(s.get("title") == "Evening" for s in slots))
        self.assertTrue(all(not ("2026-10-07T10:00:00+00:00" <= s["start"] < "2026-10-07T16:00:00+00:00") for s in slots))

    def test_automatic_focus_uses_and_caps_to_overridden_hours(self):
        DayPlan.objects.create(user=self.user, date=NOW.date())
        self.prefs.auto_focus = True
        self.prefs.save()
        self.save_hours(start="09:00", end="09:40")
        self.client.post("/api/timer/", json.dumps({"action": "start"}), content_type="application/json")
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=30)):
            self.assertTrue(self.state()["can_auto_start"])
            response = self.client.post("/api/timer/", json.dumps({"action": "auto_start"}), content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Session.objects.get(id=response.json()["id"]).planned_seconds, 10 * 60)
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=45)):
            self.assertFalse(self.state()["can_auto_start"])
