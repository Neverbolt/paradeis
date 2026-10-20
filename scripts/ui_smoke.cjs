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
let pendingApiCalls = 0;
const appIntervals = new Set();
const notifications = [];
let delayNextNote = false, delayedNote, overrideToday, overrideState, boundaryStart;

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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // A large calendar render can occupy the event loop past the deadline.
  // Check its final DOM once before reporting a missing result.
  if (await check()) return;
  throw new Error(
    `Timed out: ${label}. ${dom?.window.document.getElementById("error")?.textContent || ""} ` +
    `Calendar days: ${dom?.window.document.querySelectorAll(".calendar-day").length}; JS errors: ${errors.join("; ")}`,
  );
}

function checkWorkWrappingUI(w) {
  const time = offset => new Date(Date.now() + offset * 60000).toISOString();
  const entry = (id, title, start, end, extra = {}) => ({id, title,
    start: time(start), end: time(end), kind: "focus", ...extra});
  const day = {date: w.eval("state.today"), blocks: [
    entry(301, "Strategy", -30, 30, {kind: "work"}),
    entry(302, "Operations", 30, 60, {kind: "work"}),
    entry(303, "Empty reservation", 90, 120, {kind: "work"}),
    entry(401, "Call", 5, 15, {kind: "meeting"}),
  ], sessions: [
    entry(101, "Before Work", -45, -35, {status: "completed", elapsed: 600, effort: 0}),
    entry(102, "Another topic", -25, -5, {status: "completed", elapsed: 1200, effort: 0}),
    entry(103, "After Work", 60, 70, {status: "completed", elapsed: 600, effort: 0}),
  ], plan: [entry(501, "Break", 15, 20, {kind: "break"}),
    entry(502, "Operations", 30, 55)]};
  // Reuse exact boundaries rather than independently rounded timestamps.
  day.blocks[1].start = day.blocks[0].end;
  day.plan[1].start = day.blocks[1].start;
  day.sessions[2].start = day.blocks[1].end;
  for (const dashboard of [true, false]) {
    const container = w.document.createElement("div");
    container.id = dashboard ? "timeline" : "overview-test";
    w.renderTimeline(container, day);
    const groups = container.querySelectorAll(".work-reservation");
    assert.equal(groups.length, 3);
    assert.equal(groups[0].querySelectorAll(".timeline-row").length, dashboard ? 3 : 2);
    assert.equal(groups[1].querySelectorAll(".timeline-row").length, 1);
    assert.equal(groups[2].querySelectorAll(".timeline-row").length, 0);
    assert.equal(container.querySelectorAll(".timeline-row").length, dashboard ? 6 : 5);
    const card = title => [...container.querySelectorAll(".timeline-item")]
      .find(node => node.querySelector("p")?.textContent === title);
    assert.equal(card("Before Work").closest(".work-reservation"), null);
    assert.equal(card("After Work").closest(".work-reservation"), null);
    assert.equal(card("Another topic").closest(".work-reservation"), groups[0]);
    assert.equal(card("Another topic").className, card("Before Work").className);
    assert.equal(card("Call").closest(".work-reservation"), groups[0]);
    assert.equal(card("Operations").closest(".work-reservation"), groups[1]);
    assert.equal(container.querySelector(".now-marker").closest(".work-reservation"), groups[0]);
    assert.equal(groups[0].querySelector(".work-reservation-range").textContent,
      `${w.clock(day.blocks[0].start)}–${w.clock(day.blocks[0].end)}`);
    assert.equal(container.firstElementChild, card("Before Work").parentElement);
    assert.equal(groups[1].nextElementSibling, card("After Work").parentElement);
    assert.equal(container.querySelectorAll('.timeline-end').length, 1);
    assert.equal(container.querySelector('.timeline-end .timeline-time').textContent, w.clock(day.blocks[2].end));
  }
}

