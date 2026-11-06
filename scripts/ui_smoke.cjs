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
  const wrapped = w.document.createElement('div');
  wrapped.id = 'timeline';
  const bounds = {start: time(-20), end: time(20), start_time: '09:00', end_time: '17:00'};
  w.renderTimeline(wrapped, {...day, workday: bounds});
  for (const selector of ['.timeline-start', '.timeline-end'])
    assert.equal(wrapped.querySelector(selector).closest('.work-reservation').dataset.workId, '301');
  const orderedTimes = [...wrapped.querySelector('.work-reservation-items').children]
    .map(row => Date.parse(row.dataset.start)).filter(Number.isFinite);
  assert.deepEqual(orderedTimes, [...orderedTimes].sort((a,b) => a-b));
  const calendar = w.document.createElement('div');
  w.renderDayCalendar(calendar, {...day, workday: bounds});
  const events = [...calendar.querySelectorAll('.day-calendar-event')];
  assert.equal(events.length, 6);
  for (const event of events) {
    assert(Math.abs(parseFloat(event.style.height) - Math.max(5, (Date.parse(event.dataset.end) - Date.parse(event.dataset.start)) / 60000) * 3) < .01);
  }
  const before = events.find(event => event.textContent.includes('Before Work'));
  const after = events.find(event => event.textContent.includes('After Work'));
  assert(Math.abs(parseFloat(after.style.top) - parseFloat(before.style.top) - 315) < .01);
  assert.equal(calendar.querySelectorAll('.day-calendar-work').length, 3);
  assert.equal(calendar.querySelectorAll('.day-calendar-boundary').length, 2);
  calendar.scrollTop = 200;
  w.renderDayCalendar(calendar, {...day, workday: bounds});
  assert.equal(calendar.scrollTop, 200, 'Refreshing the full day preserves manual scrolling');
  w.renderDayCalendar(calendar, {...day, sessions: [...day.sessions,
    entry(104, 'Overlapping focus', -24, -10, {status:'completed',elapsed:840,effort:0})]});
  const overlapping = [...calendar.querySelectorAll('.day-calendar-event')]
    .filter(event => event.textContent.includes('Another topic') || event.textContent.includes('Overlapping focus'));
  assert.equal(overlapping.length, 2);
  assert(overlapping.every(event => event.style.getPropertyValue('--event-columns') === '2'));
  assert.notEqual(overlapping[0].style.getPropertyValue('--event-lane'), overlapping[1].style.getPropertyValue('--event-lane'));
}

