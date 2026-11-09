"""Hierarchy, advance planning reservations, and weekday-limited recurring blocks."""
import json
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from . import planning
from .models import Block, BlockTemplate, PeriodGoal, PlanningRule, Session
from .recurrence import occurrence_days
from .services import preferences
from .tests import NOW


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class PeriodPlanningTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("planning")
        self.other = get_user_model().objects.create_user("other-plan")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.prefs.daily_review_enabled = False
        self.prefs.save(update_fields=["daily_review_enabled"])
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def post(self, path, data):
        return self.client.post(path, json.dumps(data), content_type="application/json")

    def save(self, period="week", day="2026-10-07", text="*A defined goal*"):
        return self.post("/api/goals/", {"period":period,"date":day,"text":text})

    def detail(self, period="week", day="2026-10-07"):
        return self.client.get(f"/api/goals/?period={period}&date={day}").json()

    def configure(self, enabled=("week",), workdays=None):
        return self.post("/api/planning-settings/", {"workdays":workdays or [0,1,2,3,4], "rules":[
            {"period":p,"enabled":p in enabled,"weekday":4,"trigger_mode":"last_workday","day_of_month":31,
             "time":"17:00" if p=="week" else "17:30","minutes":25} for p in ["week","month","quarter"]]})

    def test_missing_period_goals_prompt_on_every_visit_until_saved(self):
        for _ in range(2):
            pending = self.client.get("/api/state/").json()["planning"]["pending"]
            self.assertEqual([p["period"] for p in pending], ["quarter","month","week"])
        self.assertEqual(self.save("quarter").status_code, 200)
        self.assertEqual(self.save("month").status_code, 200)
        self.assertEqual(self.save("week").status_code, 200)
        self.assertEqual(self.client.get("/api/state/").json()["planning"]["pending"], [])
        self.assertEqual(self.post("/api/goals/", {"period":"month","date":"2026-10-01","text":" "}).status_code,400)

    def test_goal_dates_normalize_without_changing_notes_or_previous_goals(self):
        self.post("/api/notes/",{"period":"month","date":"2026-10-07","text":"A separate note"})
        for period,day in [("week",date(2026,10,5)),("month",date(2026,10,1)),("quarter",date(2026,10,1))]:
            response=self.save(period)
            self.assertEqual(response.json()["date"],day.isoformat())
            self.assertEqual(PeriodGoal.objects.get(user=self.user,period=period,date=day).text,"*A defined goal*")
        self.assertEqual(self.client.get("/api/notes/?period=month&date=2026-10-07").json()["text"],"A separate note")
        self.save("month","2026-09-01","Prior month")
        self.assertEqual(self.detail("month")["previous"]["text"],"Prior month")
        self.save("month",text="A changed October goal")
        self.assertEqual(PeriodGoal.objects.get(user=self.user,period="month",date=date(2026,9,1)).text,"Prior month")

    def test_week_context_includes_both_months_and_quarters_at_a_boundary(self):
        self.save("month","2026-12-01","December goal")
        self.save("month","2027-01-01","January goal")
        self.save("quarter","2026-10-01","Q4 goal")
        self.save("quarter","2027-01-01","Q1 goal")
        context=self.detail("week","2026-12-28")["context"]
        self.assertEqual([v["text"] for v in context],["December goal","January goal","Q4 goal","Q1 goal"])
        self.assertEqual(len(self.detail("month","2026-12-01")["context"]),1)
        self.assertEqual(self.detail("quarter")["context"],[])

    def test_goal_data_and_planning_settings_are_private(self):
        self.save()
        self.configure()
        self.client.force_login(self.other)
        self.assertEqual(self.detail()["text"],"")
        self.assertFalse(any(r["enabled"] for r in self.client.get("/api/planning-settings/").json()["rules"]))
        self.assertFalse(self.client.get("/api/history/?start=2026-10-01&end=2026-10-31").json()["period_goals"])

    def test_quarter_notes_and_overview_goal_maps_use_period_start_dates(self):
        self.save("quarter",day="2026-11-05")
        response=self.post("/api/notes/",{"period":"quarter","date":"2026-11-05","text":"**Quarter note**"})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()["date"],"2026-10-01")
        history=self.client.get("/api/history/?start=2026-11-02&end=2026-11-08").json()
        self.assertEqual(history["notes"]["quarter:2026-10-01"],"**Quarter note**")
        self.assertEqual(history["period_goals"]["quarter:2026-10-01"],"*A defined goal*")

    def test_trigger_uses_configured_workdays_and_previous_period(self):
        rule=PlanningRule(period="month",trigger_mode="last_workday",time=time(17,30),minutes=25)
        self.assertEqual(planning.trigger_date(rule,date(2026,12,1),[1,6]),date(2026,11,29))
        rule.period="quarter"
        self.assertEqual(planning.trigger_date(rule,date(2027,1,1),[1,6]),date(2026,12,29))
        rule.trigger_mode="day"; rule.day_of_month=31
        self.assertEqual(planning.trigger_date(rule,date(2026,3,1),[0]),date(2026,2,28))
        self.assertEqual(self.configure(workdays=[1,6]).status_code,200)
        self.prefs.refresh_from_db();self.assertEqual(self.prefs.planning_workdays,[1,6])

    def test_advance_weekly_reservation_is_a_fixed_focus_pomo(self):
        self.assertEqual(self.configure().status_code,200)
        block=Block.objects.get(goal_plan__period="week",goal_plan__date=date(2026,10,12))
        self.assertEqual((block.date,block.start,block.end,block.kind),(date(2026,10,9),time(17),time(17,25),"planning"))
        at=datetime(2026,10,9,15,0,tzinfo=timezone.utc)
        with patch("focus.views.timezone.now",return_value=at):
            pending=self.client.get("/api/state/").json()["planning"]["pending"]
            self.assertIn({"period":"week","date":"2026-10-12"},pending)
            started=self.post("/api/timer/",{"action":"start","block_id":block.id})
            self.assertEqual(started.status_code,201,started.content)
            session=Session.objects.get(id=started.json()["id"])
            self.assertEqual((session.kind,session.title,session.planned_seconds),("focus","Weekly review & planning",1500))
            self.assertEqual(self.post("/api/timer/",{"action":"pause","id":session.id}).status_code,409)
        self.assertEqual(block.goal_plan.date,date(2026,10,12))

    def test_conflict_asks_for_a_time_and_never_shifts_existing_blocks(self):
        occupied=Block.objects.create(user=self.user,date=date(2026,10,9),start=time(17),end=time(18),kind="meeting",title="Existing call")
        self.configure()
        detail=self.detail("week","2026-10-12")
        self.assertIsNone(detail["reservation"])
        self.assertIn("conflict",detail["reservation_conflict"])
        occupied.deleted=True;occupied.save()
        self.client.get("/api/state/")
        self.assertIsNone(self.detail("week","2026-10-12")["reservation"], "Conflicts remain an explicit choice even after a slot becomes free")
        occupied.deleted=False;occupied.save()
        self.assertEqual((occupied.start,occupied.end),(time(17),time(18)))
        response=self.post("/api/goals/",{"period":"week","date":"2026-10-12","action":"reserve",
            "reservation_date":"2026-10-09","start":"18:15","minutes":40})
        self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(response.json()["reservation"]["end_time"],"18:55")
        self.client.get("/api/state/")
        self.assertEqual(Block.objects.get(goal_plan__period="week",goal_plan__date=date(2026,10,12)).start,time(18,15))

    def test_removing_a_reservation_is_not_undone_by_later_visits(self):
        self.configure()
        self.post("/api/goals/",{"period":"week","date":"2026-10-12","action":"remove_reservation"})
        for _ in range(2):self.client.get("/api/state/")
        self.assertIsNone(self.detail("week","2026-10-12")["reservation"])

    def test_disabling_rule_preserves_manual_reservations_and_tracked_history(self):
        self.configure()
        self.post("/api/goals/",{"period":"week","date":"2026-10-12","action":"reserve",
            "reservation_date":"2026-10-09","start":"18:15","minutes":25})
        self.configure(enabled=())
        self.assertIsNotNone(self.detail("week","2026-10-12")["reservation"])
        self.assertFalse(Block.objects.filter(kind="planning",planning_auto=True,deleted=False).exists())

    def test_invalid_rules_are_atomic_and_invalid_weekdays_are_rejected(self):
        settings=self.client.get("/api/planning-settings/").json()
        for days in [[],[True],[7],[0,0],"weekdays"]:
            self.assertEqual(self.post("/api/planning-settings/",{**settings,"workdays":days}).status_code,400)
        settings["rules"][1]["minutes"]=0
        self.assertEqual(self.post("/api/planning-settings/",settings).status_code,400)
        self.assertFalse(PlanningRule.objects.exists())

    def test_weekly_prompt_follows_the_configured_logical_day_reset(self):
        self.prefs.day_rollover=time(4);self.prefs.save()
        before=datetime(2026,11,2,1,0,tzinfo=timezone.utc)
        after=datetime(2026,11,2,3,0,tzinfo=timezone.utc)
        with patch("focus.views.timezone.now",return_value=before):
            old=self.client.get("/api/state/").json()["planning"]
        with patch("focus.views.timezone.now",return_value=after):
            new=self.client.get("/api/state/").json()["planning"]
        self.assertEqual(old["weekly"]["date"],"2026-10-26")
        self.assertEqual(new["weekly"]["date"],"2026-11-02")

    def test_changing_daily_weekdays_preserves_fixed_occurrence_exceptions(self):
        base={"title":"Selected days","kind":"meeting","frequency":"daily","weekday":0,"weekdays":[0,2,4],
              "interval_weeks":1,"anchor_date":"2026-10-07","start":"10:00","end":"11:00"}
        self.post("/api/recurrences/",base)
        template=BlockTemplate.objects.get(user=self.user)
        self.client.get("/api/history/?start=2026-10-08&end=2026-10-14")
        occurrence=Block.objects.get(template=template,occurrence_date=date(2026,10,9))
        response=self.post(f"/api/blocks/{occurrence.id}/",{"date":"2026-10-10","start":"10:00","end":"11:00","kind":"meeting","title":"Fixed exception"})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.post(f"/api/recurrences/{template.id}/",{**base,"weekdays":[1,3]}).status_code,200)
        self.client.get("/api/history/?start=2026-10-08&end=2026-10-14")
        self.assertEqual(set(Block.objects.filter(template=template).values_list("date",flat=True)),
                         {date(2026,10,8),date(2026,10,10),date(2026,10,13)})

    def test_daily_schedules_only_materialize_selected_weekdays(self):
        response=self.post("/api/recurrences/",{"title":"Selected days","kind":"meeting","frequency":"daily",
            "weekday":0,"weekdays":[0,2,4],"interval_weeks":1,"anchor_date":"2026-10-07","start":"10:00","end":"11:00"})
        self.assertEqual(response.status_code,200,response.content)
        template=BlockTemplate.objects.get(user=self.user)
        self.assertEqual(list(occurrence_days(template,date(2026,10,8),date(2026,10,14))),[date(2026,10,9),date(2026,10,12),date(2026,10,14)])
        self.client.get("/api/history/?start=2026-10-08&end=2026-10-14")
        self.assertEqual(set(Block.objects.filter(template=template).values_list("date",flat=True)),{date(2026,10,9),date(2026,10,12),date(2026,10,14)})

    def test_disjoint_daily_and_weekly_schedules_can_share_a_time(self):
        base={"title":"First","kind":"meeting","frequency":"daily","weekday":0,"weekdays":[0,2,4],
              "interval_weeks":1,"anchor_date":"2026-10-07","start":"10:00","end":"11:00"}
        self.assertEqual(self.post("/api/recurrences/",base).status_code,200)
        self.assertEqual(self.post("/api/recurrences/",{**base,"title":"Tue Thu","weekdays":[1,3]}).status_code,200)
        self.assertEqual(self.post("/api/recurrences/",{**base,"title":"Saturday","frequency":"weekly","weekday":5}).status_code,200)
        self.assertEqual(self.post("/api/recurrences/",{**base,"title":"Overlap","weekdays":[2]}).status_code,409)
