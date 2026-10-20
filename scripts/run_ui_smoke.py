"""Run the DOM/HTTP check against a fresh, disposable local database."""

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix=".paradeis-ui-", dir=root) as temporary:
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = dict(
            os.environ,
            DEBUG="1",
            ALLOWED_HOSTS="localhost,127.0.0.1",
            DATABASE_PATH=str(Path(temporary) / "test.sqlite3"),
            PARADEIS_TEST_USER="ui-smoke",
            PARADEIS_TEST_PASSWORD="disposable-ui-test-password",
            PARADEIS_TEST_URL=base,
            PARADEIS_SCHEDULING_ONLY="1" if "--scheduling" in sys.argv else "",
        )
        subprocess.run(
            [sys.executable, "manage.py", "migrate", "--noinput"],
            cwd=root,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        # Keep UI fixtures around local noon, with planned pomos
        # available even when CI runs after the default workday has ended.
        fixture_timezone = f"Etc/GMT{datetime.now(timezone.utc).hour - 12:+d}"
        fixture_preferences = (
            f"; from focus.models import Preferences; Preferences.objects.create(user=user, timezone={fixture_timezone!r})"
        )
        subprocess.run(
            [
                sys.executable,
                "manage.py",
                "shell",
                "-c",
                "from django.db import connection; assert 'django_session' in connection.introspection.table_names(); from django.contrib.auth import get_user_model; user = get_user_model().objects.create_user('ui-smoke', password='disposable-ui-test-password')" + fixture_preferences,
            ],
            cwd=root,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        with tempfile.TemporaryFile() as log:
            server = subprocess.Popen(
                [sys.executable, "manage.py", "runserver", f"127.0.0.1:{port}", "--noreload"],
                cwd=root,
                env=env,
                stdout=log,
                stderr=log,
            )
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError("Local test server exited.")
                    try:
                        urllib.request.urlopen(f"{base}/health/", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("Local test server did not become ready.")
                subprocess.run(
                    [
                        "node",
                        "scripts/browser_smoke.cjs"
                        if "--browser" in sys.argv
                        else "scripts/ui_smoke.cjs",
                    ],
                    cwd=root,
                    env=env,
                    check=True,
                    timeout=180,
                )
            except Exception:
                log.seek(0)
                print(log.read().decode(), file=sys.stderr)
                raise
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == "__main__":
    main()