async function checkPeriodPlanningUI(w) {
  const $ = id => w.document.getElementById(id), originalAnchor=w.eval("calendarAnchor");
  await w.showView(true);
  w.eval("calendarAnchor = '2026-11-01'");
  await w.loadCalendar({target:'2026-10-26'});
  assert.equal(w.eval('calendarWeek'),'2026-10-26');
  const months=()=>[...w.document.querySelectorAll('#calendar-periods .period-group.month')];
  assert.deepEqual(months().map(group=>group.dataset.period),['month:2026-10-01','month:2026-11-01']);
  let october=months()[0], input=october.querySelector('textarea');
  input.value='*October reflection*';input.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(october.querySelector('.markdown-mirror em').textContent,'*October reflection*');
  await w.navigateCalendarWeek(1);await w.navigateCalendarWeek(-1);
  october=months()[0];input=october.querySelector('textarea');
  assert.equal(input.value,'*October reflection*','Month draft survives navigating into November and back');
  input.form.requestSubmit();
  await waitFor(()=>october.querySelector('.note-actions').textContent.includes('Saved'),'save October note');
  october.querySelector('.period-goals button').click();
  await waitFor(()=>$('period-goal-dialog').open&&!$('period-goal-text').disabled,'original goal editor reopened');
  $('period-goal-text').value='**A defined October outcome**';
  $('period-goal-text').dispatchEvent(new w.Event('input',{bubbles:true}));
  $('period-goal-form').requestSubmit();
  await waitFor(()=>!$('period-goal-dialog').open&&!w.eval('busy || periodSaving'),'save edited monthly goal');
  assert.equal(w.eval('calendarWeek'),'2026-10-26','Editing a goal preserves the visible week');
  assert.equal(months()[0].querySelector('.period-goals textarea'),null);
  assert(months()[0].querySelector('.period-goals strong').textContent.includes('**A defined October outcome**'));
  months()[1].querySelector('.period-goals button').click();
  await waitFor(()=>$('period-goal-dialog').open&&!$('period-goal-text').disabled,'next month editor');
  assert($('period-goal-previous').textContent.includes('A defined October outcome'));
  $('period-goal-close').click();
  const q=w.document.querySelector('#calendar-periods .period-group.quarter');
  q.querySelector('textarea').value='*Quarter reflection*';
  q.querySelector('textarea').dispatchEvent(new w.Event('input',{bubbles:true}));
  q.querySelector('form').requestSubmit();
  await waitFor(()=>q.querySelector('.note-actions').textContent.includes('Saved'),'save quarter note');
  const untrusted=w.document.createElement('div');w.sourceMarkdown(untrusted,'*<img src=x onerror=alert(1)>*');
  assert.equal(untrusted.querySelector('img'),null);assert(untrusted.querySelector('em').textContent.includes('<img'));
  await w.showView(false);
  await w.openPlanningSettings();
  w.makeWeekdays($('planning-workdays'),[0,1,2,3,6]);
  $('planning-rule-fields').querySelector('[data-period="week"] [data-field="minutes"]').value='35';
  $('planning-settings-form').requestSubmit();
  await waitFor(()=>!$('planning-settings-dialog').open&&!w.eval('busy'),'save planning settings');
  const settings=await w.api('planning-settings/');
  assert.deepEqual(Array.from(settings.workdays),[0,1,2,3,6]);
  assert.equal(settings.rules.find(rule=>rule.period==='week').minutes,35);
  await w.openRecurrences();
  w.editRecurrence({title:'Selected weekday check',kind:'meeting',frequency:'daily',weekday:0,weekdays:[1,3],
    interval_weeks:1,anchor_date:w.eval('state.today'),start:'06:00',end:'06:15'});
  assert.equal($('repeat-weekdays').hidden,false);
  $('recurrence-form').requestSubmit();
  await waitFor(()=>!$('recurrences-dialog').open&&w.document.querySelectorAll('.recurrence-card').length===2&&!w.eval('busy'),'selected weekdays in recurring week');
  const template=(await w.api('recurrences/')).templates.find(t=>t.title==='Selected weekday check');
  assert.deepEqual(Array.from(template.weekdays),[1,3]);
  const cards=[...w.document.querySelectorAll('.recurrence-card')];
  assert(cards.every(card=>/Tuesday|Thursday/.test(card.getAttribute('aria-label'))));
  w.editRecurrence(template);$('recurrence-delete').click();
  await waitFor(()=>!$('recurrences-dialog').open&&w.document.querySelectorAll('.recurrence-card').length===0&&!w.eval('busy'),'remove weekday fixture');
  w.__originalPlanningAnchor=originalAnchor;w.eval("calendarAnchor=window.__originalPlanningAnchor");
  await w.showView(false);
}

async function checkPlanningTimerUI(w) {
  const $=id=>w.document.getElementById(id), original=await w.api('state/');
  const end=new Date(Date.now()+1500000).toISOString(), start=new Date(Date.now()-1000).toISOString();
  const block={id:987123,kind:'planning',title:'Weekly planning',start,end,tracked:false,
    planning:{period:'week',date:w.monday(original.today)}};
  overrideState=()=>({...original,now:new Date().toISOString(),active:null,live_block:block,next_block:block,next_seconds:0});
  await w.refresh();
  assert.equal($('timer-main').textContent,'Start planning');assert.equal($('timer-main').disabled,false);
  boundaryStart=undefined;$('timer-main').click();
  await waitFor(()=>boundaryStart?.block_id===block.id&&!w.eval('busy'),'start reserved planning timer');
  const active={id:987124,kind:'focus',planning:true,title:'Weekly planning',status:'running',start,end,
    remaining:1500,elapsed:0,allocations:[],can_overrun:false};
  overrideState=()=>({...original,now:new Date().toISOString(),active,live_block:block,next_block:block});
  await w.refresh();assert.equal($('timer-main').textContent,'Finish');assert.equal($('timer-topic').hidden,true);
  boundaryStart=undefined;$('timer-main').click();
  await waitFor(()=>boundaryStart?.action==='finish'&&!w.eval('busy'),'planning timer finishes instead of pausing');
  overrideState=undefined;boundaryStart=undefined;await w.refresh();
}

