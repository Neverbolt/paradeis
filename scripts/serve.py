"""Run the web server and companion worker together in the existing container."""
import signal
import subprocess
import sys
import threading


def main():
    subprocess.run([sys.executable, "manage.py", "migrate", "--noinput"], check=True)
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    children = []
    code = 0
    try:
        children.append(subprocess.Popen([sys.executable, "manage.py", "sendpush"]))
        children.append(subprocess.Popen([sys.executable, "-m", "gunicorn", "paradeis.wsgi:application",
            "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "45",
            "--access-logfile", "-", "--error-logfile", "-"]))
        while not stopped.wait(.5):
            if any(child.poll() is not None for child in children):
                # Restart the container if either essential process exits.
                code = 1
                break
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return code


if __name__ == "__main__":
    sys.exit(main())
