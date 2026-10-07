"""Run the DOM/HTTP check against a fresh, disposable local database."""

import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="paradeis-ui-") as temporary:
        env = dict(
            os.environ,
            DEBUG="1",
            ALLOWED_HOSTS="localhost,127.0.0.1",
            DATABASE_PATH=str(Path(temporary) / "test.sqlite3"),
            PARADEIS_TEST_USER="ui-smoke",
            PARADEIS_TEST_PASSWORD="disposable-ui-test-password",
            PARADEIS_TEST_URL="http://127.0.0.1:8099",
        )
        subprocess.run(
            [sys.executable, "manage.py", "migrate", "--noinput"],
            cwd=root,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        subprocess.run(
            [
                sys.executable,
                "manage.py",
                "shell",
                "-c",
                "from django.contrib.auth import get_user_model; get_user_model().objects.create_user('ui-smoke', password='disposable-ui-test-password')",
            ],
            cwd=root,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        with tempfile.TemporaryFile() as log:
            server = subprocess.Popen(
                [sys.executable, "manage.py", "runserver", "127.0.0.1:8099", "--noreload"],
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
                        urllib.request.urlopen("http://127.0.0.1:8099/health/", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("Local test server did not become ready.")
                subprocess.run(["node", "scripts/ui_smoke.cjs"], cwd=root, env=env, check=True)
            except Exception:
                log.seek(0)
                print(log.read().decode(), file=sys.stderr)
                raise
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == "__main__":
    main()
