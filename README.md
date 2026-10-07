# Paradeis

A quiet pomodoro workspace for seeing **time, tasks, and effort** together.

Paradeis pairs a large timer and a lightweight intention list with a day timeline. Reserve meetings and lunch, focus in the gaps, then use the break to notice what happened. The week view puts seven day timelines side by side, with daily, weekly, and monthly reflections.

## What it does

- **Focus timer:** 25/5 by default, with a 15-minute break every four focus sessions. All durations and workday hours are configurable. Start, pause, resume, finish early, or discard. The first unfinished task is captured when a session starts.
- **Day planner:** reserve meeting and break blocks. Full pomodoros are projected into free gaps; short unusable gaps are left open. Planned time never counts as completed work. Start a meeting during its reserved time to track the remaining block as one uninterrupted session.
- **Break-time reviews:** revise the task after a session, split it across up to ten tasks with percentages, add a short reflection, and rate effort from **0–5 sand**. Zero effort and unrated are distinct. Task names are snapshotted so later renames don't rewrite history.
- **History:** browse days or horizontally scroll a seven-day overview. Previous/next week navigation fetches only that week, with indexed date-range queries. Completed sessions remain editable.
- **Reflections:** separate notes for each day, Monday-based week, and calendar month. Notes save explicitly, with unsaved-change prompts.
- **Private accounts:** host-created users, Django password hashing and validation, database sessions, CSRF protection, login throttling, and user-scoped queries. No analytics, third-party fonts, external scripts, or public signup.

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

The workflow runs the backend test suite inside the built image before pushing anything. Concurrent publishing runs are serialized, and `latest` is pushed last. Pull requests and feature branches never update the image watched by production. The initial publish happens after this application and workflow are merged into `main`.

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
- Effort is a subjective whole-session rating, not a productivity score. Task percentages describe how the session was divided; totals count the effort once, not once per task. An unrated session contributes time but no sand until reviewed.
- The calendar uses your configured IANA timezone (initially Europe/Brussels). UTC timestamps keep timers correct across daylight saving changes. Nonexistent or ambiguous block times are rejected. Historical blocks preserve their timezone; session day grouping is fixed when started. Changing timezone requires finishing an active timer and removing upcoming reservations first.
- Week notes belong to Monday. The month reflection in a weekly view belongs to the month containing that Monday, shown beside the editor.
- Tasks are a small persistent queue. Complete, rename, move to the top, or archive them. Archived tasks disappear from the queue but remain in existing session allocations. There are no categories, recurring tasks, or backlog automation yet.
- Notifications and alarms are not included in this first version. The tab title shows the running countdown, and finishing opens the review when the page is active.

## Checks

```sh
DEBUG=1 python manage.py test
DEBUG=1 python manage.py makemigrations --check --dry-run
DEBUG=1 python manage.py collectstatic --noinput
node --check static/app.js
```

The backend suite covers timer recovery, pause accounting, repeat completion, long-break cadence, schedule conflicts, meetings, task snapshots/splits, timezone transitions, bounded history, private notes, authentication, CSRF, rate limiting, and cross-user access. CI also checks production settings and builds the Docker image.

An optional DOM/HTTP smoke test exercises the actual browser JavaScript against a local running server. Install `jsdom` with `npm install --no-save --package-lock=false jsdom@26`, create a fresh disposable account, then run `node scripts/ui_smoke.cjs` with `PARADEIS_TEST_USER` and `PARADEIS_TEST_PASSWORD` in the environment. `PARADEIS_TEST_URL` defaults to `http://127.0.0.1:8000`. This creates test data and checks interactions and persistence; it does not replace visual testing in a browser.

## Structure and extension points

```text
paradeis/       Django configuration and URL routing
focus/models.py Separate tasks, sessions, allocations, reservations, and notes
focus/services.py Timer accounting and gap-based planning
focus/views.py Authenticated JSON endpoints and input validation
templates/      Login, account settings, and app shell
static/         Responsive CSS and dependency-free browser UI
```

SQLite transactions use `IMMEDIATE` mode to serialize writes; a conditional unique database constraint enforces one running/paused session per user. The session/task relationship is a separate allocation model, so future categories, projects, recurring intentions, or richer effort distributions can be added without flattening historical data. For a larger deployment, move to PostgreSQL and replace the SQLite transaction strategy with row-level locking before adding multiple workers or replicas.
