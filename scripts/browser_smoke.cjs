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
    throw new Error("Timed out waiting for browser state: " + await page.evaluate(() => JSON.stringify({companion: document.querySelector("#companion-help")?.textContent, permission: Notification.permission, subscribed: window.companionSubscribeCalled, error: document.querySelector("#error")?.textContent})));
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
    for (const period of ['quarter','month','week']) {
      await waitFor(p => document.querySelector('#period-goal-dialog').open &&
        !document.querySelector('#period-goal-text').disabled && periodEditing?.period === p, period);
      assert.equal(await page.locator('#period-goal-context textarea').count(), 0);
      await page.locator('#period-goal-text').fill(period === 'quarter' ? '**Quarter direction**' : period === 'month' ? '*Monthly direction*' : 'Weekly direction');
      if (period === 'month') assert(await page.locator('#period-goal-context').textContent().then(text => text.includes('Quarter direction')));
      if (period === 'week') {
        assert((await page.locator('#period-goal-context').textContent()).includes('Monthly direction'));
        await page.screenshot({path:'test-results/planning-hierarchy-1280.png'});
        await page.setViewportSize({width:390,height:844});
        await page.screenshot({path:'test-results/planning-hierarchy-390.png'});
        await page.setViewportSize({width:1280,height:800});
      }
      await page.locator('#period-goal-text').press('Control+Enter');
      await waitFor(() => !busy && !periodSaving);
    }
    await page.waitForSelector('#day-plan-dialog[open]');
    assert(await page.locator('#day-plan-goal').evaluate(el => el === document.activeElement));
    assert.equal(await page.locator('#task-list .task-row').count(), 0);
    await page.keyboard.press('Escape');
    assert(await page.locator('#day-plan-dialog').evaluate(el => el.open));
    await page.locator('#day-plan-goal').fill('A deliberate new goal');
    await page.locator('#day-plan-goal').press('Enter');
    await waitFor(() => !busy && document.querySelector('#day-plan-goal').value === '');
    await page.locator('#day-plan-previous button').first().click();
    await waitFor(() => !busy && document.querySelectorAll('#day-plan-goals button').length === 2);
    await page.screenshot({path: 'test-results/day-planning-1280.png'});
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: 'test-results/day-planning-390.png'});
    const planBounds = await page.locator('#day-plan-dialog').boundingBox();
    assert(planBounds.x >= 0 && planBounds.x + planBounds.width <= 391);
    await page.reload();
    await page.waitForSelector('#day-plan-dialog[open]');
    assert.equal(await page.locator('#day-plan-goals button').count(), 2);
    assert.equal(await page.locator('#day-plan-previous button:disabled').count(), 1);
    while (await page.locator('#day-plan-goals button').count()) {
      const count = await page.locator('#day-plan-goals button').count();
      await page.locator('#day-plan-goals button').first().click();
      await waitFor(n => !busy && document.querySelectorAll('#day-plan-goals button').length < n, count);
    }
    await page.locator('#day-plan-start').click();
    await waitFor(() => !busy && !document.querySelector('#day-plan-dialog').open);
    await page.reload();
    await page.waitForSelector('.current-time');
    assert.equal(await page.locator('#day-plan-dialog[open]').count(), 0);
    await page.setViewportSize({width: 1280, height: 800});
    await page.locator('#timeline-calendar').click();
    await page.waitForSelector('#timeline.day-calendar .day-calendar-canvas');
    await page.reload();
    await page.waitForSelector('#timeline.day-calendar .day-calendar-canvas');
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#timeline-calendar').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      const start = Date.parse(state.day.workday.start), at = minutes => new Date(start + minutes * 60000).toISOString();
      const item = (id, title, from, to, extra={}) => ({id,title,start:at(from),end:at(to),kind:'focus',...extra});
      window.fullDayFixture = {...state.day,
        blocks:[item(9001,'Strategy',30,210,{kind:'work'}),item(9002,'Team meeting',90,120,{kind:'meeting'})],
        sessions:[item(9003,'Research',30,55,{status:'completed',elapsed:1500,effort:3,focus_score:2}),
          item(9004,'Write proposal',150,200,{status:'completed',elapsed:3000,effort:4,focus_score:3})], plan:[]};
      renderTimeline(document.querySelector('#timeline'), fullDayFixture);
      document.querySelector('#timeline').scrollTop = 0;
    });
    for (const width of [1280,390]) {
      await page.setViewportSize({width,height:width===390?844:800});
      const layout = await page.evaluate(() => {
        const events=[...document.querySelectorAll('#timeline .day-calendar-event')],
          first=events.find(event=>event.textContent.includes('Research')),
          last=events.find(event=>event.textContent.includes('Write proposal')),
          canvas=document.querySelector('.day-calendar-canvas').getBoundingClientRect();
        return {duration:first.getBoundingClientRect().height, gap:last.getBoundingClientRect().top-first.getBoundingClientRect().top,
          left:canvas.left,right:canvas.right,width:innerWidth};
      });
      assert(Math.abs(layout.duration-75)<1, '25 minutes gets 75px');
      assert(Math.abs(layout.gap-360)<1, 'Two hours retains its full calendar distance');
      assert(layout.left>=0&&layout.right<=layout.width+1);
      await page.screenshot({path:`test-results/full-day-calendar-${width}.png`});
    }
    await page.evaluate(() => {
      const timeline=document.querySelector('#timeline');timeline.scrollTop=150;
      renderTimeline(timeline,fullDayFixture);
      if(timeline.scrollTop!==150)throw Error('Full day lost manual scroll position');
    });
    await page.evaluate(() => {
      const start=Date.parse(state.day.workday.start), at=minutes=>new Date(start+minutes*60000).toISOString();
      const item=(id,title,from,to,extra={})=>({id,title,start:at(from),end:at(to),kind:'focus',...extra});
      window.denseDayFixture={...state.day,blocks:[
        item(9101,'Strategy and preparation',0,180,{kind:'work'}),
        item(9102,'Meeting with a long name that needs to wrap within its calendar block',0,15,{kind:'meeting'}),
        item(9103,'A one-minute event',180,181,{kind:'meeting'}),
        item(9104,'Another short event',181,182,{kind:'meeting'})],
        sessions:[item(9105,'Research and preparation with a longer topic across several tasks',15,40,
          {status:'completed',elapsed:1500,effort:4,focus_score:3,allocations:[{label:'Read source material',sand:2},{label:'Write detailed notes',sand:2}]}),
          item(9106,'A completed focus with more than one line of text',90,115,{status:'completed',elapsed:1500,effort:3,focus_score:2})],
        plan:[item(9110,'Break',40,45,{kind:'break'}),item(9111,'Focus',45,70),item(9112,'Break',70,75,{kind:'break'}),
          item(9113,'Break',75,90,{kind:'break'}),item(9114,'Break',115,120,{kind:'break'}),
          item(9115,'A much longer planned focus topic that needs to wrap',120,145),item(9116,'Break',145,150,{kind:'break'}),
          item(9117,'Focus',150,175),item(9118,'Break',175,180,{kind:'break'})]};
      renderTimeline(document.querySelector('#timeline'),denseDayFixture);
      document.querySelector('#timeline').scrollTop=0;
    });
    for(const width of [1280,720,390]) {
      await page.setViewportSize({width,height:width===390?844:900});
      const clipping=await page.evaluate(()=>[...document.querySelectorAll('#timeline .day-calendar-event')].flatMap(event=>{
        const card=event.querySelector('.timeline-item'), bounds=card.getBoundingClientRect();
        return [...card.querySelectorAll('p,.day-calendar-range,.session-metrics,.sand-pile')].filter(node=>{
          const style=getComputedStyle(node);if(style.display==='none'||!node.getClientRects().length)return false;
          const box=node.getBoundingClientRect();return box.height>0&&(box.top<bounds.top+.5||box.bottom>bounds.bottom-.5||box.left<bounds.left+.5||box.right>bounds.right-.5);
        }).map(node=>({title:card.title,tag:node.className||node.tagName,cardHeight:bounds.height,contentHeight:node.getBoundingClientRect().height}));
      }));
      assert.deepEqual(clipping,[],`Calendar text and metrics fit at ${width}px: ${JSON.stringify(clipping)}`);
      const collisions=await page.evaluate(()=>{
        const visible=node=>getComputedStyle(node).visibility!=='hidden'&&node.getClientRects().length;
        const labels=[...document.querySelectorAll('#timeline .day-calendar-boundary .timeline-end-label,#timeline .day-calendar-now')].filter(visible);
        const text=[...document.querySelectorAll('#timeline .day-calendar-event p,#timeline .day-calendar-hour > span')].filter(visible);
        return labels.flatMap(label=>text.filter(node=>{
          const a=label.getBoundingClientRect(),b=node.getBoundingClientRect();
          // The Now line may cross an event; its text stays in the time gutter.
          if(label.classList.contains('day-calendar-now')&&node.matches('.day-calendar-event p'))return false;
          return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
        }).map(node=>`${label.textContent} overlaps ${node.textContent}`));
      });
      assert.deepEqual(collisions,[],`Time labels don't cover card text or each other at ${width}px`);
      assert.equal(await page.locator('#timeline .brief .item-meta').count(),0);
      await page.screenshot({path:`test-results/full-day-dense-${width}.png`});
    }
    await page.locator('#timeline .timeline-start .timeline-end-label').click();
    assert(await page.locator('#day-hours-dialog').evaluate(dialog=>dialog.open));
    await page.locator('#day-hours-dialog [data-close]').click();
    await page.locator('#timeline-compact').click();
    assert.equal(await page.locator('#timeline.day-calendar').count(),0);
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#overview-view').click();
    await page.waitForSelector('.calendar-day');
    await page.evaluate(async()=>{calendarAnchor='2026-11-01';await loadCalendar({target:'2026-10-26'});});
    await waitFor(()=>calendarWeek==='2026-10-26'&&document.querySelectorAll('#calendar-periods .period-group.month').length===2);
    const octoberNote=page.locator('#calendar-periods [data-period="month:2026-10-01"] textarea');
    await octoberNote.fill('*October reflection*');
    await octoberNote.press('Control+Enter');
    await waitFor(()=>document.querySelector('#calendar-periods [data-period="month:2026-10-01"] [data-note-status]').textContent.includes('Saved'));
    assert.equal(await page.locator('#calendar-periods [data-period="month:2026-10-01"] .markdown-mirror em').textContent(),'*October reflection*');
    for(const width of [1280,390]) {
      await page.setViewportSize({width,height:width===390?844:800});
      assert(await page.locator('#calendar-periods .period-group.month').evaluateAll(groups=>groups.every(group=>{
        const box=group.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1;
      })));
      await page.locator('#calendar-periods .month-row').scrollIntoViewIfNeeded();
      await page.screenshot({path:`test-results/overview-month-boundary-${width}.png`});
    }
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#calendar-periods [data-period="month:2026-10-01"] .period-goals button').click();
    await waitFor(()=>document.querySelector('#period-goal-dialog').open&&!document.querySelector('#period-goal-text').disabled);
    await page.locator('#period-goal-text').fill('**An October outcome**');
    await page.locator('#period-goal-text').press('Control+Enter');
    await waitFor(()=>!document.querySelector('#period-goal-dialog').open&&!busy&&!periodSaving);
    assert.equal(await page.evaluate(()=>calendarWeek),'2026-10-26');
    assert.equal(await page.locator('#calendar-periods .period-goals textarea').count(),0);
    await page.locator('#today-view').click();
    await waitFor(()=>!document.querySelector('#day-view').hidden);
    await page.evaluate(()=>calendarAnchor=month(state.today));
    await page.locator('#settings-open').click();
    await page.locator('#planning-settings-open').click();
    await waitFor(()=>document.querySelectorAll('#planning-rule-fields .planning-rule').length===3);
    const weekAdvance=page.locator('#planning-rule-fields [data-period="week"] [data-field="enabled"]');
    await weekAdvance.check();
    assert.equal(await page.locator('#planning-rule-fields [data-period="week"] [data-field="weekday"]').isDisabled(),false);
    await page.locator('#planning-rule-fields [data-period="week"] [data-field="minutes"]').fill('35');
    await page.screenshot({path:'test-results/planning-schedule-1280.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'test-results/planning-schedule-390.png'});
    assert(await page.locator('#planning-settings-dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1));
    await page.setViewportSize({width:1280,height:800});
    await weekAdvance.uncheck();
    await page.locator('#planning-settings-form button[type="submit"]').click();
    await waitFor(()=>!document.querySelector('#planning-settings-dialog').open&&!busy);
    assert.equal(await page.evaluate(async()=>(await api('planning-settings/')).rules.find(rule=>rule.period==='week').minutes),35);
    await page.locator('#recurrences-open').click();
    await page.locator('#recurrence-add').click();
    await page.locator('#repeat-title').fill('Selected weekday check');
    await page.locator('#repeat-frequency').selectOption('daily');
    await page.locator('#repeat-start').fill('06:00');await page.locator('#repeat-end').fill('06:30');
    for (const day of [1,3,5,6]) await page.locator(`#repeat-weekdays input[value="${day}"]`).uncheck();
    await page.screenshot({path:'test-results/recurring-weekday-selection.png'});
    await page.locator('#recurrence-form button[type="submit"]').click();
    await waitFor(()=>!busy&&!document.querySelector('#recurrences-dialog').open&&document.querySelectorAll('.recurrence-card').length===3);
    assert.deepEqual(await page.evaluate(async()=>(await api('recurrences/')).templates.find(t=>t.title==='Selected weekday check').weekdays),[0,2,4]);
    await page.locator('.recurrence-card').first().click();
    await page.locator('#recurrence-delete').click();
    await waitFor(()=>!busy&&!document.querySelector('#recurrences-dialog').open&&document.querySelectorAll('.recurrence-card').length===0);
    await page.locator('#today-view').click();
    await waitFor(()=>!document.querySelector('#day-view').hidden);
    const hoursDay = await page.evaluate(() => shiftDay(state.today, 1));
    await page.locator('#day-next').click();
    await waitFor(day => state.day.date === day, hoursDay);
    await page.locator('#timeline .timeline-start').click();
    assert(await page.locator('#day-hours-start').evaluate(el => el === document.activeElement));
    await page.locator('#day-hours-start').fill('10:00');
    await page.locator('#day-hours-end').fill('11:00');
    await page.locator('#day-hours-end').press('Enter');
    await waitFor(() => !busy && !document.querySelector('#day-hours-dialog').open);
    assert.equal(await page.locator('#timeline .timeline-start .timeline-time').textContent(), '10:00');
    assert.equal(await page.locator('#timeline .timeline-end .timeline-time').textContent(), '11:00');
    await page.reload();
    await page.waitForSelector("#timeline .timeline-start");
    await page.evaluate(day => changeDay(day), hoursDay);
    await waitFor(day => !busy && state.day.date === day, hoursDay);
    assert.equal(await page.locator('#timeline .timeline-end .timeline-time').textContent(), '11:00');
    await page.screenshot({path: 'test-results/day-hours-1280.png'});
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#timeline .timeline-end').click();
    assert(await page.locator('#day-hours-end').evaluate(el => el === document.activeElement));
    await page.screenshot({path: 'test-results/day-hours-editor-390.png'});
    await page.locator('#day-hours-reset').click();
    await waitFor(() => !busy && !document.querySelector('#day-hours-dialog').open);
    assert.equal(await page.evaluate(() => state.day.workday.customized), false);
    await page.locator('#go-today').click();
    await waitFor(() => !busy && selectedDay === state.today);
    await waitFor(() => state.day.date === state.today);
    assert.equal(await page.evaluate(() => state.day.workday.customized), false);
    await page.setViewportSize({width: 1280, height: 800});
    await page.evaluate(async () => {
      const config = await api('push/');
      const permission = Object.getOwnPropertyDescriptor(Notification, 'permission');
      Object.defineProperty(Notification, 'permission', {configurable: true, get: () => 'granted'});
      const originalGet = PushManager.prototype.getSubscription;
      const originalSubscribe = PushManager.prototype.subscribe;
      let subscription = null;
      PushManager.prototype.getSubscription = async () => subscription;
      PushManager.prototype.subscribe = async () => {
        window.companionSubscribeCalled = true;
        subscription = {toJSON: () => ({endpoint: 'https://fcm.googleapis.com/wp/browser-companion',
          keys: {p256dh: config.public_key, auth: 'AAAAAAAAAAAAAAAAAAAAAA'}}),
          unsubscribe: async () => {subscription = null; return true;}};
        return subscription;
      };
      window.restoreCompanionPush = () => {
        PushManager.prototype.getSubscription = originalGet;
        PushManager.prototype.subscribe = originalSubscribe;
        Object.defineProperty(Notification, 'permission', permission);
      };
    });
    await page.locator('#settings-open').click();
    await waitFor(() => !document.querySelector('#companion-toggle').disabled);
    await page.locator('#companion-toggle').click();
    await waitFor(() => document.querySelector('#companion-status').textContent === 'on' && !document.querySelector('#companion-toggle').disabled);
    assert.equal(await page.evaluate(async () => (await api('push/')).enabled), true);
    await page.locator('#companion-test').click();
    await waitFor(() => document.querySelector('#companion-help').textContent.startsWith('Test queued.'));
    await page.screenshot({path: 'test-results/phone-companion-1280.png'});
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#companion-toggle').scrollIntoViewIfNeeded();
    await page.screenshot({path: 'test-results/phone-companion-390.png'});
    assert(await page.locator('#settings-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.locator('#companion-toggle').click();
    await waitFor(() => document.querySelector('#companion-status').textContent === 'off' && !document.querySelector('#companion-toggle').disabled);
    assert.equal(await page.evaluate(async () => (await api('push/')).enabled), false);
    await page.getByRole('button', {name: 'Close settings', exact: true}).click();
    await page.evaluate(() => window.restoreCompanionPush());
    await page.setViewportSize({width: 1280, height: 800});
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
    await page.locator('#day-note').fill('Keyboard day note');
    await page.locator('#day-note').press('Enter');
    assert.equal(await page.locator('#day-note').inputValue(), 'Keyboard day note\n');
    assert.equal(await page.locator('#day-note-status').textContent(), 'Unsaved');
    await page.locator('#day-note').pressSequentially('Second line');
    await page.locator('#day-note').press('Control+Enter');
    await waitFor(() => document.querySelector('#day-note-status').textContent === 'Saved');
    assert.equal(await page.evaluate(async () => (await api(`notes/?period=day&date=${state.today}`)).text), 'Keyboard day note\nSecond line');
    await page.locator('#block-open').click();
    assert(await page.locator('#block-name').evaluate(input => input === document.activeElement));
    await page.locator('#block-name').fill('Keyboard draft');
    await page.locator('#block-name').press('Tab');
    assert(await page.locator('#block-start').evaluate(input => input === document.activeElement));
    await page.locator('#block-start').fill('09:10');
    assert.equal(await page.locator('#block-end').inputValue(), '09:40');
    assert(await page.locator('#block-start').evaluate(input => input === document.activeElement));
    await page.locator('#block-start').press('Enter');
    assert(await page.locator('#block-end').evaluate(input => input === document.activeElement));
    assert(await page.locator('#block-dialog').evaluate(dialog => dialog.open));
    await page.locator('#block-end').fill('10:20');
    await page.locator('#block-start').fill('09:30');
    assert.equal(await page.locator('#block-end').inputValue(), '10:20');
    assert(await page.locator('#block-end').evaluate(input => !!(input.compareDocumentPosition(document.querySelector('#block-date')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await page.screenshot({path: 'test-results/block-keyboard-entry.png'});
    await page.getByRole('button', {name: 'Close block editor', exact: true}).click();
    await page.locator('#timer-mode').click();
    await page.keyboard.press('Control+Alt+Shift+P');
    await page.waitForSelector('#manual-pomo-dialog[open]');
    const recordedDay = await page.evaluate(() => shiftDay(state.today, -1));
    await page.locator('#manual-pomo-task').fill('Forgotten browser pomo');
    await page.locator('#manual-pomo-date').fill(recordedDay);
    await page.locator('#manual-pomo-start').fill('03:00');
    await page.locator('#manual-pomo-minutes').fill('25');
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.locator('#manual-pomo-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
    await page.screenshot({path: 'test-results/manual-pomo-entry-390.png'});
    await page.locator('#manual-pomo-form button[type=submit]').click();
    await page.waitForSelector('#review-dialog[open]');
    await waitFor(() => !busy);
    const manualId = await page.evaluate(() => reviewing.id);
    await page.locator('#allocations .sand-control button').nth(2).click();
    await page.locator('#focus-control button').nth(1).click();
    await page.locator('#review-form button[type=submit]').click();
    await page.waitForSelector('#review-dialog[open]', {state: 'hidden'});
    await waitFor(() => !busy);
    await page.getByRole('button', {name: 'Review Forgotten browser pomo', exact: true}).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#review-delete').click();
    assert(await page.locator('#review-dialog').evaluate(dialog => dialog.open));
    await page.screenshot({path: 'test-results/delete-pomo-review-390.png'});
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#review-delete').click();
    await page.waitForSelector('#review-dialog[open]', {state: 'hidden'});
    await waitFor(() => !busy);
    assert(await page.evaluate(async id => !(await api(`state/?date=${selectedDay}`)).day.sessions.some(s => s.id === id), manualId));
    assert.equal(await page.getByRole('button', {name: 'Review Forgotten browser pomo', exact: true}).count(), 0);
    await page.setViewportSize({width: 1280, height: 800});
    await page.locator('#go-today').click();
    await waitFor(() => !busy && selectedDay === state.today);
    await page.locator("#task-title").fill("Browser task");
    await page.locator("#task-form button").click();
    await page.waitForSelector("#task-list .task-check");
    await page.locator("#task-list .task-check").click();
    await page.waitForSelector("#completed-task-list .checked");
    assert.equal(await page.locator("#task-list .task-row").count(), 0);
    await page.locator("#overview-view").click();
    await page.waitForSelector(".calendar-day.today .completed-result");
    assert((await page.locator(".calendar-day.today .completed-result").allTextContents()).some(text => text === "✓ Browser task"));
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
    await page.locator("#recurrence-list button").first().click();
    await page.locator("#recurrences-dialog [data-close]").click();
    assert.equal(await page.locator("#recurrences-dialog").evaluate((d) => d.open), false);
    assert(await page.locator("#recurring-view").isVisible());
    assert.equal(await page.locator(".recurrence-day").count(), 7);
    assert.equal(await page.locator(".recurrence-card").count(), 7);
    await page.evaluate(async () => {
      for (const [offset, title] of [[0, 'Alternating Work A'], [7, 'Alternating Work B']])
        await api('recurrences/', {title, kind: 'work', frequency: 'weekly', weekday: 0,
          interval_weeks: 4, anchor_date: shiftDay(monday(state.today), offset), start: '21:45', end: '22:45'});
      await openRecurrences();
    });
    assert.equal(await page.locator('.recurrence-card').count(), 9);
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height: 800});
      assert(await page.evaluate(() => {
        const original = templates;
        try {
          const lengths = [1, 5, 15, 30, 60, 120];
          const make = (id, start, end) => ({id, title: 'Duration ' + id, kind: 'meeting',
            frequency: 'weekly', weekday: 0, interval_weeks: 1,
            anchor_date: monday(state.today), effective_from: '1970-01-01', start, end});
          templates = lengths.map((minutes, index) => make(index + 1, '09:00',
            String(9 + Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0')));
          templates.push(make(7, '11:00', '11:05'));
          renderRecurrenceWeek();
          const cards = [...document.querySelectorAll('.recurrence-card')];
          const heights = cards.slice(0, 6).map(card => card.getBoundingClientRect().height);
          const adjacent = cards[6].getBoundingClientRect(), longest = cards[5].getBoundingClientRect();
          return heights.every((height, index) => Math.abs(height - lengths[index]) < .1) &&
            Math.abs(adjacent.top - longest.bottom) < .1 &&
            adjacent.width > longest.width * 5 &&
            cards.every(card => card.title.includes(card.querySelector('strong').textContent));
        } finally {
          templates = original;
          renderRecurrenceWeek();
        }
      }), 'Recurring heights follow real duration, including short and adjacent blocks');
      assert(await page.evaluate(() => {
        for (const day of document.querySelectorAll('.recurrence-day')) {
          const cards = [...day.querySelectorAll('.recurrence-card')].map(card => card.getBoundingClientRect());
          for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
            const a = cards[i], b = cards[j];
            if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) return false;
          }
        }
        const scroll = document.querySelector('#recurrence-list');
        return document.documentElement.scrollWidth <= window.innerWidth &&
          (window.innerWidth < 1000 || scroll.scrollWidth <= scroll.clientWidth + 1);
      }), 'Recurring cards stay separate, with scrolling inside the week');
      await page.locator('#recurrence-list').evaluate(list => list.scrollTop = list.scrollHeight);
      await page.screenshot({path: `test-results/recurring-week-${width}.png`});
    }
    await page.setViewportSize({width: 1280, height: 800});
    await page.getByRole('button', {name: /^Edit Alternating Work B/}).click();
    assert.equal(await page.locator('#repeat-title').inputValue(), 'Alternating Work B');
    await page.locator('#recurrences-dialog [data-close]').click();
    assert.equal(new URL(page.url()).pathname, "/recurring");
    await page.locator("#overview-view").click();
    await page.waitForURL(base + "/overview");
    await page.goBack();
    await page.waitForURL(base + '/recurring');
    await waitFor(() => !document.querySelector('#recurring-view').hidden && document.querySelectorAll('.recurrence-card').length === 9);
    assert.equal(await page.locator('#recurrences-dialog').evaluate(dialog => dialog.open), false);
    await page.goForward();
    await page.waitForURL(base + '/overview');
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
    await waitFor(
      () => document.querySelector("#day-note-status").textContent === "Saved",
    );
    for (const path of ["/overview", "/recurring", "/settings"]) {
      await page.goto(base + path);
      await waitFor(
        (path) =>
          path === "/overview"
            ? !document.querySelector("#overview").hidden
            : path === "/recurring" ? !document.querySelector("#recurring-view").hidden
            : document.querySelector("#settings-dialog").open,
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
        Math.abs(calendar.weekWidth - Math.max(calendar.viewport, 160 * 7 + 8 * 6)) < 1,
        `Seven readable days fill or scroll beyond viewport: ${JSON.stringify(calendar)}`,
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
      await work.locator('.work-reservation-heading').click();
      assert.equal(await page.locator('#block-name').inputValue(), 'Strategy');
      await page.getByRole('button', {name: 'Close block editor', exact: true}).click();
      await page.locator("#timer-finish").click();
      await page.waitForSelector("#review-dialog[open]");
      await waitFor(() => !busy);
      const ratedSessionId = await page.evaluate(() => reviewing.id);
      assert(await page.locator('#review-focus').isVisible());
      assert.deepEqual(await page.locator('#focus-control .lens-icon').evaluateAll(icons =>
        icons.map(icon => icon.getBoundingClientRect().width)), [7, 10, 13]);
      await page.locator('#focus-control button').nth(1).click();
      await page.locator('#focus-control button').nth(1).click();
      assert.equal(await page.locator('#focus-control').getAttribute('aria-label'), 'Focus 0 out of 3');
      await page.locator('#focus-control button').nth(2).click();
      await page.locator('#focus-control button').nth(1).click();
      await page.locator('#allocations .sand-control button').nth(2).click();
      await page.locator('#review-reflection').fill('Focused Strategy');
      await page.screenshot({path: 'test-results/focus-review-1280.png'});
      await page.setViewportSize({width: 390, height: 844});
      assert(await page.locator('#review-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
      await page.screenshot({path: 'test-results/focus-review-390.png'});
      await page.locator('#review-form button[type=submit]').click();
      await page.waitForSelector('#review-dialog[open]', {state: 'hidden'});
      await waitFor(() => !busy);
      const ratedSession = await page.evaluate(async id => (await api('state/')).day.sessions.find(s => s.id === id), ratedSessionId);
      assert.equal(ratedSession.focus_score, 2);
      assert.equal(ratedSession.effort, 3);
      for (const width of [1280, 390]) {
        await page.setViewportSize({width, height: 844});
        const ratedCard = page.locator('#timeline .has-focus-lenses').first();
        await ratedCard.scrollIntoViewIfNeeded();
        assert(await ratedCard.evaluate(card => {
          const lenses = [...card.querySelectorAll('.focus-lenses .lens-icon')].map(icon => icon.getBoundingClientRect());
          const piles = [...card.querySelectorAll('.session-metrics .sand-grain')].map(icon => icon.getBoundingClientRect());
          const bounds = card.getBoundingClientRect();
          return lenses.length === 2 && lenses[0].width === 7 && lenses[1].width === 10 &&
            piles.length === 3 && piles[0].height !== piles[1].height &&
            lenses.every(lens => lens.bottom <= piles[0].top) &&
            [...lenses, ...piles].every(icon => icon.right <= bounds.right && icon.left >= bounds.left);
        }), 'Lenses sit above the original uneven sand piles');
        await page.screenshot({path: `test-results/focus-timeline-${width}.png`});
      }
      await page.setViewportSize({width: 1280, height: 800});
      assert(await page.evaluate(() => {
        const marker = document.querySelector('#timeline .timeline-end .timeline-time');
        const rowTime = document.querySelector('#timeline > .timeline-row .timeline-time');
        return marker.textContent === state.day.workday.end_time &&
          Math.abs(marker.getBoundingClientRect().right - rowTime.getBoundingClientRect().right) < 1 &&
          state.day.plan.at(-1)?.kind !== 'break';
      }), 'Day end aligns with the time column and has no trailing planned break');
      await page.locator('#timeline .has-focus-lenses').first().click();
      assert.equal(await page.locator('#focus-control [aria-pressed=true]').count(), 2);
      await page.getByRole('button', {name: 'Close review', exact: true}).click();
      assert.equal(await page.locator("#timer-main").textContent(), "Start break");
      assert.equal(await page.locator('#app-favicon').getAttribute('data-mode'),'break');
      const breakIcon=await page.locator('#app-favicon').getAttribute('href');
      assert.equal((await page.request.get(new URL(breakIcon, base).href)).status(),200);
      await page.locator("#timer-main").click();
      await waitFor(() => !busy && document.querySelector("#timer-main").textContent === "Skip break");
      assert.equal(await page.locator('#app-favicon').getAttribute('href'),breakIcon);
      await page.locator("#auto-focus").check();
      await waitFor(() => !busy && state.preferences.auto_focus);
      await page.locator("#timer-main").click();
      await waitFor(() => !busy && !!state.active);
      assert.equal(await page.locator('#app-favicon').getAttribute('data-mode'),'focus');
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
    await page.locator('#today-view').click();
    await page.waitForLoadState('networkidle');
    for (const period of ['day','week','month','quarter']) {
      await page.evaluate(async period=>{
        const date=period==='day'?state.today:period==='week'?monday(state.today):period==='month'?month(state.today):quarter(state.today);
        await openPeriodReview(period,date);
      },period);
      await waitFor(()=>document.querySelector('#period-review-dialog').open&&!document.querySelector('#period-review-text').disabled);
      assert.equal(await page.locator('#period-review-context textarea,#period-review-context input,#period-review-context button').count(),0);
      if(period==='week')assert((await page.locator('#period-review-context').textContent()).includes('day reflection'));
      if(period==='month')assert((await page.locator('#period-review-context').textContent()).includes('week reflection'));
      if(period==='quarter')assert((await page.locator('#period-review-context').textContent()).includes('month reflection'));
      await page.locator('#period-review-text').fill(`**${period} reflection**\n\nGood progress on the proposal. The afternoon meeting broke up the work.\n\nNext time: leave more room between commitments.`);
      for(const width of [1280,390]) {
        await page.setViewportSize({width,height:width===390?844:900});
        await waitFor(()=>{const dialog=document.querySelector('#period-review-dialog');return dialog.scrollWidth<=dialog.clientWidth+1;});
        await page.screenshot({path:`test-results/review-${period}-${width}.png`});
      }
      await page.locator('#period-review-text').press('Control+Enter');
      await waitFor(()=>!reviewSaving&&!document.querySelector('#period-review-dialog').open);
    }
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#overview-view').click();
    await page.waitForSelector('#calendar-periods .week-row .note-actions button.text-button');
    await page.locator('#calendar-periods .week-row .note-actions button.text-button').click();
    await waitFor(()=>document.querySelector('#period-review-dialog').open&&!document.querySelector('#period-review-text').disabled);
    await page.locator('#period-review-skip').click();
    // A missing review resurfaces on a new visit, but never repeatedly in this visit.
    await page.evaluate(async()=>{
      await api('notes/',{period:'day',date:shiftDay(monday(state.today),-1),text:'Previous week activity'});
      await api('notes/',{period:'week',date:monday(shiftDay(state.today,-7)),text:''});
    });
    await page.reload();
    await waitFor(()=>document.querySelector('#period-review-dialog').open&&!document.querySelector('#period-review-text').disabled);
    const reminder=await page.evaluate(()=>({period:reviewPeriod.period,date:reviewPeriod.date}));
    await page.locator('#period-review-skip').click();
    await page.evaluate(()=>refresh());
    assert.equal(await page.locator('#period-review-dialog[open]').count(),0);
    await page.reload();
    await waitFor(()=>document.querySelector('#period-review-dialog').open&&!document.querySelector('#period-review-text').disabled);
    assert.deepEqual(await page.evaluate(()=>({period:reviewPeriod.period,date:reviewPeriod.date})),reminder);
    await page.locator('#period-review-text').fill('Reviewed before planning the next week.');
    await page.locator('#period-review-text').press('Control+Enter');
    await waitFor(()=>!reviewSaving&&!document.querySelector('#period-review-dialog').open);
    // Real autosave failure/retry presentation at desktop and phone sizes.
    await page.evaluate(() => openPeriodReview('day', state.today));
    await waitFor(()=>!document.querySelector('#period-review-text').disabled);
    await page.evaluate(() => {
      window.originalAutosaveApi=api;
      api=async(path,body)=>{if(path==='notes/'&&body)throw new Error('Offline');return originalAutosaveApi(path,body);};
    });
    await page.locator('#period-review-text').fill('Keep this review through a connection failure.');
    await page.waitForSelector('#period-review-status.note-save-error');
    for (const width of [1280,390]) {
      await page.setViewportSize({width,height:844});
      await waitFor(()=>{const dialog=document.querySelector('#period-review-dialog');return dialog.scrollWidth<=dialog.clientWidth+1;});
      await page.screenshot({path:`test-results/notes-autosave-error-${width}.png`});
    }
    await page.evaluate(() => {api=originalAutosaveApi;});
    await page.locator('#period-review-status').click();
    await waitFor(()=>document.querySelector('#period-review-status').textContent==='Saved');
    await page.locator('#period-review-save').click();
    await waitFor(()=>!document.querySelector('#period-review-dialog').open);
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
