"""Send due companion alerts independently of browser activity."""
import logging
import signal
import threading

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from focus.push import poll


class Command(BaseCommand):
    help = "Deliver companion push notifications (run continuously alongside the web server)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")

    def handle(self, *args, **options):
        stopped = threading.Event()
        if not options["once"]:
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda *_: stopped.set())
        while not stopped.is_set():
            try:
                close_old_connections()
                poll()
            except Exception as error:
                # Endpoint URLs, encryption keys, and task text must not enter logs.
                logging.getLogger("django.push").error("Companion notification worker could not complete a poll (%s)", type(error).__name__)
                if options["once"]:
                    raise
            finally:
                close_old_connections()
            if options["once"]:
                return
            stopped.wait(2)