async function checkFocusRatingsUI(w) {
  const $ = id => w.document.getElementById(id);
  let session = (await w.api("state/")).day.sessions.find(s => s.kind === "focus" && s.status === "completed");
  if (!session) {
    const started = await w.api("timer/", {action: "start", ignore_break: true});
    await w.api("timer/", {action: "finish", id: started.id});
    session = (await w.api("state/")).day.sessions.find(s => s.id === started.id);
  }
  await w.refresh();
  w.openReview(session);
  assert.equal($("focus-control").children.length, 3);
  assert(!$("review-focus").hidden);
  assert(!$("review-dialog").querySelector('.review-footer').textContent.includes('/'));
  const choices = [...$("focus-control").children];
  assert.deepEqual(choices.map(b => b.querySelector('i').style.getPropertyValue('--lens-size')), ['7px', '10px', '13px']);
  choices[0].click();
  $("focus-control").children[1].click();
  assert.equal($("focus-control").getAttribute('aria-label'), 'Focus 2 out of 3');
  $("focus-control").children[1].click();
  assert.equal($("focus-control").getAttribute('aria-label'), 'Focus 0 out of 3');
  $("review-form").requestSubmit();
  await waitFor(() => !$("review-dialog").open && w.eval('!busy'), 'save zero focus');
  session = (await w.api("state/")).day.sessions.find(s => s.id === session.id);
  assert.equal(session.focus_score, 0);
  w.openReview(session);
  assert.equal($("focus-control").querySelectorAll('[aria-pressed="true"]').length, 0);
  $("focus-control").children[2].click();
  $("review-form").requestSubmit();
  await waitFor(() => !$("review-dialog").open && w.eval('!busy'), 'save three lenses');
  const saved = (await w.api("state/")).day.sessions.find(s => s.id === session.id);
  assert.equal(saved.focus_score, 3);
  assert.equal(saved.effort, session.effort ?? 0);
  const icons = $("timeline").querySelector('.focus-lenses[aria-label="Focus 3 out of 3"]');
  assert.equal(icons.children.length, 3);
  assert.equal(icons.parentElement.lastElementChild.className, 'sand-pile');
  w.openReview(saved);
  assert.equal($("focus-control").querySelectorAll('[aria-pressed="true"]').length, 3);
  $("review-dialog").close();
}

