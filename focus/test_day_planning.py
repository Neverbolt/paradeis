"""Daily goal choices survive reloads without rewriting the previous day."""
import importlib
import json
from datetime import date, time, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from .models import DayPlan, Task
from .services import preferences
from .tests import NOW


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DayPlanningTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("planner")
        self.other = get_user_model().objects.create_user("private")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.previous = Task.objects.create(user=self.user, title="Finish the proposal", goal_date=NOW.date() - timedelta(days=1))
        self.done = Task.objects.create(user=self.user, title="Review notes", goal_date=self.previous.goal_date,
                                       done=True, completed_on=self.previous.goal_date, position=1)
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def post(self, path, data):
        return self.client.post(path, json.dumps(data), content_type="application/json")

    def carry(self, task=None, day="2026-10-07"):
        return self.post("/api/tasks/carry/", {"task_id": (task or self.previous).id, "date": day})

    def test_empty_slate_includes_all_previous_goals_but_no_automatic_topic(self):
        state = self.client.get("/api/state/").json()
        self.assertEqual(state["tasks"], [])
        self.assertEqual(state["default_topic"], "Open focus")
        self.assertFalse(state["day_plan"]["ready"])
        self.assertEqual([t["id"] for t in state["day_plan"]["previous_tasks"]], [self.previous.id, self.done.id])
        history = self.client.get("/api/history/?start=2026-10-06&end=2026-10-06").json()
        self.assertEqual(len(history["days"][0]["goals"]), 2)
        self.assertEqual(len(history["days"][0]["completed_tasks"]), 1)

    def test_explicit_carry_copies_without_changing_yesterday_and_is_idempotent(self):
        first, second = self.carry(), self.carry()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()["id"], second.json()["id"])
        copied = Task.objects.get(id=first.json()["id"])
        self.assertEqual(copied.carried_from, self.previous)
        self.assertEqual(copied.goal_date, NOW.date())
        self.post(f"/api/tasks/{copied.id}/", {"action": "rename", "title": "A smaller goal"})
        self.post(f"/api/tasks/{copied.id}/", {"action": "toggle"})
        self.previous.refresh_from_db()
        self.assertEqual(self.previous.title, "Finish the proposal")
        self.assertFalse(self.previous.done)
        self.assertEqual(self.previous.goal_date, date(2026, 10, 6))

    def test_completed_goal_can_be_consciously_reused_as_unfinished(self):
        response = self.carry(self.done)
        copied = Task.objects.get(id=response.json()["id"])
        self.assertFalse(copied.done)
        self.assertIsNone(copied.completed_on)
        self.done.refresh_from_db()
        self.assertTrue(self.done.done)
        self.assertEqual(self.done.completed_on, date(2026, 10, 6))

    def test_removing_and_readding_a_carry_restores_same_entry(self):
        pk = self.carry().json()["id"]
        self.post(f"/api/tasks/{pk}/", {"action": "archive"})
        self.assertEqual(self.client.get("/api/state/").json()["tasks"], [])
        self.assertEqual(self.carry().json()["id"], pk)
        self.assertEqual(Task.objects.filter(user=self.user, goal_date=NOW.date(), archived=False).count(), 1)

    def test_new_goals_persist_before_start_and_start_is_remembered(self):
        result = self.post("/api/tasks/", {"title": "New direction", "date": "2026-10-07"})
        self.assertEqual(result.status_code, 201)
        state = self.client.get("/api/state/").json()
        self.assertFalse(state["day_plan"]["ready"])
        self.assertEqual(state["tasks"][0]["title"], "New direction")
        self.assertEqual(self.post("/api/day-plan/", {"date": "2026-10-07"}).status_code, 200)
        self.post("/api/day-plan/", {"date": "2026-10-07"})
        self.assertEqual(DayPlan.objects.filter(user=self.user).count(), 1)
        self.assertTrue(self.client.get("/api/state/").json()["day_plan"]["ready"])
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(days=1)):
            state = self.client.get("/api/state/").json()
        self.assertFalse(state["day_plan"]["ready"])
        self.assertEqual(state["tasks"], [])
        self.assertEqual([t["title"] for t in state["day_plan"]["previous_tasks"]], ["New direction"])

    def test_empty_day_is_allowed_and_skipped_goals_stay_in_history(self):
        self.assertEqual(self.post("/api/day-plan/", {"date": "2026-10-07"}).status_code, 200)
        self.assertEqual(self.client.get("/api/state/").json()["tasks"], [])
        self.assertEqual(Task.objects.get(id=self.previous.id).goal_date, date(2026, 10, 6))

    def test_stale_dates_cannot_add_carry_or_start_a_different_day(self):
        self.assertEqual(self.post("/api/tasks/", {"title": "Stale", "date": "2026-10-06"}).status_code, 409)
        self.assertEqual(self.carry(day="2026-10-06").status_code, 409)
        self.assertEqual(self.post("/api/day-plan/", {"date": "2026-10-06"}).status_code, 409)
        self.assertEqual(self.post("/api/day-plan/", {}).status_code, 400)
        self.assertFalse(DayPlan.objects.exists())
        self.assertEqual(Task.objects.filter(user=self.user).count(), 2)

    def test_cannot_carry_foreign_archived_current_or_older_goals(self):
        for extra in [dict(user=self.other), dict(archived=True), dict(goal_date=NOW.date()),
                      dict(goal_date=date(2026, 10, 4))]:
            values = dict(user=self.user, title="Other", goal_date=date(2026, 10, 6))
            values.update(extra)
            task = Task.objects.create(**values)
            self.assertEqual(self.carry(task).status_code, 404)
        self.client.force_login(self.other)
        self.assertNotIn(self.previous.id, [t["id"] for t in self.client.get("/api/state/").json()["day_plan"]["previous_tasks"]])

    def test_day_setup_follows_configured_reset_not_midnight(self):
        from datetime import datetime, timezone
        self.prefs.day_rollover = time(4)
        self.prefs.save()
        self.post("/api/day-plan/", {"date": "2026-10-07"})
        self.post("/api/tasks/", {"title": "Late goal"})
        at = datetime(2026, 10, 8, 1, 59, tzinfo=timezone.utc)
        with patch("focus.views.timezone.now", return_value=at):
            before = self.client.get("/api/state/").json()
        with patch("focus.views.timezone.now", return_value=at + timedelta(minutes=1)):
            after = self.client.get("/api/state/").json()
        self.assertTrue(before["day_plan"]["ready"])
        self.assertEqual(before["tasks"][0]["title"], "Late goal")
        self.assertFalse(after["day_plan"]["ready"])
        self.assertEqual(after["tasks"], [])
        self.assertEqual(after["day_plan"]["previous_tasks"][0]["title"], "Late goal")

    def test_old_goals_do_not_become_timer_topics_or_affect_current_order(self):
        response = self.post("/api/timer/", {"action": "start", "topic": str(self.previous.id)})
        self.assertEqual(response.status_code, 404)
        pk = self.post("/api/tasks/", {"title": "Today only"}).json()["id"]
        self.assertEqual(self.post("/api/tasks/reorder/", {"ids": [pk]}).status_code, 200)
        response = self.post("/api/timer/", {"action": "start"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.user.session_set.get().title, "Today only")

    def test_auto_focus_waits_for_daily_planning(self):
        self.prefs.auto_focus = True
        self.prefs.save()
        self.post("/api/timer/", {"action": "start"})
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=30)):
            self.assertFalse(self.client.get("/api/state/").json()["can_auto_start"])
            self.assertEqual(self.post("/api/timer/", {"action": "auto_start"}).status_code, 409)
            self.post("/api/day-plan/", {"date": "2026-10-07"})
            self.assertTrue(self.client.get("/api/state/").json()["can_auto_start"])

    def test_rollover_does_not_interrupt_a_running_pomo(self):
        from datetime import datetime, timezone
        late = datetime(2026, 10, 7, 21, 55, tzinfo=timezone.utc)
        self.post("/api/tasks/", {"title": "Late work"})
        with patch("focus.views.timezone.now", return_value=late):
            pk = self.post("/api/timer/", {"action": "start"}).json()["id"]
        with patch("focus.views.timezone.now", return_value=late + timedelta(minutes=10)):
            state = self.client.get("/api/state/").json()
        self.assertEqual(state["active"]["id"], pk)
        self.assertEqual(state["active"]["title"], "Late work")
        self.assertFalse(state["day_plan"]["ready"])
        self.assertEqual(state["tasks"], [])

    def test_legacy_migration_preserves_completion_dates_and_offers_open_goals(self):
        self.prefs.day_rollover = time(4)
        self.prefs.save()
        self.previous.goal_date = None
        self.previous.save()
        undated = Task.objects.create(user=self.user, title="Undated completion", done=True)
        migration = importlib.import_module("focus.migrations.0010_dayplan_task_carried_from_task_goal_date_and_more")
        from django.db import connection
        from datetime import datetime, timezone
        with patch.object(migration.timezone, "now", return_value=datetime(2026, 10, 8, 1, 0, tzinfo=timezone.utc)):
            migration.date_existing_goals(apps, SimpleNamespace(connection=connection))
        self.previous.refresh_from_db()
        self.done.refresh_from_db()
        undated.refresh_from_db()
        self.assertEqual(self.previous.goal_date, date(2026, 10, 6))
        self.assertEqual(self.done.goal_date, self.done.completed_on)
        self.assertIsNone(undated.goal_date)
