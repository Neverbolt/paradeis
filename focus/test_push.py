"""Companion consent, private subscriptions, and real timer event delivery."""
import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from pywebpush import WebPushException

from . import push
from .models import PushDelivery, PushIdentity, PushSubscription, Session
from .services import preferences, record_focus
from .tests import NOW


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class CompanionPushTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("push-user")
        self.other = get_user_model().objects.create_user("other-push")
        self.client.force_login(self.user)
        self.prefs = preferences(self.user)
        self.prefs.daily_review_enabled = False
        self.prefs.save(update_fields=["daily_review_enabled"])
        self.clock = patch("focus.views.timezone.now", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        config = self.client.get("/api/push/").json()
        self.subscription = {"endpoint": "https://fcm.googleapis.com/wp/test-device",
            "keys": {"p256dh": config["public_key"], "auth": "AAAAAAAAAAAAAAAAAAAAAA"}}

    def post(self, data):
        return self.client.post("/api/push/", json.dumps(data), content_type="application/json")

    def connect(self, endpoint=None):
        subscription = {**self.subscription}
        if endpoint:
            subscription["endpoint"] = endpoint
        response = self.post({"action": "subscribe", "subscription": subscription, "label": "Test phone"})
        self.assertEqual(response.status_code, 200, response.content)
        return PushSubscription.objects.get(endpoint=subscription["endpoint"])

    def timer(self, action, **extra):
        return self.client.post("/api/timer/", json.dumps({"action": action, **extra}), content_type="application/json")

    def start(self):
        response = self.timer("start")
        self.assertEqual(response.status_code, 201)
        return Session.objects.get(id=response.json()["id"])

    def test_configuration_does_not_expose_private_keys_and_survives_reloads(self):
        first = self.client.get("/api/push/").json()
        second = self.client.get("/api/push/").json()
        self.assertEqual(first["public_key"], second["public_key"])
        self.assertNotIn("private_key", first)
        self.assertNotIn(PushIdentity.objects.get().private_key, json.dumps(first))
        self.assertFalse(first["enabled"])
        self.connect()
        self.assertTrue(self.client.get("/api/push/").json()["enabled"])
        self.assertTrue(self.client.cookies[push.COOKIE]["httponly"])
        self.connect()
        self.assertEqual(PushSubscription.objects.count(), 1)

    def test_other_accounts_cannot_adopt_or_remove_a_device(self):
        self.connect()
        self.client.force_login(self.other)
        self.assertFalse(self.client.get("/api/push/").json()["enabled"])
        self.assertEqual(self.post({"action": "subscribe", "subscription": self.subscription}).status_code, 409)
        self.post({"action": "unsubscribe"})
        self.assertEqual(PushSubscription.objects.count(), 1)
        self.client.logout()
        self.assertEqual(self.client.get("/api/push/").status_code, 401)

    def test_logout_and_explicit_disconnect_stop_future_delivery(self):
        sub = self.connect()
        push.queue_test(sub, NOW)
        self.client.post("/logout/")
        self.assertFalse(PushSubscription.objects.exists())
        self.assertFalse(PushDelivery.objects.exists())
        self.client.force_login(self.user)
        self.connect()
        self.assertEqual(self.post({"action": "unsubscribe"}).status_code, 200)
        self.assertFalse(PushSubscription.objects.exists())
        self.assertFalse(self.client.get("/api/push/").json()["enabled"])

    def test_only_known_https_push_endpoints_and_real_curve_keys_are_accepted(self):
        for endpoint in ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.test/x",
                         "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://example.com/x"]:
            data = {**self.subscription, "endpoint": endpoint}
            self.assertEqual(self.post({"action": "subscribe", "subscription": data}).status_code, 400)
        for keys in [{}, {"auth": "AA", "p256dh": self.subscription["keys"]["p256dh"]},
                     {"auth": "AAAAAAAAAAAAAAAAAAAAAA", "p256dh": push.b64(b'\x04' + b'\x00'*64)}]:
            self.assertEqual(self.post({"action": "subscribe", "subscription": {**self.subscription, "keys": keys}}).status_code, 400)
        self.assertFalse(PushSubscription.objects.exists())
        for url in ["https://web.push.apple.com/test", "https://updates.push.services.mozilla.com/wpush/v2/test",
                    "https://bn1.notify.windows.com/w/?token=test"]:
            self.assertEqual(push.valid_endpoint(url), url)

    def test_start_and_end_are_deduplicated_and_do_not_need_a_browser_poll(self):
        self.connect()
        session = self.start()
        sender = Mock()
        push.poll(NOW, sender)
        push.poll(NOW + timedelta(seconds=2), sender)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[0].title, "Focus started")
        push.poll(session.deadline, sender)
        self.assertEqual(sender.call_count, 2)
        self.assertEqual(sender.call_args.args[0].title, "Focus complete")
        session.refresh_from_db()
        self.assertEqual(session.status, "running", "The worker does not change timer or auto-start semantics")
        with patch("focus.views.timezone.now", return_value=session.deadline):
            self.client.get("/api/state/")
        push.poll(session.deadline + timedelta(seconds=2), sender)
        self.assertEqual(sender.call_count, 2, "Settling the timer cannot send the completion twice")

    def test_pause_resize_resume_and_cancel_invalidate_old_deadlines(self):
        self.connect()
        session = self.start()
        self.timer("pause", id=session.id)
        sender = Mock()
        push.poll(session.deadline, sender)
        self.assertFalse(sender.called)
        self.timer("resize", id=session.id, seconds=120)
        self.timer("resume", id=session.id)
        session.refresh_from_db()
        push.poll(session.deadline, sender)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[0].kind, "end")
        self.timer("cancel", id=session.id)
        push.poll(NOW + timedelta(minutes=25), sender)
        self.assertEqual(sender.call_count, 1)

    def test_manual_finish_notifies_but_recording_past_work_does_not(self):
        self.connect()
        session = self.start()
        sender = Mock()
        at = NOW + timedelta(minutes=3)
        with patch("focus.views.timezone.now", return_value=at):
            self.timer("finish", id=session.id)
        push.poll(at, sender)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[0].kind, "end")
        # A manual record ending in the current notification window remains historical.
        record_focus(self.user, self.prefs, at + timedelta(minutes=1), at, 1, "Past work")
        push.poll(at + timedelta(minutes=1), sender)
        self.assertEqual(sender.call_count, 1)

    def test_late_device_connection_receives_only_upcoming_completions(self):
        session = self.start()
        with patch("focus.views.timezone.now", return_value=NOW + timedelta(minutes=2)):
            self.connect()
        sender = Mock()
        push.poll(NOW + timedelta(minutes=2), sender)
        self.assertFalse(sender.called)
        push.poll(session.deadline, sender)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[0].kind, "end")

    def test_each_subscribed_device_receives_one_alert(self):
        self.connect()
        # A second cookie jar represents a second browser/phone.
        self.client.cookies.pop(push.COOKIE)
        self.connect("https://web.push.apple.com/test-device")
        self.start()
        sender = Mock()
        push.poll(NOW, sender)
        self.assertEqual(sender.call_count, 2)
        self.assertEqual(len({call.args[0].subscription_id for call in sender.call_args_list}), 2)

    def test_test_alert_is_rate_limited_and_queued_for_this_device_only(self):
        self.assertEqual(self.post({"action": "test"}).status_code, 400)
        sub = self.connect()
        self.assertEqual(self.post({"action": "test"}).status_code, 200)
        self.assertEqual(self.post({"action": "test"}).status_code, 400)
        delivery = PushDelivery.objects.get()
        self.assertEqual(delivery.subscription, sub)
        sender = Mock()
        push.poll(NOW, sender)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[0].kind, "test")

    def test_transient_errors_retry_and_expired_subscriptions_are_removed(self):
        sub = self.connect()
        push.queue_test(sub, NOW)
        sender = Mock(side_effect=requests.Timeout("private endpoint must not enter logs"))
        push.poll(NOW, sender)
        delivery = PushDelivery.objects.get()
        self.assertIsNone(delivery.finished_at)
        self.assertEqual(delivery.attempts, 1)
        push.poll(NOW + timedelta(seconds=1), sender)
        self.assertEqual(sender.call_count, 1)
        sender.side_effect = None
        push.poll(NOW + timedelta(seconds=2), sender)
        self.assertEqual(sender.call_count, 2)
        delivery.refresh_from_db()
        self.assertEqual(delivery.outcome, "sent")
        push.queue_test(sub, NOW)
        sender.side_effect = WebPushException("expired", response=SimpleNamespace(status_code=410))
        push.poll(NOW, sender)
        self.assertFalse(PushSubscription.objects.exists())

    def test_stale_events_are_not_delivered_after_an_outage(self):
        sub = self.connect()
        push.queue_test(sub, NOW)
        session = self.start()
        sender = Mock()
        push.poll(session.deadline + timedelta(minutes=10), sender)
        self.assertFalse(sender.called)
        self.assertEqual(PushDelivery.objects.get().outcome, "expired")

    def test_queued_completion_is_rechecked_before_a_retry(self):
        self.connect()
        session = self.start()
        failing = Mock(side_effect=requests.Timeout())
        push.poll(session.deadline, failing)
        # Timer was extended while its notification was waiting for a retry.
        Session.objects.filter(pk=session.id).update(deadline=session.deadline + timedelta(minutes=5))
        sender = Mock()
        push.poll(session.deadline + timedelta(seconds=2), sender)
        self.assertFalse(sender.called)
        self.assertEqual(PushDelivery.objects.get(kind="end").outcome, "discarded")

    def test_payload_is_encrypted_signed_and_sent_without_redirects(self):
        sub = self.connect()
        push.queue_test(sub, NOW)
        delivery = PushDelivery.objects.get()
        key = PushIdentity.objects.get()
        with patch.object(requests.Session, "post", return_value=SimpleNamespace(status_code=201, text="", headers={})) as post:
            push.send(delivery, key, NOW)
        args, kwargs = post.call_args
        self.assertEqual(args[0], sub.endpoint)
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["timeout"], 8)
        self.assertNotIn(delivery.body.encode(), kwargs["data"])
        self.assertIn("authorization", {h.lower() for h in kwargs["headers"]})
