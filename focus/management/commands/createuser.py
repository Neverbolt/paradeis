from getpass import getpass

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Create a regular Paradeis account; never puts its password in shell history."

    def add_arguments(self, parser):
        parser.add_argument("username")

    def handle(self, *args, **options):
        user = get_user_model()(username=options["username"])
        try:
            user.full_clean(exclude=["password"])
            password = getpass("Password: ")
            if password != getpass("Password again: "):
                raise CommandError("Passwords did not match.")
            validate_password(password, user=user)
        except ValidationError as error:
            raise CommandError(" ".join(error.messages)) from error
        user.set_password(password)
        user.save()
        self.stdout.write(self.style.SUCCESS(f"Created account: {user.username}"))
