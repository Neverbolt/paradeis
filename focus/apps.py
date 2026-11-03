from django.apps import AppConfig
from django.contrib.auth.signals import user_logged_out


class FocusConfig(AppConfig):
    name = "focus"

    def ready(self):
        from .push import logout_device
        user_logged_out.connect(logout_device, dispatch_uid="companion-logout")