async function checkCompanionUI(w) {
  const $ = id => w.document.getElementById(id);
  const originalWorker = w.eval('worker'), secure = Object.getOwnPropertyDescriptor(w, 'isSecureContext');
  const originalPushManager = w.PushManager;
  Object.defineProperty(w, 'isSecureContext', {configurable: true, value: true});
  w.PushManager = function() {};
  const config = await w.api('push/');
  let subscription = null;
  const registration = {pushManager: {
    getSubscription: async () => subscription,
    subscribe: async options => {
      assert.equal(options.userVisibleOnly, true);
      assert.equal(options.applicationServerKey.length, 65);
      subscription = {toJSON: () => ({endpoint: 'https://fcm.googleapis.com/wp/ui-companion',
        keys: {p256dh: config.public_key, auth: 'AAAAAAAAAAAAAAAAAAAAAA'}}),
        unsubscribe: async () => {subscription = null; return true;}};
      return subscription;
    },
  }};
  w.__companionRegistration = registration;
  w.eval('worker = Promise.resolve(window.__companionRegistration)');
  w.openSettings();
  await waitFor(() => !$('companion-toggle').disabled, 'companion registration ready');
  $('companion-toggle').click();
  await waitFor(() => $('companion-status').textContent === 'on' && !$('companion-toggle').disabled, 'phone companion enabled');
  assert.equal((await w.api('push/')).enabled, true);
  assert.equal(w.localStorage.getItem('companion-enabled'), 'yes');
  await w.loadCompanionStatus();
  assert.equal($('companion-status').textContent, 'on');
  $('companion-test').click();
  await waitFor(() => $('companion-help').textContent.startsWith('Test queued.'), 'test notification queued');
  await waitFor(() => !$('companion-toggle').disabled, 'companion controls ready');
  $('companion-toggle').click();
  await waitFor(() => $('companion-status').textContent === 'off' && !$('companion-toggle').disabled, 'companion disabled');
  assert.equal((await w.api('push/')).enabled, false);
  assert.equal(subscription, null);
  assert.equal(w.localStorage.getItem('companion-enabled'), null);
  $('settings-dialog').close();
  w.__originalWorker = originalWorker;
  w.eval('worker = window.__originalWorker; companionConfig = companionRegistration = companionSubscription = null; companionConnected = false;');
  if (secure) Object.defineProperty(w, 'isSecureContext', secure); else delete w.isSecureContext;
  if (originalPushManager) w.PushManager = originalPushManager; else delete w.PushManager;
  w.updateCompanion();
}

