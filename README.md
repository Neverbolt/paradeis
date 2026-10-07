# Paradeis

A quiet pomodoro workspace for seeing **time, tasks, and effort** together.

Paradeis pairs a compact timer and task queue with a day timeline. The logo, view switches, and workspace controls form a slim vertical toolbar, with labels on hover or keyboard focus. The horizontal calendar keeps daily notes below each timeline, Monday-based weekly notes across seven days, and monthly notes across the entire month. Wide summary editors stay within the viewport until the next period takes their place.

## What it does

- **Timers:** 25/5 by default, with a long break every four completed focus or meeting sessions. Click the countdown to edit the next or remaining duration. `+5` extends the current timer; after a natural completion it resumes the same session and counts the intervening time as work.
- **Reservations:** meetings and breaks reserve time. Starting focus automatically leaves a short break before the next block; the small arrow starts without that buffer. Meetings are one uninterrupted tracked session, with task and effort review afterward. Overrun extends only that meeting occurrence and refuses to overlap another reservation.
- **Recurring blocks:** repeat every 1–12 weeks on the chosen weekday. Template changes apply from tomorrow. Today's blocks and elapsed days are frozen; editing or deleting an upcoming occurrence fixes that exception, even if the template's time, weekday, or interval changes. Deleting a schedule preserves fixed occurrences. The original occurrence's Monday-based week suppresses a replacement when its weekday changes.
- **Reviews:** free-form task fields, optional note, and up to five sand tokens shared across the tasks. No percentage splits or required todo selection. Existing reviewed sessions migrate their effort to task tokens without changing the total.
- **History and notes:** the calendar loads a rolling three-month window, aligned to complete Monday-based weeks, with a 112-day API limit. Horizontal scrolling fetches adjacent windows. Explicit saves and retained drafts keep daily, weekly, and monthly notes editable while navigating.
- **Notifications:** browser notifications at a running timer's deadline, with a sidebar toggle. Permission is requested when first starting a session. HTTPS and browser permission are required; keep the tab open. Browser suspension, device sleep, and OS notification policies can delay delivery. This does not use server push for closed tabs.
- **Private accounts:** host-created users, Django password hashing and validation, database sessions, CSRF protection, login throttling, and user-scoped queries. No analytics, external scripts, or public signup.

## Local testing with Docker

```sh
docker compose up -d --build
docker compose exec app python manage.py createuser yourname
```

Open <http://localhost:8000>. The password is requested interactively. The development Compose file binds only to `127.0.0.1`; it is deliberately not a public deployment configuration. Data lives in the `paradeis-data` Docker volume and survives container rebuilds. `docker compose down -v` removes it.

## Local development without Docker

Python 3.12 or 3.13 is supported. No JavaScript build step is needed.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export DEBUG=1
python manage.py migrate
python manage.py createuser yourname
python manage.py runserver
```

SQLite defaults to `db.sqlite3`. Use `DATABASE_PATH` to select another file. Settings start in production mode unless `DEBUG=1` is explicitly set; `manage.py` does not load `.env` automatically.

## Deploy on the internet

The separate production Compose file runs a non-root Gunicorn application behind Caddy with automatic HTTPS. It does **not** expose the app port. DNS must point your chosen domain at the host, and ports 80/443 must be reachable.

1. Copy `.env.example` to `.env`. Set `DOMAIN` to a hostname only (no scheme or path).
2. Generate a unique secret with `python -c "import secrets; print(secrets.token_urlsafe(64))"` and put it in `SECRET_KEY`. Keep `.env` private; it is ignored by Git.
3. Start and create an account:

   ```sh
   docker compose -f compose.prod.yaml up -d --build
   docker compose -f compose.prod.yaml exec app python manage.py createuser yourname
   docker compose -f compose.prod.yaml exec app python manage.py check --deploy --fail-level WARNING
   ```

4. Visit `https://your-domain`. Verify login, start/finish a session, and reload to confirm persistence.

