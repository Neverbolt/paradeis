from django.contrib.auth import views as auth
from django.urls import path

from focus import views

urlpatterns = [
    path("", views.home, name="home"),
    path("login/", views.ThrottledLoginView.as_view(), name="login"),
    path("logout/", auth.LogoutView.as_view(), name="logout"),
    path(
        "password/",
        auth.PasswordChangeView.as_view(
            template_name="registration/password_change.html", success_url="/"
        ),
        name="password_change",
    ),
    path("health/", views.health),
    path("api/state/", views.state),
    path("api/history/", views.history),
    path("api/tasks/", views.task_create),
    path("api/tasks/<int:pk>/", views.task_update),
    path("api/timer/", views.timer),
    path("api/sessions/<int:pk>/review/", views.review),
    path("api/blocks/", views.block_save),
    path("api/blocks/<int:pk>/", views.block_save),
    path("api/notes/", views.notes),
    path("api/settings/", views.settings_save),
]