async function checkDayHoursUI(w) {
  const $ = id => w.document.getElementById(id);
  const today = w.eval("state.today"), tomorrow = w.shiftDay(today, 1);
  await w.changeDay(tomorrow);
  assert.equal($("timeline").querySelectorAll(".timeline-boundary").length, 2);
  $("timeline").querySelector(".timeline-start").click();
  assert($("day-hours-dialog").open);
  assert.equal(w.document.activeElement, $("day-hours-start"));
  assert($("day-hours-reset").hidden);
  $("day-hours-start").value = "10:00";
  $("day-hours-end").value = "11:00";
  $("day-hours-form").requestSubmit();
  await waitFor(() => !$("day-hours-dialog").open && !w.eval("busy"), "save day-specific hours");
  assert.equal($("timeline").querySelector(".timeline-start .timeline-time").textContent, "10:00");
  assert.equal($("timeline").querySelector(".timeline-end .timeline-time").textContent, "11:00");
  await w.refresh();
  assert.equal(w.eval("state.day.workday.customized"), true);
  assert.equal((await w.api("state/")).day.workday.customized, false, "Today keeps its default hours");
  $("timeline").querySelector(".timeline-end").click();
  assert.equal(w.document.activeElement, $("day-hours-end"));
  $("day-hours-start").value = "12:00";
  $("day-hours-form").requestSubmit();
  await waitFor(() => !$("day-hours-dialog").querySelector(".dialog-error").hidden && !w.eval("busy"), "invalid range stays editable");
  assert($("day-hours-dialog").open);
  assert.equal((await w.api(`state/?date=${tomorrow}`)).day.workday.start_time, "10:00");
  $("day-hours-reset").click();
  await waitFor(() => !$("day-hours-dialog").open && !w.eval("busy"), "restore default hours");
  assert.equal(w.eval("state.day.workday.customized"), false);
  assert.equal($("timeline").querySelector(".timeline-start .timeline-time").textContent, w.eval("state.preferences.day_start"));
  await w.changeDay(today);
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

async function checkManualPomoUI(w) {
  const $ = id => w.document.getElementById(id), today = (await w.api('state/')).today;
  const chord = extra => new w.KeyboardEvent('keydown', {code: 'KeyP', ctrlKey: true,
    altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra});
  $('task-title').dispatchEvent(chord());
  assert(!$('manual-pomo-dialog').open, 'Typing fields do not trigger manual entry');
  w.document.dispatchEvent(chord({repeat: true}));
  assert(!$('manual-pomo-dialog').open);
  w.document.dispatchEvent(chord());
  assert($('manual-pomo-dialog').open);
  const day = w.shiftDay(today, -1);
  $('manual-pomo-task').value = 'Forgotten pomo';
  $('manual-pomo-date').value = day;
  $('manual-pomo-start').value = '03:00';
  $('manual-pomo-minutes').value = '25';
  $('manual-pomo-form').requestSubmit();
  await waitFor(() => !$('manual-pomo-dialog').open && $('review-dialog').open && w.eval('!busy'), 'record past pomo');
  assert.equal($('timeline-date').textContent, w.dateLabel(day, {weekday: 'short', month: 'short', day: 'numeric'}));
  $('allocations').querySelector('.sand-control button:nth-child(3)').click();
  $('focus-control').children[1].click();
  $('review-form').requestSubmit();
  await waitFor(() => !$('review-dialog').open && w.eval('!busy'), 'rate manual pomo');
  const saved = (await w.api(`state/?date=${day}`)).day.sessions.find(s => s.title === 'Forgotten pomo');
  assert.equal(saved.elapsed, 1500);
  assert.equal(saved.effort, 3);
  assert.equal(saved.focus_score, 2);
  w.openReview(saved);
  const confirm = w.confirm;
  w.confirm = () => false;
  $('review-delete').click();
  assert($('review-dialog').open, 'Cancelling deletion keeps the review');
  w.confirm = () => true;
  $('review-delete').click();
  await waitFor(() => !$('review-dialog').open && w.eval('!busy'), 'delete manual pomo');
  w.confirm = confirm;
  assert(!(await w.api(`state/?date=${day}`)).day.sessions.some(s => s.id === saved.id));
  assert(!$('timeline').textContent.includes('Forgotten pomo'));
  await w.changeDay(today);
}

function checkBlockKeyboardUI(w) {
  const $ = id => w.document.getElementById(id);
  const input = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event('input', {bubbles: true}));
  };
  w.openBlock();
  assert.equal(w.document.activeElement, $('block-name'));
  assert($('block-start').compareDocumentPosition($('block-date')) & 4);
  assert($('block-end').compareDocumentPosition($('block-date')) & 4);
  $('block-start').focus();
  input('block-start', '09:10');
  assert.equal($('block-end').value, '09:40');
  assert.equal(w.document.activeElement, $('block-start'), 'Typing the hour cannot steal focus');
  input('block-start', '10:45');
  assert.equal($('block-end').value, '11:15');
  $('block-start').dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  assert.equal(w.document.activeElement, $('block-end'));
  input('block-end', '12:00');
  input('block-start', '11:00');
  assert.equal($('block-end').value, '12:00', 'Explicit end times are preserved');
  $('block-dialog').close();
  w.openBlock();
  input('block-start', '23:45');
  assert.equal($('block-end').value, '23:59', 'Same-day blocks cannot wrap through midnight');
  input('block-start', '');
  assert.equal($('block-end').value, '23:59', 'Incomplete input cannot clear the suggested end');
  $('block-dialog').close();
  w.openBlock({id: 987, title: 'Existing', kind: 'meeting', date: w.eval('state.today'),
    start_time: '09:00', end_time: '10:45'});
  input('block-start', '09:30');
  assert.equal($('block-end').value, '10:45', 'Editing an existing block preserves its end');
  $('block-dialog').close();
}

