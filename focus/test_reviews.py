"""Review hierarchy, reminders, and end-of-day reservation lifecycle."""
import json
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from .models import Block, DayPlan, Note, PeriodGoal, Session
from .services import preferences

NOW = datetime(2026, 11, 9, 9, tzinfo=timezone.utc)

@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class ReviewTests(TestCase):
    def setUp(self):
        self.user=get_user_model().objects.create_user('reviewer')
        self.other=get_user_model().objects.create_user('other-reviewer')
        self.client.force_login(self.user)
        self.prefs=preferences(self.user)
        self.prefs.timezone='UTC';self.prefs.day_end=time(18);self.prefs.save()
        self.clock=patch('django.utils.timezone.now',return_value=NOW);self.clock.start();self.addCleanup(self.clock.stop)

    def post(self,path,data):
        return self.client.post(path,json.dumps(data),content_type='application/json')

    def state(self):return self.client.get('/api/state/').json()
    def block(self):return Block.objects.get(user=self.user,goal_plan__period='day',goal_plan__date=NOW.date())

    def test_daily_defaults_follow_end_and_duration(self):
        self.state();block=self.block()
        self.assertEqual((block.start,block.end,block.title),(time(17,45),time(18),'Daily review'))
        response=self.post('/api/day-hours/',{'date':'2026-11-09','start':'09:00','end':'19:00'})
        self.assertEqual(response.status_code,200)
        block.refresh_from_db();self.assertEqual((block.start,block.end),(time(18,45),time(19)))
        settings=self.client.get('/api/planning-settings/').json();settings['daily_review_minutes']=30
        self.assertEqual(self.post('/api/planning-settings/',settings).status_code,200)
        block.refresh_from_db();self.assertEqual(block.start,time(18,30))

    def test_manual_move_and_cancel_survive_refresh_and_day_changes(self):
        self.state()
        payload={'period':'day','date':'2026-11-09','action':'reserve','reservation_date':'2026-11-09','start':'15:00','minutes':20}
        self.assertEqual(self.post('/api/goals/',payload).status_code,200)
        self.post('/api/day-hours/',{'date':'2026-11-09','start':'09:00','end':'19:00'});self.state()
        block=self.block();self.assertEqual((block.start,block.end,block.planning_auto),(time(15),time(15,20),False))
        self.assertEqual(self.post('/api/goals/',{**payload,'action':'remove_reservation'}).status_code,200)
        self.state();block.refresh_from_db();self.assertTrue(block.deleted)
        self.assertTrue(block.goal_plan.reservation_skipped)

    def test_conflict_waits_for_choice_even_after_slot_clears(self):
        meeting=Block.objects.create(user=self.user,date=NOW.date(),start=time(17,30),end=time(18),timezone='UTC',kind='meeting',title='Call')
        self.state();goal=PeriodGoal.objects.get(user=self.user,period='day',date=NOW.date())
        self.assertTrue(goal.reservation_needs_choice)
        meeting.deleted=True;meeting.save();self.state()
        self.assertFalse(Block.objects.filter(goal_plan=goal,deleted=False).exists())
        self.assertIn('occupied',self.client.get('/api/reviews/?period=day&date=2026-11-09').json()['reservation']['reservation_conflict'])

    def test_end_change_conflict_removes_old_automatic_time(self):
        self.state();block=self.block()
        Block.objects.create(user=self.user,date=NOW.date(),start=time(18,30),end=time(19),timezone='UTC',kind='meeting',title='Call')
        self.post('/api/day-hours/',{'date':'2026-11-09','start':'09:00','end':'19:00'})
        block.refresh_from_db();self.assertTrue(block.deleted);self.assertTrue(block.goal_plan.reservation_needs_choice)

    def test_tracked_daily_review_is_normal_focus_and_does_not_move(self):
        self.state();block=self.block()
        with patch('django.utils.timezone.now',return_value=NOW.replace(hour=17,minute=45)):
            result=self.post('/api/timer/',{'action':'start','block_id':block.id})
            self.assertEqual(result.status_code,201,result.content)
            self.post('/api/day-hours/',{'date':'2026-11-09','start':'09:00','end':'19:00'})
            block.refresh_from_db();self.assertEqual(block.end,time(18))
            self.assertEqual(Session.objects.get(user=self.user).kind,'focus')
            self.assertEqual(self.post('/api/goals/',{'period':'day','date':'2026-11-09','action':'remove_reservation'}).status_code,409)

    def test_daily_review_context_has_no_projected_pomos(self):
        value=self.client.get('/api/reviews/?period=day&date=2026-11-09').json()
        self.assertEqual(value['timeline']['plan'],[])
        self.assertEqual(value['period'],'day')

    def test_week_month_quarter_context_and_privacy(self):
        Note.objects.create(user=self.user,period='day',date=date(2026,11,2),text='Daily reflection')
        Note.objects.create(user=self.user,period='week',date=date(2026,10,26),text='Boundary week')
        Note.objects.create(user=self.user,period='month',date=date(2026,10,1),text='October reflection')
        Note.objects.create(user=self.other,period='day',date=date(2026,11,3),text='PRIVATE')
        weekly=self.client.get('/api/reviews/?period=week&date=2026-11-04').json()
        self.assertEqual(weekly['date'],'2026-11-02');self.assertEqual(len(weekly['context']),7)
        self.assertEqual(weekly['context'][0]['text'],'Daily reflection');self.assertNotIn('PRIVATE',str(weekly))
        monthly=self.client.get('/api/reviews/?period=month&date=2026-11-09').json()
        self.assertEqual(monthly['context'][0]['date'],'2026-10-26');self.assertEqual(monthly['context'][0]['text'],'Boundary week')
        quarterly=self.client.get('/api/reviews/?period=quarter&date=2026-11-09').json()
        self.assertEqual(len(quarterly['context']),3);self.assertEqual(quarterly['context'][0]['text'],'October reflection')

    def recorded(self, day, kind='focus', user=None, status='completed'):
        start=datetime.combine(day,time(10),tzinfo=timezone.utc)
        return Session.objects.create(user=user or self.user,date=day,kind=kind,status=status,
            started_at=start,resumed_at=start,deadline=start+timedelta(minutes=25),
            ended_at=start+timedelta(minutes=25),remaining_seconds=0,planned_seconds=1500,elapsed_seconds=1500)

    def daily_reminders(self):
        return [item for item in self.state()['planning']['reviews'] if item['period']=='day']

    def test_empty_weekend_is_skipped_and_only_latest_active_day_is_considered(self):
        self.recorded(date(2026,11,5))
        self.recorded(date(2026,11,6),kind='meeting')
        DayPlan.objects.create(user=self.user,date=date(2026,11,8))
        Block.objects.create(user=self.user,date=date(2026,11,8),start=time(17),end=time(18),title='Reserved')
        self.recorded(date(2026,11,8),status='cancelled')
        self.recorded(date(2026,11,8),user=self.other)
        self.assertEqual(self.daily_reminders(),[{'period':'day','date':'2026-11-06'}])
        self.post('/api/notes/',{'period':'day','date':'2026-11-06','text':'Reviewed'})
        self.assertEqual(self.daily_reminders(),[])

    def test_notes_only_day_is_activity_and_prevents_older_backlog(self):
        self.recorded(date(2026,11,6))
        Note.objects.create(user=self.user,period='day',date=date(2026,11,7),text='Reflection')
        Note.objects.create(user=self.user,period='day',date=date(2026,11,8),text='   ')
        self.assertEqual(self.daily_reminders(),[])

    def test_empty_account_and_planning_only_days_do_not_prompt(self):
        DayPlan.objects.create(user=self.user,date=date(2026,11,8))
        self.assertEqual(self.daily_reminders(),[])

    def test_current_and_future_days_do_not_replace_previous_activity(self):
        self.recorded(date(2026,10,1))
        self.recorded(NOW.date())
        Note.objects.create(user=self.user,period='day',date=date(2026,11,10),text='Future')
        self.assertEqual(self.daily_reminders(),[{'period':'day','date':'2026-10-01'}])

    def test_missing_period_review_is_reminded_even_when_next_goals_exist(self):
        DayPlan.objects.create(user=self.user,date=date(2026,11,4))
        PeriodGoal.objects.create(user=self.user,period='week',date=date(2026,11,9),text='Next week goals')
        self.assertIn({'period':'week','date':'2026-11-02'},self.state()['planning']['reviews'])

    def test_invalid_review_period_and_invalid_daily_duration(self):
        self.assertEqual(self.client.get('/api/reviews/?period=year&date=2026-11-09').status_code,400)
        settings=self.client.get('/api/planning-settings/').json();settings['daily_review_minutes']=0
        self.assertEqual(self.post('/api/planning-settings/',settings).status_code,400)
        self.prefs.refresh_from_db();self.assertEqual(self.prefs.daily_review_minutes,15)

    def test_disable_daily_review_removes_only_auto_reservation(self):
        self.state();block=self.block()
        settings=self.client.get('/api/planning-settings/').json();settings['daily_review_enabled']=False
        self.assertEqual(self.post('/api/planning-settings/',settings).status_code,200)
        self.state();block.refresh_from_db();self.assertTrue(block.deleted)

    def test_reminders_use_configured_day_rollover(self):
        self.prefs.day_rollover=time(4);self.prefs.save()
        self.recorded(date(2026,11,8))
        with patch('django.utils.timezone.now',return_value=NOW.replace(day=10,hour=3)):
            state=self.state()
        self.assertEqual(state['today'],'2026-11-09')
        self.assertIn({'period':'day','date':'2026-11-08'},state['planning']['reviews'])

    def test_daily_configuration_preserves_manual_slots(self):
        self.state()
        self.post('/api/goals/',{'period':'day','date':'2026-11-09','action':'reserve',
                                'reservation_date':'2026-11-09','start':'15:00','minutes':20})
        settings=self.client.get('/api/planning-settings/').json();settings['daily_review_enabled']=False
        self.post('/api/planning-settings/',settings)
        block=self.block();self.assertFalse(block.deleted);self.assertEqual(block.start,time(15))
