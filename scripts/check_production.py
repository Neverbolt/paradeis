"""Smoke-test production templates and collected assets without a database."""

import os


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paradeis.settings")
    import django

    django.setup()
    from django.conf import settings
    from django.contrib.auth.models import AnonymousUser
    from django.contrib.staticfiles.storage import staticfiles_storage
    from django.template.loader import render_to_string
    from django.test import Client, RequestFactory

    if settings.DEBUG:
        raise RuntimeError("Run this check with DEBUG=0.")
    client = Client(HTTP_HOST="localhost")
    response = client.get("/login/", secure=True)
    assert response.status_code == 200, f"Production login failed: {response.status_code}"
    request = RequestFactory().get("/", secure=True)
    request.user = AnonymousUser()
    shell = render_to_string("focus/app.html", request=request)
    assert 'class="sidebar"' in shell
    for asset in ("app.css", "app.js", "icon.svg", "sw.js"):
        url = staticfiles_storage.url(asset)
        response = client.get(url, secure=True)
        assert response.status_code == 200, (
            f"Production asset failed: {url} ({response.status_code})"
        )
        response.close()
    response = client.get("/sw.js", secure=True)
    assert response.status_code == 200
    print("Production templates, service worker, and manifest assets pass with DEBUG=0.")


if __name__ == "__main__":
    main()
