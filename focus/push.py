"""Opt-in companion push. HTTP delivery never runs inside a timer transaction."""
import base64
import json
import logging
import re
from datetime import timedelta
from urllib.parse import urlsplit
from uuid import uuid4

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from py_vapid import Vapid, VapidException
from pywebpush import WebPushException, webpush

from .models import PushDelivery, PushIdentity, PushSubscription, Session

logger = logging.getLogger("django.push")
COOKIE = "paradeis-companion"
WINDOW = timedelta(seconds=90)


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def identity(subject):
    existing = PushIdentity.objects.filter(pk=1).first()
    if existing:
        return existing
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    der = private.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return PushIdentity.objects.get_or_create(pk=1, defaults={"private_key": b64(der), "public_key": b64(public), "subject": subject})[0]


def valid_endpoint(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("Invalid notification endpoint.")
    url = urlsplit(value)
    host = url.hostname or ""
    known = (host in {"fcm.googleapis.com", "android.googleapis.com"}
             or host.endswith(".push.services.mozilla.com") or host == "push.services.mozilla.com"
             or host.endswith(".push.apple.com") or host.endswith(".notify.windows.com"))
    if url.scheme != "https" or not known or url.port not in (None, 443) or url.username or url.password or url.fragment or not url.path:
        raise ValueError("Choose a supported browser notification service.")
    return value


def subscription_keys(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid browser subscription.")
    endpoint = valid_endpoint(data.get("endpoint"))
    keys = data.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("Missing notification keys.")
    decoded = {}
    for name, length in [("p256dh", 65), ("auth", 16)]:
        value = keys.get(name)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}={0,2}", value):
            raise ValueError("Invalid notification keys.")
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        if len(raw) != length:
            raise ValueError("Invalid notification keys.")
        decoded[name] = b64(raw)
        if name == "p256dh":
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    return endpoint, decoded


def current_subscription(request):
    pk = request.get_signed_cookie(COOKIE, default="", salt="companion")
    if not pk.isdecimal():
        return None
    return PushSubscription.objects.filter(pk=int(pk), user=request.user).first()


def logout_device(sender, request, user, **kwargs):
    if request is not None and user is not None:
        subscription = current_subscription(request)
        if subscription:
            subscription.delete()


def queue_test(subscription, now):
    PushDelivery.objects.create(subscription=subscription, key=f"test:{uuid4().hex}", kind="test", event_at=now,
        title="Paradeis companion connected", body="Timer starts and finishes will arrive on this device.",
        next_attempt_at=now, expires_at=now + WINDOW)


def discover(now):
    """Observe live timers, including deadlines when every browser is closed."""
    subscriptions = list(PushSubscription.objects.all())
    if not subscriptions:
        return
    by_user = {}
    for sub in subscriptions:
        by_user.setdefault(sub.user_id, []).append(sub)
    recent = now - WINDOW
    sessions = Session.objects.filter(user_id__in=by_user, notify_live=True).filter(
        Q(started_at__gte=recent, status__in=["running", "paused"])
        | Q(status="running", deadline__range=(recent, now))
        | Q(status="completed", ended_at__range=(recent, now)))
    for session in sessions:
        events = []
        name = "Meeting" if session.kind == "meeting" else "Focus"
        if session.status in ["running", "paused"] and recent <= session.started_at <= now:
            events.append(("start", session.started_at, f"{name} started"))
        end = session.ended_at if session.status == "completed" else session.deadline if session.status == "running" else None
        if end and recent <= end <= now:
            events.append(("end", end, f"{name} complete"))
        for kind, at, title in events:
            for sub in by_user[session.user_id]:
                if at < sub.created_at:
                    continue
                prefix = "notified" if kind == "end" else "started"
                key = f"{prefix}:{session.id}:{at.isoformat()}"
                PushDelivery.objects.get_or_create(subscription=sub, key=key, defaults={
                    "session": session, "kind": kind, "event_at": at, "title": title, "body": session.title,
                    "next_attempt_at": now, "expires_at": at + WINDOW})


def still_current(delivery):
    if delivery.kind == "test":
        return True
    session = delivery.session
    if not session or not session.notify_live or session.user_id != delivery.subscription.user_id:
        return False
    if delivery.kind == "start":
        return session.status in ["running", "paused"] and session.started_at == delivery.event_at
    return ((session.status == "running" and session.deadline == delivery.event_at)
            or (session.status == "completed" and session.ended_at == delivery.event_at))


class PushHTTPSession(requests.Session):
    def post(self, url, *args, **kwargs):
        valid_endpoint(url)
        kwargs["allow_redirects"] = False
        return super().post(url, *args, **kwargs)


def send(delivery, key, now):
    vapid = Vapid.from_string(key.private_key)
    # The subject is our own validated HTTPS site URI. py-vapid's legacy strict
    # regex rejects valid URI paths (and development hosts).
    vapid.conf["no-strict"] = True
    with PushHTTPSession() as http:
        response = webpush(subscription_info={"endpoint": delivery.subscription.endpoint,
            "keys": {"p256dh": delivery.subscription.p256dh, "auth": delivery.subscription.auth}},
            data=json.dumps({"title": delivery.title, "body": delivery.body, "tag": delivery.key}),
            vapid_private_key=vapid, vapid_claims={"sub": key.subject},
            ttl=max(1, int((delivery.expires_at - now).total_seconds())), timeout=8,
            headers={"Urgency": "high"}, requests_session=http)
        if not 200 <= response.status_code < 300:
            raise WebPushException("Push service rejected the notification", response=response)


def deliver(now, sender=send, clock=None):
    key = PushIdentity.objects.filter(pk=1).first()
    if not key:
        return
    PushDelivery.objects.filter(finished_at__isnull=True, expires_at__lte=now).update(finished_at=now, outcome="expired")
    ids = list(PushDelivery.objects.filter(finished_at__isnull=True, next_attempt_at__lte=now)
               .order_by("next_attempt_at", "id").values_list("id", flat=True)[:50])
    for pk in ids:
        if clock is not None:
            now = clock()
        # The conditional write is a short lease, so two workers cannot send a
        # pending event at once. No SQLite transaction is held during HTTPS.
        with transaction.atomic():
            claimed = PushDelivery.objects.filter(pk=pk, finished_at__isnull=True, next_attempt_at__lte=now).update(
                attempts=F("attempts") + 1, next_attempt_at=now + timedelta(seconds=30))
            if not claimed:
                continue
            delivery = PushDelivery.objects.select_related("subscription", "session").get(pk=pk)
        if delivery.expires_at <= now:
            PushDelivery.objects.filter(pk=pk).update(finished_at=now, outcome="expired")
            continue
        if not still_current(delivery):
            PushDelivery.objects.filter(pk=pk).update(finished_at=now, outcome="discarded")
            continue
        try:
            sender(delivery, key, now)
        except (WebPushException, VapidException, requests.RequestException, ValueError, OSError) as error:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None)
            if status in (404, 410):
                PushSubscription.objects.filter(pk=delivery.subscription_id).delete()
                continue
            permanent = status is not None and 400 <= status < 500 and status not in (408, 429)
            if permanent or delivery.attempts >= 4:
                PushDelivery.objects.filter(pk=pk).update(finished_at=now, outcome="failed")
                logger.warning("Companion push failed for delivery %s (HTTP %s)", pk, status)
            else:
                retry = (2, 10, 30)[min(delivery.attempts - 1, 2)]
                PushDelivery.objects.filter(pk=pk).update(next_attempt_at=now + timedelta(seconds=retry))
        else:
            PushDelivery.objects.filter(pk=pk).update(finished_at=now, outcome="sent")


def poll(now=None, sender=send):
    realtime = now is None
    now = now or timezone.now()
    PushIdentity.objects.filter(pk=1).filter(Q(worker_seen_at__isnull=True) | Q(worker_seen_at__lt=now - timedelta(seconds=15))).update(worker_seen_at=now)
    discover(now)
    deliver(now, sender, clock=timezone.now if realtime else None)
    PushDelivery.objects.filter(expires_at__lt=now - timedelta(days=2)).delete()