Use only the production file for this stack; do not combine it with the development Compose file. The default project volume name is shared if both stacks run from the same directory, so use a different Compose project name (`-p paradeis-prod`) if you need separate development and production data on one host. Add that flag consistently to all later commands.

Production settings require a random secret of at least 50 characters and explicit allowed hosts. HTTPS redirects, secure session/CSRF cookies, HSTS, a strict Content Security Policy, and clickjacking protection are enabled. `TRUST_PROXY=1` is intended only for an isolated backend behind a proxy that overwrites `X-Forwarded-Proto`, as the supplied Caddy configuration does. Never expose that backend directly. HSTS includes subdomains; use a dedicated hostname whose subdomains also use HTTPS.

The built-in login limit is 10 attempts per username and 30 per connecting IP in 15 minutes, stored in SQLite so it applies across workers. Behind a proxy, the IP bucket covers that proxy; the username bucket remains independent. For larger multi-user deployments, add per-client rate limiting at your trusted ingress. The supplied stack is sized for personal use or a small team, with one Gunicorn worker and four threads. Keep framework/container security updates current and review changes before rebuilding. No deployment or TLS certificate is created merely by pushing this repository.

## Published image and Watchtower

The `.github/workflows/publish-docker.yaml` workflow builds on every push to `main`, and can also be run manually from the Actions tab on `main`. It follows the publishing pattern in [Neverbolt/year](https://github.com/Neverbolt/year/blob/main/.github/workflows/publish-docker.yaml): authenticate to GHCR with the built-in `GITHUB_TOKEN`, then push a timestamp tag and `latest`. It also publishes `sha-<full commit SHA>` for identifying or rolling back a build.

The workflow runs the backend test suite and a production template/static-file smoke check inside the built image before pushing anything. Static files are collected with `DEBUG=0` so the production manifest exists; production exceptions are logged to container stderr. Concurrent publishing runs are serialized, and `latest` is pushed last. Pull requests and feature branches never update the image watched by production. The initial publish happens after this application and workflow are merged into `main`.

Your existing service can keep using:

```yaml
paradeis:
  image: ghcr.io/neverbolt/paradeis:latest
  restart: unless-stopped
  labels:
    - com.centurylinklabs.watchtower.enable=true
```

Keep your production environment variables, network/proxy settings, and persistent `/data` volume alongside that configuration. On a successful publish, your Watchtower instance checks for the new `latest` image on its configured 300-second interval. Its mounted `/config.json` must contain GHCR credentials with pull access if the package is private. No additional publishing secret is needed in Actions; the workflow grants `packages: write` to `GITHUB_TOKEN`.

The image runs migrations at startup. Preserve and back up `/data` across replacements. To roll back, select a previous timestamp or SHA tag; database schema changes may also require restoring a compatible backup.


### Account maintenance

- Users can change their password in Settings.
- Host-side recovery: `python manage.py changepassword yourname` inside the app container.
- There is no email-based recovery, public registration, or exposed admin interface.
- Periodically run `python manage.py clearsessions` inside the app container to remove expired sessions.

### Backups and restores

Use SQLite's online backup API rather than copying an actively written database. For example:

```sh
docker compose -f compose.prod.yaml exec app python -c \
  "import sqlite3; source=sqlite3.connect('/data/paradeis.sqlite3'); dest=sqlite3.connect('/data/backup.sqlite3'); source.backup(dest); dest.close(); source.close()"
docker compose -f compose.prod.yaml cp app:/data/backup.sqlite3 ./paradeis-backup.sqlite3
```

Protect the backup: it contains private notes and password hashes. Store backups off the host. To restore, stop the app, replace `/data/paradeis.sqlite3` in its volume from a known-good backup, ensure UID/GID `10001:10001` owns it, then start the app and run migrations. Practice restoration before relying on a backup strategy. Back up the Caddy data volume as well if you want to preserve its certificate state.

## Behavior worth knowing

- Server timestamps are authoritative. The browser draws a countdown from the deadline and synchronizes every 15 seconds and on return to the tab. No WebSocket, queue, or background scheduler is needed.
- If a tab sleeps or closes, its running session completes at its original deadline on the next authenticated API request. No additional focus sessions are invented. The break starts at the completion timestamp, so returning hours later doesn't start a fresh break.
- Pomos and meetings start **manually**. A reserved meeting is a plan until you start tracking it. Meetings cannot pause; finish early if you leave. Finishing a meeting preserves its original reservation until the scheduled end.
- Pauses do not accrue work time. A resumed pomo must still fit before the next reserved block. Finish early or adjust the block if it no longer fits. A session's timeline spans wall-clock start/end, while its displayed work duration excludes pauses.
- A timer can run outside the configured workday. Workday hours define the suggested schedule, not a hard restriction on working. Overnight sessions belong to their starting local day. Reserved blocks must begin and end on the same local day.
- Effort is the sum of task sand, capped at five for the entire session. Zero and unreviewed are distinct. An unreviewed session contributes time but no sand.
- The calendar uses your configured IANA timezone (initially Europe/Brussels). UTC timestamps keep timers correct across daylight saving changes. Nonexistent or ambiguous block times are rejected. Historical blocks preserve their timezone; session day grouping is fixed when started. Changing timezone requires finishing an active timer and removing upcoming reservations first.
- Week notes belong to Monday; month notes belong to the first calendar day. Recurring wall times that are nonexistent or ambiguous at a daylight-saving transition skip that occurrence; one-off invalid times are rejected.
- Tasks are a small persistent queue. Complete, rename, move to the top, or archive them. Archived tasks disappear from the queue but remain in existing session allocations. There are no categories, recurring tasks, or backlog automation yet.
- The tab title shows the countdown. Completion notifications are deduplicated across tabs; finishing opens the compact review when the page is active.

## Checks

```sh
DEBUG=1 python manage.py test
DEBUG=1 python manage.py makemigrations --check --dry-run
DEBUG=0 ALLOWED_HOSTS=localhost SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(64))')" python manage.py collectstatic --noinput
node --check static/app.js
```

The backend suite covers timer recovery, pause accounting, repeat completion, long-break cadence, schedule conflicts, meetings, task snapshots and sand totals, recurrence exceptions and freezing, overrun/resize accounting, migration preservation, timezone transitions, bounded history, private notes, authentication, CSRF, rate limiting, and cross-user access. CI also checks production settings and builds the Docker image.

CI also runs a DOM/HTTP smoke test with the actual application JavaScript against a disposable local server (`python scripts/run_ui_smoke.py`). It mocks browser notification delivery and checks notification requests and deduplication, rather than OS delivery or browser layout. Install `jsdom` with `npm install --no-save --package-lock=false jsdom@26`, create a fresh disposable account, then run `node scripts/ui_smoke.cjs` with `PARADEIS_TEST_USER` and `PARADEIS_TEST_PASSWORD` in the environment. `PARADEIS_TEST_URL` defaults to `http://127.0.0.1:8000`. This creates test data and checks interactions and persistence; it does not replace visual testing in a browser.

## Structure and extension points

```text
paradeis/       Django configuration and URL routing
focus/models.py Separate tasks, sessions, allocations, reservations, and notes
focus/services.py Timer accounting and gap-based planning
focus/recurrence.py Recurring templates, fixed occurrences, and deletion exceptions
focus/views.py Authenticated JSON endpoints and input validation
templates/      Login, account settings, and app shell
static/         Responsive CSS and dependency-free browser UI
```

SQLite transactions use `IMMEDIATE` mode to serialize writes; a conditional unique database constraint enforces one running/paused session per user. The session/task relationship is a separate allocation model, so future categories, projects, recurring intentions, or richer effort distributions can be added without flattening historical data. For a larger deployment, move to PostgreSQL and replace the SQLite transaction strategy with row-level locking before adding multiple workers or replicas.
