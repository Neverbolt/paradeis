/* Exercise the real application JS against a running LOCAL Django server.
   Requires optional `jsdom` (npm install --no-save --package-lock=false jsdom@26).
   Use a disposable account: this script creates tasks, sessions, blocks, and notes.
   It checks DOM interactions and real HTTP persistence, not browser layout. */
const assert = require("node:assert/strict");
const { JSDOM, CookieJar, VirtualConsole } = require("jsdom");

const base = process.env.PARADEIS_TEST_URL || "http://127.0.0.1:8000";
const username = process.env.PARADEIS_TEST_USER;
const password = process.env.PARADEIS_TEST_PASSWORD;
assert(
  ["127.0.0.1", "localhost"].includes(new URL(base).hostname),
  "Only run against a local test server",
);
assert(
  username && password,
  "Set PARADEIS_TEST_USER and PARADEIS_TEST_PASSWORD for a disposable test account",
);
const jar = new CookieJar();
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => errors.push(e.message));
let dom;
const notifications = [];

async function fetchWithCookies(url, options = {}) {
  const target = new URL(url, base).href;
  const response = await fetch(target, {
    ...options,
    headers: { ...options.headers, Cookie: jar.getCookieStringSync(target) },
  });
  for (const cookie of response.headers.getSetCookie())
    jar.setCookieSync(cookie, target);
  return response;
}
async function waitFor(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out: ${label}. ${dom?.window.document.getElementById("error")?.textContent || ""}`,
  );
}

(async () => {
  const login = await JSDOM.fromURL(`${base}/login/`, { cookieJar: jar });
  const csrf = login.window.document.querySelector(
    "[name=csrfmiddlewaretoken]",
  ).value;
  const response = await fetchWithCookies(`${base}/login/`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      username,
      password,
      csrfmiddlewaretoken: csrf,
    }),
  });
  assert.equal(response.status, 302, "Login should succeed");
  login.window.close();
  dom = await JSDOM.fromURL(base, {
    cookieJar: jar,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetchWithCookies;
      window.Notification = class {
        static permission = "granted";
        static requestPermission() {
          return Promise.resolve("granted");
        }
        constructor(title, options) {
          notifications.push({ title, options });
        }
        close() {}
      };

      window.confirm = () => true;
      window.prompt = () => null;
      // JSDOM has no native dialog implementation or layout engine.
      window.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
    },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  const click = async (id) => {
    await waitFor(() => !$(id).disabled, `${id} ready`);
    $(id).click();
  };
  const submit = (id) =>
    $(id).dispatchEvent(
      new w.Event("submit", { bubbles: true, cancelable: true }),
    );
  const change = (id) =>
    $(id).dispatchEvent(new w.Event("input", { bubbles: true }));
  await waitFor(() => $("timeline").children.length > 0, "initial state");
  const suffix = Date.now();
  for (const name of [`Write a proposal ${suffix}`, `Review notes ${suffix}`]) {
    $("task-title").value = name;
    submit("task-form");
    await waitFor(() => $("task-title").value === "", "create task");
  }
  assert($("task-list").textContent.includes(`Write a proposal ${suffix}`));
  await click("timer-time");
  $("duration-input").value = "10";
  submit("duration-form");
  await waitFor(() => $("duration-form").hidden, "edit next duration");
  assert.equal($("timer-time").textContent, "10:00");
  await click("timer-main");
  await waitFor(
    () => $("timer-main").textContent.includes("Pause"),
    "start timer",
  );
  await click("timer-main");
  await waitFor(
    () => $("timer-main").textContent.includes("Resume"),
    "pause timer",
  );
  await click("timer-main");
  await waitFor(
    () => $("timer-main").textContent.includes("Pause"),
    "resume timer",
  );
  await click("timer-time");
  $("duration-input").value = "0:01";
  submit("duration-form");
  await waitFor(
    () => $("review-dialog").open,
    "automatic completion and review",
  );
  await waitFor(() => notifications.length === 1, "completion notification");
  await click("review-overrun");
  await waitFor(
    () => !$("review-dialog").open && $("timer-main").textContent === "Pause",
    "overrun completed session",
  );
  await click("timer-finish");
  await waitFor(() => $("review-dialog").open, "review after finishing");
  await click("allocation-add");
  const rows = [...w.document.querySelectorAll(".allocation-row")];
  assert.equal(rows.length, 2);
  rows[0].querySelector(".sand-control button:nth-child(3)").click();
  rows[1].querySelector("input").value = `Review notes ${suffix}`;
  rows[1].querySelector(".sand-control button:nth-child(1)").click();
  assert.equal($("allocation-total").textContent, "4 / 5 sand");
  assert(
    rows[1].querySelector(".sand-control button:nth-child(3)").disabled,
    "Five-sand budget enforced",
  );
  $("review-reflection").value = "Progress";
  submit("review-form");
  await waitFor(() => !$("review-dialog").open, "save review");
  await waitFor(
    () => $("day-summary").textContent.includes("4 sand"),
    "effort summary",
  );
  assert.equal(notifications.length, 1, "Notification deduplicated");
  $("day-note").value = `Daily reflection ${suffix}`;
  change("day-note");
  submit("day-note-form");
  await waitFor(
    () => $("day-note-status").textContent === "Saved",
    "save day note",
  );
  await click("block-open");
  assert.equal(
    Number($("block-start").value.split(":")[1]) % 5,
    0,
    "Block start rounded to five minutes",
  );
  $("block-repeat").checked = true;
  $("block-interval").value = "2";
  $("block-kind").value = "break";
  $("block-name").value = `Lunch ${suffix}`;
  const tomorrow = new Date($("block-date").value + "T12:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  $("block-date").value = tomorrow.toISOString().slice(0, 10);
  $("block-start").value = "12:00";
  $("block-end").value = "13:00";
  submit("block-form");
  await waitFor(() => !$("block-dialog").open, "reserve lunch");
  await click("recurrences-open");
  await waitFor(() => $("recurrences-dialog").open, "recurring blocks");
  assert($("recurrence-list").textContent.includes(`Lunch ${suffix}`));
  $("recurrences-dialog").close();
  await click("overview-view");
  await waitFor(
    () => w.document.querySelectorAll(".calendar-day").length > 90,
    "bounded calendar",
  );
  assert(w.document.querySelectorAll(".calendar-day").length <= 112);
  assert.equal(w.document.querySelectorAll(".period-group.month").length, 3);
  for (const group of w.document.querySelectorAll(".period-group.week")) {
    assert(group.style.gridColumn.includes("span 7"));
    const day = group.dataset.period.split(":")[1];
    assert.equal(
      new Date(`${day}T12:00:00Z`).getUTCDay(),
      1,
      "Week starts Monday",
    );
  }
  for (const [period, text] of [
    ["week", "Weekly"],
    ["month", "Monthly"],
  ]) {
    const group = w.document.querySelector(`.period-group.${period}`);
    const textarea = group.querySelector("textarea");
    textarea.value = `${text} reflection ${suffix}`;
    textarea.dispatchEvent(new w.Event("input", { bubbles: true }));
    group
      .querySelector("form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await waitFor(
      () => group.querySelector(".note-actions").textContent.includes("Saved"),
      `save ${period} note`,
    );
  }
  const before = $("calendar-label").textContent;
  await click("month-prev");
  await waitFor(
    () => $("calendar-label").textContent !== before,
    "previous month",
  );
  const saved = await (await fetchWithCookies(`${base}/api/state/`)).json();
  assert(
    saved.day.sessions.some(
      (s) => s.effort === 4 && s.allocations.length === 2,
    ),
  );
  const note = await (
    await fetchWithCookies(`${base}/api/notes/?period=day&date=${saved.today}`)
  ).json();
  assert.equal(note.text, `Daily reflection ${suffix}`);
  assert.deepEqual(errors, [], "No JavaScript errors");
  console.log(
    "PASS: login, tasks, timer, pause/resume, freeform sand review, overrun, notification, recurring blocks, bounded calendar, and day/week/month notes.",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => dom?.window.close());
