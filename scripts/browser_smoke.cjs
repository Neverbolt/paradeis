/* Real-browser layout checks against a disposable LOCAL server. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");
const base = process.env.PARADEIS_TEST_URL;
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
fs.mkdirSync("test-results", { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  async function waitFor(predicate, arg) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await page.evaluate(predicate, arg)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for browser state");
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/login/`);
    await page.locator("#id_username").fill(process.env.PARADEIS_TEST_USER);
    await page.locator("#id_password").fill(process.env.PARADEIS_TEST_PASSWORD);
    await Promise.all([
      page.waitForURL(`${base}/`),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.waitForSelector(".current-time");
    await page.bringToFront();
    await waitFor(() => !document.documentElement.classList.contains("window-unfocused"));
    // Headless Chromium keeps page focus emulated across tabs; exercise the
    // OS window events directly and verify their rendered effect.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await waitFor(() => document.documentElement.classList.contains("window-unfocused"));
    assert.equal(await page.locator("#timer-seconds").evaluate(el => getComputedStyle(el).opacity), "0.18");
    assert.equal(await page.locator("#timer-minutes").evaluate(el => getComputedStyle(el).opacity), "1");
    await page.screenshot({path: "test-results/unfocused-timer.png"});
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => !document.documentElement.classList.contains("window-unfocused"));
    assert.equal(await page.locator("#timer-seconds").evaluate(el => getComputedStyle(el).opacity), "1");
    await page.locator("#task-title").fill("Browser task");
    await page.locator("#task-form button").click();
    await page.waitForSelector("#task-list .task-check");
    await page.locator("#task-list .task-check").click();
    await page.waitForSelector("#completed-task-list .checked");
    assert.equal(await page.locator("#task-list .task-row").count(), 0);
    await page.locator("#overview-view").click();
    await page.waitForSelector(".completed-result");
    assert((await page.locator(".completed-result").first().textContent()).includes("Browser task"));
    await page.locator("#today-view").click();
    await page.locator("#completed-task-list .task-check").click();
    await page.waitForSelector("#task-list .task-check");
    assert.equal(
      await page.locator("#completed-task-list .task-row").count(),
      0,
    );
    await page.locator("#task-title").fill("Second browser task");
    await page.locator("#task-form button").click();
    await waitFor(() => document.querySelectorAll("#task-list .task-row").length === 2);
    await waitFor(() => document.querySelector("#task-list .task-handle").draggable);
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/api/tasks/reorder/") && r.status() === 200),
      page.locator("#task-list .task-handle").nth(1).dragTo(
        page.locator("#task-list .task-row").first(), {targetPosition: {x: 15, y: 3}}),
    ]);
    await waitFor(() => document.querySelector("#task-list .task-title").value === "Second browser task");
    await page.reload();
    await page.waitForSelector("#task-list .task-row");
    assert.equal(await page.locator("#task-list .task-title").first().inputValue(), "Second browser task");
    await page.locator("#task-list .task-up").nth(1).click();
    await waitFor(() => document.querySelector("#task-list .task-title").value === "Browser task");
    // Exercise the clock boundary independently of the real wall-clock hour.
    await page.evaluate(async () => {
      const snapshot = await (await fetch("/api/state/")).json();
      const nativeFetch = window.fetch;
      window.restoreMeetingFetch = () => { window.fetch = nativeFetch; };
      const block = {id: 987654, kind: "meeting", title: "Boundary meeting",
        start: new Date(Date.now() + 1500).toISOString(),
        end: new Date(Date.now() + 300000).toISOString(), tracked: false};
      window.fetch = async (url, options) => {
        if (String(url).includes("/api/state/")) return new Response(JSON.stringify({
          ...snapshot, now: new Date().toISOString(), active: null,
          break_until: null, live_block: null, next_block: block}), {status: 200});
        if (String(url).endsWith("/api/timer/")) {
          window.boundaryMeetingRequest = JSON.parse(options.body);
          return new Response(JSON.stringify({ok: true}), {status: 200});
        }
        return nativeFetch(url, options);
      };
      await refresh();
    });
    assert.equal(await page.locator("#timer-mode").textContent(), "Meeting soon");
    assert(await page.locator("#timer-main").isDisabled());
    await waitFor(() => document.querySelector("#timer-main").textContent === "Start meeting" &&
      !document.querySelector("#timer-main").disabled);
    await page.locator("#timer-main").click();
    await waitFor(() => window.boundaryMeetingRequest && !document.querySelector("#timer-main").disabled);
    assert.deepEqual(await page.evaluate(() => window.boundaryMeetingRequest), {action: "start", block_id: 987654});
    await page.evaluate(async () => { window.restoreMeetingFetch(); await refresh(); });
    await page.locator("#overview-view").click();
    await page.waitForURL(base + "/overview");
    await page.waitForSelector(".calendar-day");
    await page.locator("#settings-open").click();
    await page.waitForURL(base + "/settings");
    assert.equal(
      await page.locator("#settings-dialog #notifications-toggle").count(),
      1,
    );
    await page.goBack();
    await page.waitForURL(base + "/overview");
    await waitFor(
      () => !document.querySelector("#settings-dialog").open,
    );
    await page.goForward();
    await page.waitForURL(base + "/settings");
    await waitFor(
      () => document.querySelector("#settings-dialog").open,
    );
    await page.locator("#settings-dialog [data-close]").click();
    await page.waitForURL(base + "/overview");
    await page.locator("#recurrences-open").click();
    await page.waitForURL(base + "/recurring");
    await page.locator("#recurrence-add").click();
    await page.locator("#repeat-title").fill("Browser daily");
    await page.locator("#repeat-frequency").selectOption("daily");
    await page.locator("#repeat-start").fill("22:00");
    await page.locator("#repeat-end").fill("22:30");
    await page.locator("#recurrence-form button[type=submit]").click();
    await waitFor(
      () =>
        document.querySelector("#recurrence-form").hidden &&
        document
          .querySelector("#recurrence-list")
          .textContent.includes("Browser daily"),
    );
    await page.locator("#recurrence-list button").click();
    await page.locator("#recurrences-dialog [data-close]").click();
    assert(await page.locator("#recurrences-dialog").evaluate((d) => d.open));
    assert.equal(new URL(page.url()).pathname, "/recurring");
    await page.locator("#recurrences-dialog [data-close]").click();
    await page.waitForURL(base + "/overview");
    await page.locator("#home-link").click();
    await page.waitForURL(base + "/");
    await page.locator("#day-note").fill("Keep this draft through navigation");
    await page.locator("#overview-view").click();
    await page.waitForSelector(".calendar-day");
    await page.evaluate(() => {
      window.spaSentinel = "alive";
    });
    await page.locator("#home-link").click();
    await page.waitForURL(base + "/");
    assert.equal(
      await page.evaluate(() => window.spaSentinel),
      "alive",
      "Logo stays within the app",
    );
    assert.equal(
      await page.locator("#day-note").inputValue(),
      "Keep this draft through navigation",
    );
    await page.locator("#day-note-form button").click();
    await waitFor(
      () => document.querySelector("#day-note-status").textContent === "Saved",
    );
    for (const path of ["/overview", "/recurring", "/settings"]) {
      await page.goto(base + path);
      await waitFor(
        (path) =>
          path === "/overview"
            ? !document.querySelector("#overview").hidden
            : document.querySelector(
                path === "/recurring"
                  ? "#recurrences-dialog"
                  : "#settings-dialog",
              ).open,
        path,
      );
      assert.equal(
        new URL(page.url()).pathname,
        path,
        "Deep links load their view",
      );
    }
    await page.locator("#settings-dialog [data-close]").click();
    await page.waitForURL(base + "/");
    const post = (path, data) =>
      page.evaluate(
        async ({ path, data }) => {
          const token = document.querySelector(
            '[name="csrfmiddlewaretoken"]',
          ).value;
          const response = await fetch(`/api/${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRFToken": token,
            },
            body: JSON.stringify(data),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(JSON.stringify(result));
          return result;
        },
        { path, data },
      );
    const state = await page.evaluate(async () =>
      (await fetch("/api/state/")).json(),
    );
    // Populate the start of today so following the current time has something to scroll past.
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: state.preferences.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(state.now));
    const minuteOfDay =
      Number(parts.find((p) => p.type === "hour").value) * 60 +
      Number(parts.find((p) => p.type === "minute").value);
    const count = Math.min(24, Math.floor(minuteOfDay / 5));
    const startMinute = Math.max(0, minuteOfDay - count * 5 - 15);
    const clock = (n) =>
      `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    for (let i = 0; i < count; i++) {
      await post("blocks/", {
        date: state.today,
        start: clock(startMinute + i * 5),
        end: clock(startMinute + (i + 1) * 5),
        title: `Early meeting ${i}`,
        kind: "meeting",
      });
    }
    const yesterday = new Date(`${state.today}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await post("blocks/", {
      date: yesterday.toISOString().slice(0, 10),
      start: "10:00",
      end: "10:30",
      title: "Results meeting",
      kind: "meeting",
    });
    await page.reload();
    await page.waitForSelector("#timeline .current-time");
    await page.waitForTimeout(100);
    const follow = await page.evaluate(() => {
      const row = document
        .querySelector("#timeline .current-time")
        .getBoundingClientRect();
      const timeline = document
        .querySelector("#timeline")
        .getBoundingClientRect();
      return row.top >= timeline.top - 1 && row.bottom <= timeline.bottom + 1;
    });
    assert(follow, "Current timeline entry stays visible");
    await page.locator("#day-prev").click();
    await page
      .getByRole("button", { name: "Review Results meeting", exact: true })
      .click();
    await page.waitForSelector("#review-dialog[open]");
    await page.locator("#allocations input").first().fill("Decision reached");
    await page.getByRole("button", { name: "3 sand", exact: true }).first().click();
    assert.equal(await page.locator("#allocations input").count(), 2);
    assert(await page.locator("#allocations .sand-control").last().isHidden());
    await page.locator("#allocations input").last().fill("Follow-up");
    assert.equal(await page.locator("#allocations input").count(), 3);
    assert(await page.locator("#allocations .sand-control").nth(1).isVisible());
    await page.locator("#allocations .sand-control").nth(1).getByRole("button", {name: "1 sand", exact: true}).click();
    assert.equal(await page.locator("#allocation-total").textContent(), "4 / 5 sand");
    await page.locator("#allocations input").nth(1).fill("");
    assert.equal(await page.locator("#allocation-total").textContent(), "3 / 5 sand");
    await page.locator("#review-reflection").fill("Next steps agreed");
    assert.equal(await page.locator("#allocations input").count(), 2);
    await page.screenshot({path: "test-results/review-auto-row.png"});
    await page.locator('#review-form button[type="submit"]').click();
    await page.waitForSelector("#review-dialog[open]", { state: "hidden" });
    await page.waitForSelector("#timeline .item-note");
    assert(
      await page.locator("#timeline .item-note").count(),
      "Meeting note appears inline",
    );
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator("#today-view").click();
      await page.waitForTimeout(100);
      const day = await page.evaluate(() => ({
        pageHeight: document.documentElement.scrollHeight,
        height: innerHeight,
        width: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        rail: document.querySelector(".sidebar").getBoundingClientRect().width,
        border: getComputedStyle(document.querySelector(".sidebar"))
          .borderRightWidth,
      }));
      assert(
        day.pageHeight <= day.height + 1,
        `No page scrolling at ${viewport.width}: ${JSON.stringify(day)}`,
      );
      assert(
        day.width <= day.viewportWidth + 1,
        "No horizontal page scrolling",
      );
      assert.equal(day.rail, 44);
      assert.equal(day.border, "0px");
      await page.screenshot({ path: `test-results/day-${viewport.width}.png` });
      await page.locator("#overview-view").click();
      await page.waitForSelector(".calendar-day");
      await page.waitForTimeout(150);
      const calendar = await page.evaluate(() => {
        const scroll = document.querySelector("#calendar-scroll"),
          days = document.querySelectorAll(".calendar-day"),
          gap = parseFloat(
            getComputedStyle(scroll).getPropertyValue("--day-gap"),
          );
        return {
          weekWidth: days[0].getBoundingClientRect().width * 7 + gap * 6,
          viewport: scroll.clientWidth,
          pageHeight: document.documentElement.scrollHeight,
          height: innerHeight,
          rotation: getComputedStyle(
            document.querySelector(".calendar-day .timeline-time"),
          ).writingMode,
        };
      });
      assert(
        Math.abs(calendar.weekWidth - calendar.viewport) < 1,
        `Seven days fill viewport: ${JSON.stringify(calendar)}`,
      );
      assert(
        calendar.pageHeight <= calendar.height + 1,
        "Overview has no page scrolling",
      );
      assert.equal(calendar.rotation, "vertical-rl");
      await page.screenshot({
        path: `test-results/week-${viewport.width}.png`,
      });
    }
    await page.setViewportSize({width: 1280, height: 800});
    await page.locator("#today-view").click();
    await page.locator("#go-today").click();
    const workWindow = await page.evaluate(async () => {
      await api("timer/", {action: "skip_break"});
      const snapshot = await api("state/");
      const start = Math.floor(Date.parse(snapshot.now) / 60000) * 60000;
      const end = start + 3600000;
      return localDate(start) === localDate(end) ? {date: localDate(start),
        start: clock(start), end: clock(end), meetingStart: clock(start + 600000),
        meetingEnd: clock(start + 1200000)} : null;
    });
    if (workWindow) {
      await page.locator("#block-open").click();
      await page.locator("#block-kind").selectOption("work");
      await page.locator("#block-name").fill("Strategy");
      await page.locator("#block-date").fill(workWindow.date);
      await page.locator("#block-start").fill(workWindow.start);
      await page.locator("#block-end").fill(workWindow.end);
      await page.locator('#block-form button[type="submit"]').click();
      await page.waitForSelector("#block-dialog[open]", {state: "hidden"});
      await waitFor(() => !busy);
      assert.equal(await page.locator("#timer-task").textContent(), "Strategy");
      assert.equal(await page.locator("#timeline .reserved.work").count(), 0);
      assert(await page.locator("#timeline .work-reservation").count());
      await page.locator("#auto-break").uncheck();
      await waitFor(() => !busy && !state.preferences.auto_break);
      await page.locator("#timer-main").click();
      await waitFor(() => !busy && state.active?.title === "Strategy");
      await page.locator("#timer-topic").selectOption("open");
      await waitFor(() => !busy && state.active?.title === "Open focus");
      await page.locator("#timer-topic").selectOption("");
      await waitFor(() => !busy && state.active?.title === "Strategy");
      const originalEnd = await page.evaluate(() => state.active.end);
      await page.evaluate(async data => {
        await api("blocks/", {kind: "meeting", title: "Strategy call", date: data.date,
          start: data.meetingStart, end: data.meetingEnd});
        await refresh();
      }, workWindow);
      assert(await page.evaluate(end => Date.parse(state.active.end) < Date.parse(end), originalEnd));
      const work = page.locator('#timeline .work-reservation').filter({hasText: 'Strategy'});
      assert.equal(await work.locator('.work-reservation-heading').count(), 1);
      assert(await work.locator('.work-reservation-items .timeline-row').count() >= 2);
      assert.equal(await work.getByRole('button', {name: 'Edit Strategy call', exact: true}).count(), 1);
      assert.equal(await work.locator('.work-reservation-range').textContent(), `${workWindow.start}–${workWindow.end}`);
      assert.equal(await work.locator('.work-reservation-end').textContent(), workWindow.end);
      await work.locator('.work-reservation-heading').click();
      assert.equal(await page.locator('#block-name').inputValue(), 'Strategy');
      await page.getByRole('button', {name: 'Close block editor', exact: true}).click();
      await page.locator("#timer-finish").click();
      await page.waitForSelector("#review-dialog[open]");
      await waitFor(() => !busy);
      await page.getByRole("button", {name: "Close review", exact: true}).click();
      assert.equal(await page.locator("#timer-main").textContent(), "Start break");
      await page.locator("#timer-main").click();
      await waitFor(() => !busy && document.querySelector("#timer-main").textContent === "Skip break");
      await page.locator("#auto-focus").check();
      await waitFor(() => !busy && state.preferences.auto_focus);
      await page.locator("#timer-main").click();
      await waitFor(() => !busy && !!state.active);
      assert.equal(await page.locator("#timer-task").textContent(), "Strategy");
      await page.locator("#timer-cancel").click();
      await waitFor(() => !busy && !state.active && !state.can_auto_start);
      await page.locator("#auto-focus").uncheck();
      await waitFor(() => !busy && !state.preferences.auto_focus);
      await page.screenshot({path: "test-results/work-scheduling.png"});
      await page.setViewportSize({width: 390, height: 844});
      assert(await work.evaluate(group => {
        const bounds = group.getBoundingClientRect();
        return [...group.querySelectorAll('.timeline-item')].every(card => {
          const rect = card.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right + 1;
        }) && document.documentElement.scrollWidth <= window.innerWidth;
      }), 'Work contents fit inside the mobile frame');
      await page.screenshot({path: "test-results/work-scheduling-mobile.png"});
    }
    assert.deepEqual(errors, [], "No browser JavaScript errors");
    console.log(
      "PASS: real Chromium viewport bounds, seven-day width, vertical times, current-time following, and meeting results.",
    );
  } catch (error) {
    await page
      .screenshot({ path: "test-results/browser-failure.png", fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
