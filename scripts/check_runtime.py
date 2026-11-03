"""Verify the default container starts both the web server and push worker."""
import os
import time
import urllib.error
import urllib.request


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paradeis.settings")
    import django
    django.setup()
    from django.utils import timezone
    from focus.models import PushIdentity
    from focus.push import identity

    for _ in range(100):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/health/", timeout=1) as response:
                if response.status == 200:
                    break
        except (OSError, urllib.error.URLError):
            time.sleep(.2)
    else:
        raise RuntimeError("The container's web server did not become healthy.")
    identity("https://localhost")
    for _ in range(50):
        key = PushIdentity.objects.get(pk=1)
        if key.worker_seen_at and (timezone.now() - key.worker_seen_at).total_seconds() < 10:
            print("Web server and independent companion notification worker are healthy.")
            return
        time.sleep(.2)
    raise RuntimeError("The companion notification worker did not check in.")


if __name__ == "__main__":
    main()