async function checkSchedulingUI(w) {
  checkWorkWrappingUI(w);
  const pattern = (id, start, end) => ({id, start, end});
  const lanes = w.recurrenceLayout([pattern(1, "09:00", "12:00"), pattern(2, "09:00", "10:30"),
    pattern(3, "10:30", "12:00"), pattern(4, "12:00", "14:00")]);
  assert(lanes.slice(0, 3).every(item => item.columns === 2));
  assert.equal(lanes[3].columns, 1, "Adjacent clusters use the full width");
  const tiny = w.recurrenceLayout([pattern(1, "09:00", "09:05"), pattern(2, "09:05", "09:10")]);
  assert.equal(tiny[0].columns, 2, "Short cards cannot cover nearby cards");
  const dates = w.recurrenceMonthDates({frequency: "weekly", weekday: 2, interval_weeks: 4,
    anchor_date: "2026-09-09", effective_from: "2026-09-09"}, "2026-10-20");
  assert.deepEqual(Array.from(dates), ["2026-10-07"], "Four-week patterns show this month's actual dates");
  const $ = id => w.document.getElementById(id);
  const note = $("day-note");
  note.value = "Keyboard-saved day note\nSecond line";
  note.dispatchEvent(new w.Event("input", {bubbles: true}));
  for (const modifiers of [{}, {ctrlKey: true, isComposing: true}, {ctrlKey: true, repeat: true}]) {
    const event = new w.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true, ...modifiers});
    note.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal($("day-note-status").textContent, "Unsaved");
  }
  note.dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", ctrlKey: true, bubbles: true, cancelable: true}));
  await waitFor(() => $("day-note-status").textContent === "Saved", "Ctrl+Enter saves the day note");
  assert.equal((await w.api(`notes/?period=day&date=${w.eval("selectedDay")}`)).text, note.value);
  // Exercise real Work defaults, a newly reserved meeting, and manual breaks.
  await w.api("timer/", {action: "skip_break"});
  await w.api("timer/", {action: "configure_auto", auto_focus: false, auto_break: true});
  await checkFocusRatingsUI(w);
  await w.api("timer/", {action: "skip_break"});
  await w.refresh();
  const workStart = Math.floor(Date.parse((await w.api("state/")).now) / 60000) * 60000;
  const workEnd = workStart + 60 * 60000;
  if (w.localDate(workStart) === w.localDate(workEnd)) {
    await w.api("blocks/", {kind: "work", title: "Strategy", date: w.localDate(workStart),
      start: w.clock(workStart), end: w.clock(workEnd)});
    await w.refresh();
    assert.equal($("timer-task").textContent, "Strategy");
    assert($("timeline").querySelector(".work-reservation"));
    assert(!$("timeline").querySelector(".reserved.work"));
    assert(w.document.querySelector('#block-kind option[value="work"]'));
    assert(w.document.querySelector('#repeat-kind option[value="work"]'));
    $("auto-break").checked = false;
    $("auto-break").dispatchEvent(new w.Event("change"));
    await waitFor(() => w.eval("!busy && !state.preferences.auto_break"), "manual-break preference");
    $("timer-main").click();
    await waitFor(() => $("timer-main").textContent === "Pause" && w.eval("!busy"), "start Work focus");
    const beforeMeeting = (await w.api("state/")).active;
    assert.equal(beforeMeeting.title, "Strategy");
    assert.equal(beforeMeeting.kind, "focus");
    const meetingStart = workStart + 10 * 60000;
    const meetingEnd = meetingStart + 10 * 60000;
    await w.api("blocks/", {kind: "meeting", title: "Strategy call", date: w.localDate(meetingStart),
      start: w.clock(meetingStart), end: w.clock(meetingEnd)});
    await w.refresh();
    assert(Date.parse((await w.api("state/")).active.end) < Date.parse(beforeMeeting.end));
    $("timer-finish").click();
    await waitFor(() => $("review-dialog").open && w.eval("!busy"), "finish shortened Work focus");
    $("review-dialog").close();
    assert.equal($("timer-main").textContent, "Start break");
    $("timer-main").click();
    await waitFor(() => $("timer-main").textContent === "Skip break" && w.eval("!busy"), "start manual break");
    $("auto-focus").checked = true;
    $("auto-focus").dispatchEvent(new w.Event("change"));
    await waitFor(() => w.eval("!busy && state.preferences.auto_focus"), "quick auto-focus toggle");
    assert.equal((await w.api("state/")).preferences.auto_focus, true);
    $("timer-main").click();
    await waitFor(() => w.eval("!busy && !!state.active"), "automatically start focus after skipping the break");
    assert.equal((await w.api("state/")).active.title, "Strategy");
    $("timer-cancel").click();
    await waitFor(() => w.eval("!busy && !state.active"), "discard stops the automatic cycle");
    assert.equal((await w.api("state/")).can_auto_start, false);
    $("auto-focus").checked = false;
    $("auto-focus").dispatchEvent(new w.Event("change"));
    await waitFor(() => w.eval("!busy && !state.preferences.auto_focus"), "stop automatic cycle");
    await w.loadDayNote();
  }
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
      const nativeInterval = window.setInterval.bind(window);
      window.setInterval = (...args) => {
        const id = nativeInterval(...args);
        appIntervals.add(id);
        return id;
      };
      window.fetch = async (url, options) => {
        if (overrideState && String(url).endsWith("/api/timer/")) {
          boundaryStart = JSON.parse(options.body);
          return {ok: true, status: 200, json: async () => ({ok: true})};
        }
        if (overrideState && String(url).includes("/api/state/")) {
          const snapshot = overrideState();
          return { ok: true, status: 200, json: async () => snapshot };
        }
        let response = await fetchWithCookies(url, options);
        if (overrideToday && String(url).includes("/api/state/")) {
          const data = await response.json();
          data.today = overrideToday;
          data.day.date = new URL(url, base).searchParams.get("date") || overrideToday;
          response = { ok: true, status: 200, json: async () => data };
        }
        if (delayNextNote && String(url).includes("/api/notes/?")) {
          delayNextNote = false;
          await new Promise(resolve => { delayedNote = resolve; });
        }
        return response;
      };
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
        if (!this.open) return;
        this.open = false;
        this.dispatchEvent(new window.Event("close"));
      };
    },
  });
  const w = dom.window;
  await waitFor(() => typeof w.api === 'function', 'application script ready');
  const originalApi = w.api;
  w.api = async (...args) => {
    pendingApiCalls++;
    try { return await originalApi(...args); }
    finally { pendingApiCalls--; }
  };
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
  if (process.env.PARADEIS_SCHEDULING_ONLY === "1") {
    await checkSchedulingUI(w);
    assert.deepEqual(errors, [], "No JavaScript errors");
    console.log("PASS: flexible Work defaults, shortening a running pomo, manual breaks, auto focus, and discard stopping the cycle.");
    return;
  }
  const suffix = Date.now();
  for (const name of [`Write a proposal ${suffix}`, `Review notes ${suffix}`]) {
    $("task-title").value = name;
    submit("task-form");
    await waitFor(() => $("task-title").value === "", "create task");
  }
  const taskInput = $("task-list").querySelector("input.task-title");
  assert.equal(taskInput.value, `Write a proposal ${suffix}`);
  taskInput.focus();
  taskInput.value = `Updated proposal ${suffix}`;
  taskInput.dispatchEvent(new w.Event("input", { bubbles: true }));
  taskInput.blur();
  await waitFor(
    async () =>
      (await (await fetchWithCookies(`${base}/api/state/`)).json()).tasks[0]
        .title === `Updated proposal ${suffix}`,
    "inline task rename",
  );

  const check = $("task-list").querySelector(".task-check");
  check.focus();
  check.click();
  await waitFor(
    () => $("completed-task-list").children.length === 1,
    "focused task completion",
  );
  assert.equal($("task-list").children.length, 1);
  assert(
    $("task-form").compareDocumentPosition($("completed-task-list")) &
      w.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const completedState = await (await fetchWithCookies(base + "/api/state/")).json();
  assert.equal(completedState.day.completed_tasks.length, 1);
  assert.equal(completedState.tasks.find(t => t.done).completed_on, completedState.today);
  await click("overview-view");
  await waitFor(() => w.document.querySelector(".day-completed-tasks"), "completed task in calendar");
  assert(w.document.querySelector(".completed-result").textContent.includes("Updated proposal"));
  await click("today-view");
  $("completed-task-list").querySelector(".task-check").click();
  await waitFor(
    () => $("completed-task-list").children.length === 0,
    "reopen task",
  );
  await waitFor(() => !$("task-list").querySelector(".task-down").disabled, "task controls ready");
  $("task-list").querySelector(".task-down").click();
  await waitFor(() => $("task-list").querySelector(".task-title").value.startsWith("Review notes"), "move task down");
  await waitFor(() => w.document.activeElement.className === "task-handle", "focus after reorder");
  await w.refresh();
  assert($("task-list").querySelector(".task-title").value.startsWith("Review notes"));
  $("task-list").children[1].querySelector('[aria-label="Move to top"]').click();
  await waitFor(() => $("task-list").querySelector(".task-title").value.startsWith("Updated proposal"), "move task to top");
  await click("settings-open");
  $("tab-title-mode").value = "completion";
  $("tab-title-mode").dispatchEvent(new w.Event("change"));
  assert.equal(w.localStorage.getItem("tab-title-mode"), "completion");
  $("settings-dialog").close();
  assert.equal(w.document.title, "Paradeis");
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
  assert.equal(w.document.title, "Paradeis", "Countdown does not change the pinned tab title");
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
  assert.equal(w.document.title, "Focus complete · Paradeis");
  await w.refresh();
  assert.equal(w.document.title, "Focus complete · Paradeis", "Refresh retains completion title");
  await click("review-overrun");
  await waitFor(
    () => !$("review-dialog").open && $("timer-main").textContent === "Pause",
    "overrun completed session",
  );
  assert.equal(w.document.title, "Paradeis", "Overrun clears completion alert");
  await click("settings-open");
  assert.equal($("tab-title-mode").value, "completion", "Title preference persists");
  $("tab-title-mode").value = "countdown";
  $("tab-title-mode").dispatchEvent(new w.Event("change"));
  $("settings-dialog").close();
  assert(w.document.title.endsWith(" · Paradeis") && w.document.title !== "Paradeis");
  await click("timer-finish");
  await waitFor(() => $("review-dialog").open, "review after finishing");
  $("review-dialog").close();
  assert(
    $("review-prompt")
      .querySelector("button")
      .textContent.includes(`Updated proposal ${suffix}`),
  );
  $("review-prompt").querySelector("button").click();
  await waitFor(
    () => $("review-dialog").open,
    "entire pending review card clickable",
  );
  const rows = [...w.document.querySelectorAll(".allocation-row")];
  assert.equal(rows.length, 2);
  rows[0].querySelector(".sand-control button:nth-child(3)").click();
  assert(rows[1].querySelector(".sand-control").hidden);
  rows[1].querySelector("input").value = `Review notes ${suffix}`;
  rows[1].querySelector("input").dispatchEvent(new w.Event("input", {bubbles: true}));
  assert(!rows[1].querySelector(".sand-control").hidden);
  assert.equal($("allocations").children.length, 3);
  assert($("allocations").lastElementChild.querySelector(".sand-control").hidden);
  rows[1].querySelector(".sand-control button:nth-child(1)").click();
  assert.equal($("allocation-total").textContent, "4 / 5 sand");
  assert(
    rows[1].querySelector(".sand-control button:nth-child(3)").disabled,
    "Five-sand budget enforced",
  );
  $("review-reflection").value = "Progress";
  $("focus-control").children[1].click();
  $("review-reflection").dispatchEvent(new w.KeyboardEvent("keydown", {
    key: "Enter", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await waitFor(() => !$("review-dialog").open, "save review");
  await waitFor(
    () =>
      $("day-summary")
        .querySelector(".sand-total")
        ?.getAttribute("aria-label") === "4 sand",
    "effort summary",
  );
  assert.equal(notifications.length, 1, "Notification deduplicated");
  assert(
    $("timeline").querySelector(".item-note").textContent.includes("Progress"),
    "Session note visible inline",
  );

  $("day-note").value = `Daily reflection ${suffix}`;
  change("day-note");
  submit("day-note-form");
  await waitFor(
    () => $("day-note-status").textContent === "Saved",
    "save day note",
  );
  delayNextNote = true;
  await w.refresh();
  await waitFor(() => delayedNote, "hold a stale note read");
  $("day-note").value = "Newer saved note";
  change("day-note");
  submit("day-note-form");
  await waitFor(() => $("day-note-status").textContent === "Saved", "save newer note");
  delayedNote();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal($("day-note").value, "Newer saved note");
  assert.equal($("day-note-status").textContent, "Saved", "Stale note read cannot overwrite a save");
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
  await waitFor(() => !$("recurring-view").hidden && $("recurrence-list").textContent.includes(`Lunch ${suffix}`), "recurring week view");
  assert($("day-view").hidden && $("overview").hidden);
  assert.equal($("recurrence-week").querySelectorAll(".recurrence-day").length, 7);
  assert($("recurrence-list").textContent.includes(`Lunch ${suffix}`));
  assert.equal(w.location.pathname, "/recurring");
  await click("recurrence-add");
  $("repeat-title").value = `Daily ${suffix}`;
  $("repeat-frequency").value = "daily";
  $("repeat-frequency").dispatchEvent(new w.Event("change"));
  assert($("repeat-weekly").hidden);
  $("repeat-start").value = "18:00";
  $("repeat-end").value = "18:30";
  submit("recurrence-form");
  await waitFor(
    () =>
      $("recurrence-form").hidden &&
      $("recurrence-list").textContent.includes(`Daily ${suffix}`),
    "create daily schedule",
  );
  $("recurrence-list").querySelector("button").click();
  $("recurrences-dialog").querySelector("[data-close]").click();
  assert(!$("recurrences-dialog").open && !$("recurring-view").hidden);
  assert.equal(w.location.pathname, "/recurring");
  assert.equal($("recurrence-list").querySelectorAll(".recurrence-card").length, 8);
  const schedules = (await w.api("recurrences/")).templates;
  const lunch = schedules.find(t => t.title === `Lunch ${suffix}`);
  await w.api("recurrences/", {...lunch, title: "Alternating lunch", anchor_date: w.shiftDay(lunch.anchor_date, 7)});
  await w.openRecurrences();
  const overlaps = [...$("recurrence-week").querySelectorAll(`.recurrence-day:nth-child(${lunch.weekday + 2}) .recurrence-card`)]
    .filter(card => card.textContent.includes("Lunch") || card.textContent.includes("Alternating lunch"));
  assert.equal(overlaps.length, 2);
  assert.notEqual(overlaps[0].style.left, overlaps[1].style.left, "Alternating patterns get separate lanes");
  assert(overlaps.every(card => card.textContent.includes("Every 2 weeks")));
  for (const card of overlaps) {
    card.click();
    assert($("recurrences-dialog").open);
    $("recurrences-dialog").querySelector("[data-close]").click();
    assert.equal(w.location.pathname, "/recurring");
  }
  await click("overview-view");
  await waitFor(
    () => w.document.querySelectorAll(".calendar-day").length > 90,
    "bounded calendar",
  );
  assert.equal(w.location.pathname, "/overview");
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
    textarea.dispatchEvent(new w.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await waitFor(
      () => group.querySelector(".note-actions").textContent.includes("Saved"),
      `save ${period} note`,
    );
  }
  assert(
    w.document
      .querySelector(".calendar-day .item-note")
      ?.textContent.includes("Progress"),
    "Overview note visible",
  );
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
  assert.equal(note.text, "Newer saved note");
  const tomorrowDay = new Date(saved.today + "T12:00:00Z");
  tomorrowDay.setUTCDate(tomorrowDay.getUTCDate() + 1);
  overrideToday = tomorrowDay.toISOString().slice(0, 10);
  await w.refresh();
  assert($("timeline-date").textContent.includes(String(tomorrowDay.getUTCDate())));
  assert.equal($("task-list").children.length, 2, "Pending tasks survive midnight");
  overrideToday = undefined;
  await w.refresh();
  await w.loadDayNote();
  // A stale pre-meeting snapshot must become actionable at the block's start,
  // even before the ordinary 15-second state poll.
  const realState = await w.api("state/");
  const upcomingMeeting = {id: 987654, kind: "meeting", title: "Boundary meeting",
    start: new Date(Date.now() + 3000).toISOString(),
    end: new Date(Date.now() + 300000).toISOString(), tracked: false};
  overrideState = () => ({...realState, now: new Date().toISOString(),
    active: null, break_until: null, live_block: null, next_block: upcomingMeeting});
  await w.refresh();
  assert.equal($("timer-mode").textContent, "Meeting soon");
  assert($("timer-main").disabled);
  assert.notEqual($("timer-time").textContent, "0:00");
  assert(!$("timer-ignore-break").hidden && !$("timer-ignore-break").disabled);
  await waitFor(() => $("timer-main").textContent === "Start meeting" && !$("timer-main").disabled,
    "meeting starts without waiting for the state poll");
  $("timer-main").click();
  await waitFor(() => boundaryStart && w.eval("!busy"), "meeting start request settled");
  assert.equal(boundaryStart.action, "start");
  assert.equal(boundaryStart.block_id, upcomingMeeting.id);
  overrideState = undefined;
  await w.refresh();
  await waitFor(() => !$("timer-main").disabled, "timer ready after meeting boundary check");
  await w.loadDayNote();
  await waitFor(() => w.eval("!busy"), "mutations settled before closing the test page");
  await checkSchedulingUI(w);
  assert.deepEqual(errors, [], "No JavaScript errors");
  console.log(
    "PASS: login, tasks, timer, pause/resume, freeform sand review, overrun, notification, recurring blocks, bounded calendar, and day/week/month notes.",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!dom) return;
    // Stop polling and let already-started refreshes finish before JSDOM tears
    // down document. Otherwise a successful run can fail in a late callback.
    for (const id of appIntervals) dom.window.clearInterval(id);
    await waitFor(async () => {
      const idle = () => pendingApiCalls === 0 && dom.window.eval('!busy && !loadingCalendar');
      if (!idle()) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
      return idle();
    }, 'background refreshes settled');
    dom.window.close();
  });
