/* Real-browser layout checks against a disposable LOCAL server. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");
const base = process.env.PARADEIS_TEST_URL;
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
fs.mkdirSync("test-results", { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
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
    await page.locator("#allocations input").fill("Decision reached");
    await page.getByRole("button", { name: "3 sand", exact: true }).click();
    await page.locator("#review-reflection").fill("Next steps agreed");
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