async function checkSchedulingUI(w) {
  checkBlockKeyboardUI(w);
  checkWorkWrappingUI(w);
  const pattern = (id, start, end) => ({id, start, end});
  const lanes = w.recurrenceLayout([pattern(1, "09:00", "12:00"), pattern(2, "09:00", "10:30"),
    pattern(3, "10:30", "12:00"), pattern(4, "12:00", "14:00")]);
  assert(lanes.slice(0, 3).every(item => item.columns === 2));
  assert.equal(lanes[3].columns, 1, "Adjacent clusters use the full width");
  const tiny = w.recurrenceLayout([pattern(1, "09:00", "09:05"), pattern(2, "09:05", "09:10")]);
  assert(tiny.every(item => item.columns === 1), "Adjacent short blocks share one lane");
  const lengths = w.recurrenceLayout([pattern(1, "09:00", "09:05"), pattern(2, "09:00", "09:15"),
    pattern(3, "09:00", "09:30"), pattern(4, "09:00", "10:00"), pattern(5, "09:00", "11:00")]);
  assert.deepEqual(Array.from(lengths, item => item.end - item.start), [5, 15, 30, 60, 120]);
  assert(lengths.every(item => item.columns === 5), "Actual overlaps retain separate lanes");
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
  await checkManualPomoUI(w);
  await w.api("timer/", {action: "skip_break"});
  await w.refresh();
  const workStart = Math.floor(Date.parse((await w.api("state/")).now) / 60000) * 60000;
  const workEnd = workStart + 60 * 60000;
  if (w.localDate(workStart) === w.localDate(workEnd)) {
    await w.api("blocks/", {kind: "work", title: "Strategy", date: w.localDate(workStart),
      start: w.clock(workStart), end: w.clock(workEnd)});
    await w.refresh();
    assert.equal($("timer-task").textContent, "Strategy", JSON.stringify(w.eval("({topic: nextTopicChoice, default: state.default_topic, active: state.active, now: state.now, preferences: state.preferences})")));
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
    assert.equal($("app-favicon").dataset.mode, "break");
    assert($("app-favicon").href.endsWith('/static/icon-break.svg'));
    const iconChanges = [];
    const iconObserver = new w.MutationObserver(records => iconChanges.push(...records));
    iconObserver.observe($("app-favicon"), {attributes:true, attributeFilter:['href']});
    w.tick(); w.tick();
    await Promise.resolve();
    assert.equal(iconChanges.length, 0, 'Countdown ticks do not rewrite the favicon');
    iconObserver.disconnect();
    $("timer-main").click();
    await waitFor(() => $("timer-main").textContent === "Skip break" && w.eval("!busy"), "start manual break");
    $("auto-focus").checked = true;
    $("auto-focus").dispatchEvent(new w.Event("change"));
    await waitFor(() => w.eval("!busy && state.preferences.auto_focus"), "quick auto-focus toggle");
    assert.equal((await w.api("state/")).preferences.auto_focus, true);
    $("timer-main").click();
    await waitFor(() => w.eval("!busy && !!state.active"), "automatically start focus after skipping the break");
    assert.equal($("app-favicon").dataset.mode, "focus");
    assert($("app-favicon").href.endsWith('/static/icon.svg'));
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
          data.day_plan = {...data.day_plan, date: overrideToday, ready: false,
            previous_date: data.today, previous_tasks: data.tasks};
          data.tasks = [];
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
  for (const period of ["quarter","month","week"]) {
    await waitFor(() => $("period-goal-dialog").open && !$("period-goal-text").disabled &&
      w.eval("periodEditing.period") === period, `initial ${period} planning`);
    assert.equal($("period-goal-context").querySelectorAll("textarea").length, 0);
    assert.equal($("period-goal-previous").querySelectorAll(".goal-reference").length, 1);
    if (period === "month") assert($("period-goal-context").textContent.includes("Quarter direction"));
    if (period === "week") assert($("period-goal-context").textContent.includes("Monthly direction"));
    $("period-goal-text").value = period === "quarter" ? "**Quarter direction**" : period === "month" ? "*Monthly direction*" : "Weekly direction";
    $("period-goal-text").dispatchEvent(new w.Event("input", {bubbles:true}));
    $("period-goal-form").requestSubmit();
    await waitFor(() => !w.eval("busy || periodSaving"), `save initial ${period} goals`);
  }
  await waitFor(() => $("day-plan-dialog").open, "daily planning opens first");
  assert.equal(w.document.activeElement, $("day-plan-goal"));
  assert($("day-plan-weekly-context").textContent.includes("Weekly direction"));
  assert.equal($("task-list").children.length, 0);
  assert.equal($("day-plan-previous").children.length, 2);
  const cancelPlan = new w.Event("cancel", {cancelable: true});
  $("day-plan-dialog").dispatchEvent(cancelPlan);
  assert(cancelPlan.defaultPrevented, "Planning requires an explicit Start day");
  $("day-plan-goal").value = "A deliberate new goal";
  submit("day-plan-goal-form");
  await waitFor(() => $("day-plan-goal").value === "" && !w.eval("busy"), "persist new daily goal");
  $("day-plan-previous").querySelector("button").click();
  await waitFor(() => $("day-plan-goals").children.length === 2 && !w.eval("busy"), "explicit carry");
  assert.equal($("day-plan-previous").querySelector("button").textContent, "Added ✓");
  await w.refresh();
  assert.equal($("day-plan-goals").children.length, 2, "Draft plan persists across state loads");
  assert.equal($("day-plan-previous").querySelectorAll("button:disabled").length, 1);
  while ($("day-plan-goals").querySelector("button")) {
    const count = $("day-plan-goals").querySelectorAll("button").length;
    $("day-plan-goals").querySelector("button").click();
    await waitFor(() => $("day-plan-goals").querySelectorAll("button").length < count && !w.eval("busy"), "remove planning fixture");
  }
  await click("day-plan-start");
  await waitFor(() => !$("day-plan-dialog").open && !w.eval("busy"), "start day");
  await w.refresh();
  assert(!$("day-plan-dialog").open, "Planning completion persists");
  await require("./sw_smoke.cjs")();
  await checkPeriodPlanningUI(w);
  await checkPlanningTimerUI(w);
  await checkCompanionUI(w);
  await checkDayHoursUI(w);
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
  await waitFor(() => [...w.document.querySelectorAll(".calendar-day.today .completed-result")].some(row=>row.textContent.includes("✓ Updated proposal")), "completed task in current calendar data");
  assert([...w.document.querySelectorAll(".calendar-day.today .completed-result")].some(row => row.textContent.includes("✓ Updated proposal")));
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
  assert(w.document.querySelectorAll(".period-group.month").length >= 1);
  assert.equal(w.document.querySelectorAll(".period-group.quarter").length, 1);
  for (const group of w.document.querySelectorAll(".period-group.week")) {
    assert(group.closest("#calendar-periods"));
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
    ["quarter", "Quarterly"],
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
  assert.equal($("task-list").children.length, 0, "New day starts with no carried tasks");
  assert($("day-plan-dialog").open, "New day requires conscious planning");
  assert.equal($("day-plan-previous").children.length, saved.tasks.length);
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
