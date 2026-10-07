"use strict";

const $ = (id) => document.getElementById(id);
let state = null;
let selectedDay = null;
let weekStart = null;
let overviewVisible = false;
let period = "week";
let weekData = null;
let serverOffset = 0;
let reviewing = null;
let editingBlock = null;
let requestVersion = 0;
let historyVersion = 0;
let noteVersion = 0;
let dayNoteDirty = false;
let periodNoteDirty = false;
let busy = false;
let lastExpiryRefresh = 0;
let toastTimeout;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action, label) {
  const node = el("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
}
function sandIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 44 32");
  svg.setAttribute("class", "sand-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute(
    "d",
    "M1 29 13 11 25 29z M16 29 29 4 43 29z M9 8h2v2H9z M21 3h2v2h-2z M34 1h2v2h-2z",
  );
  svg.append(path);
  return svg;
}
function sand(value, showEmpty = false) {
  const node = el("span", "sand-pile");
  node.setAttribute("role", "img");
  node.setAttribute(
    "aria-label",
    value === null ? "Effort not rated" : `${value} sand, effort`,
  );
  if (value === null) {
    node.append(el("span", "small muted", "Rate effort"));
    return node;
  }
  for (let i = 0; i < (showEmpty ? 5 : value); i++)
    node.append(el("i", `sand-grain${i >= value ? " empty" : ""}`));
  if (value === 0 && !showEmpty)
    node.append(el("span", "small muted", "0 sand"));
  return node;
}
function now() {
  return Date.now() + serverOffset;
}
function shiftDay(value, amount) {
  const day = new Date(value + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
}
function monday(value) {
  const weekday = new Date(value + "T12:00:00Z").getUTCDay();
  return shiftDay(value, -((weekday + 6) % 7));
}
function dateLabel(value, options = {}) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    ...options,
  }).format(new Date(value + "T12:00:00Z"));
}
function clock(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: state.preferences.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes} min`;
}
function csrf() {
  return document.querySelector("[name=csrfmiddlewaretoken]").value;
}
async function api(path, body) {
  const options = {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.headers["X-CSRFToken"] = csrf();
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`/api/${path}`, options);
  } catch {
    throw new Error(
      "Can't reach Paradeis. Your saved timer is safe. Check your connection and try again.",
    );
  }
  if (response.status === 401) {
    window.location.assign("/login/?next=/");
    throw new Error("Please sign in again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.status === 403
        ? "Your sign-in token expired. Refresh this page and try again."
        : "The server could not complete that request. Please try again.",
    );
  }
  if (!response.ok)
    throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
function showError(error, dialog = null) {
  const target = dialog ? dialog.querySelector(".dialog-error") : $("error");
  target.textContent = error.message || String(error);
  target.hidden = false;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    $("toast").hidden = true;
  }, 3000);
}
async function mutate(path, data, success, dialog = null) {
  if (busy) return false;
  busy = true;
  const submits = [...document.querySelectorAll('button[type="submit"]')];
  submits.forEach((b) => {
    b.disabled = true;
  });
  try {
    await api(path, data);
    if (dialog) dialog.close();
    await refresh();
    if (overviewVisible) await loadWeek();
    if (success) toast(success);
    return true;
  } catch (error) {
    showError(error, dialog?.open ? dialog : null);
    return false;
  } finally {
    busy = false;
    submits.forEach((b) => {
      b.disabled = false;
    });
    tick();
  }
}
async function refresh() {
  const version = ++requestVersion;
  const previous = state?.active;
  const data = await api(`state/${selectedDay ? `?date=${selectedDay}` : ""}`);
  if (version !== requestVersion) return;
  state = data;
  serverOffset = new Date(data.now).getTime() - Date.now();
  selectedDay = data.day.date;
  weekStart ||= monday(data.today);
  $("error").hidden = true;
  renderDay();
  tick();
  if (previous && !data.active) {
    const completed = data.pending.find((s) => s.id === previous.id);
    if (completed && !document.querySelector("dialog[open]"))
      openReview(completed);
  }
}
function summaryElement(value, caption, icon = false) {
  const node = el("div");
  if (icon) node.append(sandIcon());
  const text = el("div");
  text.append(
    el("span", "summary-value", value),
    el("span", "summary-caption", caption),
  );
  node.append(text);
  return node;
}
function renderHeading() {
  $("page-title").textContent = overviewVisible
    ? "See the days add up."
    : "A little room to focus.";
  $("heading-date").textContent = overviewVisible
    ? "A WIDER PERSPECTIVE"
    : dateLabel(selectedDay, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).toUpperCase();
  const summary =
    overviewVisible && weekData ? weekData.summary : state.day.summary;
  $("header-summary").replaceChildren(
    sandIcon(),
    summaryElement(
      `${summary.effort} sand`,
      `${duration(summary.seconds)} · ${summary.count} sessions`,
    ),
  );
}
function renderDay() {
  renderHeading();
  renderTasks();
  $("day-date").value = selectedDay;
  $("timeline-date").textContent =
    `${dateLabel(selectedDay, { weekday: "short", day: "numeric", month: "short" })} · ${state.preferences.day_start}–${state.preferences.day_end}`;
  $("timezone-label").textContent = state.preferences.timezone.replaceAll(
    "_",
    " ",
  );
  renderTimeline($("timeline"), state.day, false);
  const prompt = $("review-prompt");
  prompt.hidden = !state.pending.length;
  if (state.pending.length) {
    const first = state.pending[0];
    const text = el("div");
    text.append(
      el("h3", "", "A moment to notice."),
      el(
        "p",
        "muted",
        `${state.pending.length === 10 ? "10+" : state.pending.length} session${state.pending.length > 1 ? "s" : ""} to reflect on.`,
      ),
    );
    prompt.replaceChildren(
      text,
      button("Review →", "", () => openReview(first)),
    );
  }
}
function renderTasks() {
  const container = $("task-list");
  container.replaceChildren();
  const next = state.tasks.find((t) => !t.done);
  $("task-count").textContent = state.tasks.filter((t) => !t.done).length;
  if (!state.tasks.length)
    container.append(
      el(
        "p",
        "empty-tasks",
        "Start with one intention. You can always add another.",
      ),
    );
  for (const task of state.tasks) {
    const row = el(
      "div",
      `task-row${task.done ? " completed" : ""}${task.id === next?.id ? " next" : ""}`,
    );
    const toggle = button(
      task.done ? "✓" : "",
      `task-check${task.done ? " checked" : ""}`,
      () => mutate(`tasks/${task.id}/`, { action: "toggle" }),
      `${task.done ? "Reopen" : "Complete"} ${task.title}`,
    );
    toggle.setAttribute("aria-pressed", task.done);
    row.append(toggle, el("span", "task-title", task.title));
    const actions = el("div", "task-actions");
    if (task.id === next?.id) actions.append(el("span", "up-next", "UP NEXT"));
    else if (!task.done)
      actions.append(
        button(
          "↑",
          "",
          () =>
            mutate(
              `tasks/${task.id}/`,
              { action: "first" },
              "Moved to the top",
            ),
          `Make ${task.title} next`,
        ),
      );
    actions.append(
      button(
        "✎",
        "",
        () => {
          const title = window.prompt("Rename this intention", task.title);
          if (title?.trim())
            mutate(`tasks/${task.id}/`, { action: "rename", title });
        },
        `Rename ${task.title}`,
      ),
    );
    actions.append(
      button(
        "×",
        "",
        () => {
          if (
            task.done ||
            window.confirm(
              `Archive “${task.title}”? Your session history will be kept.`,
            )
          )
            mutate(`tasks/${task.id}/`, { action: "archive" });
        },
        `Archive ${task.title}`,
      ),
    );
    row.append(actions);
    container.append(row);
  }
}
function entries(day) {
  const trackedBlocks = new Set(
    day.sessions.filter((s) => s.kind === "meeting").map((s) => s.block_id),
  );
  return [
    ...day.sessions.map((s) => ({ ...s, type: "session" })),
    ...day.blocks
      .filter((b) => !trackedBlocks.has(b.id))
      .map((b) => ({ ...b, type: "block" })),
    ...day.plan.map((p) => ({ ...p, type: "plan" })),
  ].sort((a, b) => new Date(a.start) - new Date(b.start));
}
function timelineRow(item, compact) {
  const row = el("div", "timeline-row");
  row.append(el("span", "timeline-time", clock(item.start)));
  if (item.type === "plan" && item.kind === "break") {
    row.append(
      el(
        "div",
        "timeline-rest",
        `${duration((new Date(item.end) - new Date(item.start)) / 1000)} · breathe a little`,
      ),
    );
    return row;
  }
  const cls = ["timeline-item"];
  if (item.type === "plan") cls.push("planned");
  if (item.type === "block") cls.push("reserved", item.kind);
  if (item.type === "session" && item.status !== "completed")
    cls.push("running");
  let card;
  if (item.type === "session" && item.status === "completed")
    card = button(
      "",
      cls.join(" "),
      () => openReview(item),
      `Review ${item.title}, ${clock(item.start)}`,
    );
  else if (item.type === "block")
    card = button(
      "",
      cls.join(" "),
      () => openBlock(item),
      `Edit ${item.title}`,
    );
  else card = el("div", cls.join(" "));
  const title = item.type === "plan" ? "Room for focus" : item.title;
  card.append(el("p", "", title));
  if (item.allocations?.length > 1)
    card.append(
      el(
        "p",
        "small muted",
        item.allocations.map((a) => `${a.percent}% ${a.label}`).join(" · "),
      ),
    );
  const meta = el("div", "item-meta");
  let label = `${duration((new Date(item.end) - new Date(item.start)) / 1000)}`;
  if (item.type === "session")
    label =
      item.status === "completed"
        ? `${duration(item.elapsed)} · ${item.kind === "meeting" ? "meeting" : "focused"}`
        : item.status === "paused"
          ? "Paused"
          : "In progress";
  if (item.type === "block")
    label += item.kind === "meeting" ? " · meeting" : " · break";
  if (item.type === "plan") label += " · planned";
  meta.append(el("span", "", label));
  if (item.type === "session" && item.status === "completed")
    meta.append(sand(item.effort));
  card.append(meta);
  if (item.reflection) card.title = item.reflection;
  row.append(card);
  return row;
}
function renderTimeline(container, day, compact) {
  container.replaceChildren();
  const all = entries(day);
  let dividerPlaced = false;
  for (const item of all) {
    if (compact && item.type === "plan" && item.kind === "break") continue;
    if (
      !compact &&
      day.date === state.today &&
      !dividerPlaced &&
      new Date(item.start).getTime() >= now()
    ) {
      container.append(el("div", "timeline-divider", "FROM HERE"));
      dividerPlaced = true;
    }
    container.append(timelineRow(item, compact));
  }
  if (!all.length)
    container.append(
      el(
        "p",
        compact ? "empty-tasks" : "timeline-empty",
        day.date < state.today
          ? "A quiet page. No tracked sessions."
          : "Your day is open. Add a block or start a focus session.",
      ),
    );
}
function liveBlock() {
  return state?.live_block || null;
}
function tick() {
  if (!state) return;
  const active = state.active;
  const rest =
    !active &&
    state.break_until &&
    new Date(state.break_until).getTime() > now();
  const block = !active ? liveBlock() : null;
  const reservedBreak =
    block?.kind === "break" && new Date(block.end).getTime() > now();
  const meeting =
    block?.kind === "meeting" &&
    !block.tracked &&
    new Date(block.end).getTime() > now();
  let seconds = state.preferences.focus_minutes * 60;
  if (active)
    seconds =
      active.status === "paused"
        ? active.remaining
        : Math.max(
            0,
            Math.ceil((new Date(active.end).getTime() - now()) / 1000),
          );
  else if (reservedBreak)
    seconds = Math.max(
      0,
      Math.ceil((new Date(block.end).getTime() - now()) / 1000),
    );
  else if (rest)
    seconds = Math.max(
      0,
      Math.ceil((new Date(state.break_until).getTime() - now()) / 1000),
    );
  else if (meeting)
    seconds = Math.max(
      0,
      Math.ceil((new Date(block.end).getTime() - now()) / 1000),
    );
  const timeText = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  $("timer-time").textContent = timeText;
  document.title = active
    ? `${timeText} · ${active.status === "paused" ? "Paused" : "Focus"} · Paradeis`
    : "Paradeis · Make room for focus";
  $("timer-mode").textContent = active
    ? active.status === "paused"
      ? "A MOMENT OF PAUSE"
      : active.kind === "meeting"
        ? "ONE UNINTERRUPTED BLOCK"
        : "ONE THING AT A TIME"
    : reservedBreak || rest
      ? "A LITTLE BREATHING ROOM"
      : meeting
        ? "TIME FOR YOUR MEETING"
        : "TIME TO FOCUS";
  $("timer-cycle").textContent =
    active?.kind === "meeting"
      ? "MEETING"
      : `${state.preferences.focus_minutes} / ${state.preferences.short_break}`;
  const next = state.tasks.find((t) => !t.done);
  $("timer-task").textContent =
    active?.title ||
    (reservedBreak
      ? block.title
      : meeting
        ? block.title
        : rest
          ? "Step away. Let your mind wander."
          : next?.title || "One thing. Your full attention.");
  $("timer-main").textContent = active
    ? active.status === "paused"
      ? "Resume focus ▶"
      : "Pause Ⅱ"
    : reservedBreak
      ? "On a scheduled break"
      : rest
        ? "Skip break →"
        : meeting
          ? "Start meeting ▶"
          : "Start focus ▶";
  $("timer-main").disabled =
    !!reservedBreak || active?.kind === "meeting" || busy;
  $("timer-finish").hidden = !active;
  $("timer-cancel").hidden = !active;
  $("timer-hint").textContent = active
    ? active.status === "paused"
      ? "Time stands still until you’re ready."
      : `Until ${clock(active.end)} · your timer keeps time across refreshes.`
    : reservedBreak
      ? `You’ve made space until ${clock(block.end)}.`
      : rest
        ? "Your effort is saved. This time is yours."
        : meeting
          ? "Track the remaining meeting as one long session."
          : `${state.preferences.focus_minutes} minutes of focus, then a little breathing room.`;
  document
    .querySelector(".timer-card")
    .classList.toggle("resting", !!(rest || reservedBreak));
  const expired =
    (active?.status === "running" && seconds === 0) ||
    (!active &&
      state.break_until &&
      new Date(state.break_until).getTime() <= now()) ||
    (block && new Date(block.end).getTime() <= now());
  if (expired && now() - lastExpiryRefresh > 5000 && !busy) {
    lastExpiryRefresh = now();
    refresh().catch(showError);
  }
}
async function timerAction(action) {
  await mutate("timer/", {
    action,
    ...(state.active ? { id: state.active.id } : {}),
    ...(action === "start" &&
    liveBlock()?.kind === "meeting" &&
    !liveBlock().tracked
      ? { block_id: liveBlock().id }
      : {}),
  });
}
function openDialog(dialog) {
  const error = dialog.querySelector(".dialog-error");
  if (error) error.hidden = true;
  if (!dialog.open) dialog.showModal();
}
function openReview(session) {
  reviewing = session;
  $("review-meta").textContent =
    `${dateLabel(session.date, { day: "numeric", month: "short" })} · ${clock(session.start)} · ${duration(session.elapsed)} of ${session.kind === "meeting" ? "meeting time" : "focus"}`;
  $("review-reflection").value = session.reflection || "";
  $("effort-options").replaceChildren();
  for (let i = 0; i <= 5; i++) {
    const choice = el("label", "effort-choice");
    choice.dataset.effort = i;
    const radio = el("input");
    radio.type = "radio";
    radio.name = "effort";
    radio.value = i;
    radio.required = true;
    radio.checked = session.effort === i;
    radio.setAttribute("aria-label", `${i} sand of effort`);
    choice.append(sandIcon(), el("span", "", String(i)), radio);
    $("effort-options").append(choice);
  }
  $("allocations").replaceChildren();
  for (const allocation of session.allocations) addAllocation(allocation);
  if (!session.allocations.length)
    addAllocation({ label: session.title, percent: 100 });
  updateAllocationTotal();
  openDialog($("review-dialog"));
}
function addAllocation(allocation = {}) {
  const container = $("allocations");
  if (container.children.length >= 10) return;
  const row = el("div", "allocation-row");
  const controls = el("div", "allocation-controls");
  const select = el("select");
  select.setAttribute("aria-label", "Task for this part of the session");
  const custom = el("option", "", "Something else…");
  custom.value = "";
  select.append(custom);
  const tasks = [...state.tasks];
  if (allocation.task_id && !tasks.some((t) => t.id === allocation.task_id))
    tasks.push({ id: allocation.task_id, title: allocation.label });
  for (const task of tasks) {
    const option = el("option", "", task.title);
    option.value = task.id;
    select.append(option);
  }
  select.value = allocation.task_id || "";
  const percent = el("input");
  percent.type = "number";
  percent.min = "1";
  percent.max = "100";
  percent.required = true;
  percent.value = allocation.percent ?? 0;
  percent.className = "allocation-percent";
  percent.setAttribute("aria-label", "Percentage of session");
  const label = el("input", "allocation-label");
  label.maxLength = 200;
  label.required = true;
  label.placeholder = "What did you work on?";
  label.value = allocation.label || "";
  label.setAttribute("aria-label", "Task description");
  select.addEventListener("change", () => {
    if (select.value) label.value = select.selectedOptions[0].textContent;
  });
  percent.addEventListener("input", updateAllocationTotal);
  controls.append(
    select,
    percent,
    el("span", "small muted", "%"),
    button(
      "×",
      "icon-button",
      () => {
        if (container.children.length > 1) {
          row.remove();
          updateAllocationTotal();
        }
      },
      "Remove task split",
    ),
  );
  row.append(controls, label);
  container.append(row);
}
function updateAllocationTotal() {
  const total = [...document.querySelectorAll(".allocation-percent")].reduce(
    (sum, input) => sum + Number(input.value),
    0,
  );
  $("allocation-total").textContent =
    `${total}% of this session assigned${total === 100 ? " · all accounted for" : " · should add up to 100%"}`;
  $("allocation-add").disabled = $("allocations").children.length >= 10;
}
function openBlock(block = null) {
  editingBlock = block;
  $("block-title").textContent = block
    ? "A little space, reserved."
    : "Block out time";
  $("block-kind").value = block?.kind || "meeting";
  $("block-name").value = block?.title || "";
  $("block-date").value = block?.date || selectedDay;
  $("block-start").value = block?.start_time || "12:00";
  $("block-end").value = block?.end_time || "13:00";
  $("block-delete").hidden = !block;
  openDialog($("block-dialog"));
}
async function changeDay(day) {
  if (
    dayNoteDirty &&
    !window.confirm("Leave this day without saving your note?")
  )
    return;
  dayNoteDirty = false;
  selectedDay = day;
  try {
    await refresh();
    await loadDayNote();
  } catch (error) {
    showError(error);
  }
}
async function loadDayNote() {
  const day = selectedDay;
  const result = await api(`notes/?period=day&date=${day}`);
  if (selectedDay === day && !dayNoteDirty) {
    $("day-note").value = result.text;
    $("day-note-status").textContent = "";
  }
}
async function showView(overview) {
  overviewVisible = overview;
  $("day-view").hidden = overview;
  $("overview").hidden = !overview;
  $("today-view").classList.toggle("selected", !overview);
  $("overview-view").classList.toggle("selected", overview);
  $("today-view").setAttribute("aria-pressed", !overview);
  $("overview-view").setAttribute("aria-pressed", overview);
  renderHeading();
  if (overview) {
    try {
      await loadWeek();
      await loadPeriodNote();
    } catch (error) {
      showError(error);
    }
  }
}
async function loadWeek() {
  const version = ++historyVersion;
  const data = await api(`history/?start=${weekStart}`);
  if (version !== historyVersion) return;
  weekData = data;
  $("week-label").textContent =
    `${dateLabel(weekStart, { day: "numeric", month: "short" })} – ${dateLabel(shiftDay(weekStart, 6), { day: "numeric", month: "short", year: "numeric" })}`;
  $("week-summary").replaceChildren(
    summaryElement(`${data.summary.effort} sand`, "effort noticed", true),
    summaryElement(duration(data.summary.seconds), "time given"),
    summaryElement(
      `${data.summary.count} sessions`,
      data.summary.unrated
        ? `${data.summary.unrated} awaiting effort ratings`
        : "all accounted for",
    ),
  );
  $("week-days").replaceChildren();
  for (const day of data.days) {
    const column = el(
      "section",
      `week-day${day.date === state.today ? " current" : ""}`,
    );
    const header = button(
      "",
      "week-day-header",
      async () => {
        await changeDay(day.date);
        await showView(false);
      },
      `Open ${day.date}`,
    );
    header.append(
      el("span", "day-name", dateLabel(day.date, { weekday: "short" })),
      el("span", "day-number", dateLabel(day.date, { day: "numeric" })),
    );
    column.append(
      header,
      el(
        "div",
        "day-summary",
        `${duration(day.summary.seconds)} · ${day.summary.effort} sand${day.summary.unrated ? ` · ${day.summary.unrated} unrated` : ""}`,
      ),
    );
    const timeline = el("div");
    renderTimeline(timeline, day, true);
    column.append(timeline);
    $("week-days").append(column);
  }
  renderHeading();
}
async function navigateWeek(next) {
  if (
    periodNoteDirty &&
    !window.confirm("Leave without saving this reflection?")
  )
    return;
  periodNoteDirty = false;
  weekStart = next;
  try {
    await loadWeek();
    await loadPeriodNote();
  } catch (error) {
    showError(error);
  }
}
async function loadPeriodNote() {
  if (periodNoteDirty) return;
  const version = ++noteVersion;
  const result = await api(`notes/?period=${period}&date=${weekStart}`);
  if (version !== noteVersion || periodNoteDirty) return;
  $("period-note").value = result.text;
  $("period-note-status").textContent = "";
  $("period-note-label").textContent =
    period === "week"
      ? `Week of ${dateLabel(weekStart, { day: "numeric", month: "long", year: "numeric" })}`
      : `${dateLabel(weekStart, { month: "long", year: "numeric" })} · the month containing this week’s Monday`;
}
async function changePeriod(next) {
  if (
    periodNoteDirty &&
    !window.confirm("Switch without saving this reflection?")
  )
    return;
  periodNoteDirty = false;
  period = next;
  for (const value of ["week", "month"]) {
    $(`note-${value}-tab`).classList.toggle("selected", value === period);
    $(`note-${value}-tab`).setAttribute("aria-pressed", value === period);
  }
  try {
    await loadPeriodNote();
  } catch (error) {
    showError(error);
  }
}

$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await mutate("tasks/", { title: $("task-title").value })) {
    $("task-title").value = "";
    $("task-title").focus();
  }
});
$("timer-main").addEventListener("click", () => {
  if (state.active)
    timerAction(state.active.status === "paused" ? "resume" : "pause");
  else if (state.break_until && new Date(state.break_until).getTime() > now())
    timerAction("skip_break");
  else timerAction("start");
});
$("timer-finish").addEventListener("click", () => timerAction("finish"));
$("timer-cancel").addEventListener("click", () => {
  if (window.confirm("Discard this session? It won’t count towards your day."))
    timerAction("cancel");
});
$("block-open").addEventListener("click", () => openBlock());
$("block-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await mutate(
    `blocks/${editingBlock ? `${editingBlock.id}/` : ""}`,
    {
      date: $("block-date").value,
      start: $("block-start").value,
      end: $("block-end").value,
      kind: $("block-kind").value,
      title: $("block-name").value,
    },
    "Time reserved",
    $("block-dialog"),
  );
});
$("block-delete").addEventListener("click", async () => {
  if (window.confirm("Remove this block from your day?"))
    await mutate(
      `blocks/${editingBlock.id}/`,
      { action: "delete" },
      "Time freed up",
      $("block-dialog"),
    );
});
$("allocation-add").addEventListener("click", () => {
  addAllocation();
  const inputs = [...document.querySelectorAll(".allocation-percent")];
  const each = Math.floor(100 / inputs.length);
  inputs.forEach((input, index) => {
    input.value = index === 0 ? 100 - each * (inputs.length - 1) : each;
  });
  updateAllocationTotal();
});
$("review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const effort = document.querySelector('input[name="effort"]:checked');
  if (!effort) return;
  const allocations = [...document.querySelectorAll(".allocation-row")].map(
    (row) => ({
      task_id: Number(row.querySelector("select").value) || null,
      label: row.querySelector(".allocation-label").value,
      percent: Number(row.querySelector(".allocation-percent").value),
    }),
  );
  await mutate(
    `sessions/${reviewing.id}/review/`,
    {
      effort: Number(effort.value),
      reflection: $("review-reflection").value,
      allocations,
    },
    "A little effort, noticed.",
    $("review-dialog"),
  );
});
$("settings-open").addEventListener("click", () => {
  if (!state) return;
  for (const [key, value] of Object.entries(state.preferences))
    $(key).value = value;
  openDialog($("settings-dialog"));
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = {};
  for (const key of [
    "focus_minutes",
    "short_break",
    "long_break",
    "long_every",
  ])
    data[key] = Number($(key).value);
  for (const key of ["day_start", "day_end", "timezone"])
    data[key] = $(key).value;
  await mutate("settings/", data, "Your rhythm is saved", $("settings-dialog"));
});
document
  .querySelectorAll("[data-close]")
  .forEach((node) =>
    node.addEventListener("click", () => node.closest("dialog").close()),
  );
$("day-prev").addEventListener("click", () =>
  changeDay(shiftDay(selectedDay, -1)),
);
$("day-next").addEventListener("click", () =>
  changeDay(shiftDay(selectedDay, 1)),
);
$("go-today").addEventListener("click", () => changeDay(state.today));
$("day-date").addEventListener("change", () => {
  if ($("day-date").value) changeDay($("day-date").value);
});
$("today-view").addEventListener("click", () => {
  if (state) showView(false);
});
$("overview-view").addEventListener("click", () => {
  if (state) showView(true);
});
$("week-prev").addEventListener("click", () =>
  navigateWeek(shiftDay(weekStart, -7)),
);
$("week-next").addEventListener("click", () =>
  navigateWeek(shiftDay(weekStart, 7)),
);
$("this-week").addEventListener("click", () =>
  navigateWeek(monday(state.today)),
);
$("note-week-tab").addEventListener("click", () => changePeriod("week"));
$("note-month-tab").addEventListener("click", () => changePeriod("month"));
$("day-note").addEventListener("input", () => {
  dayNoteDirty = true;
  $("day-note-status").textContent = "Unsaved";
});
$("period-note").addEventListener("input", () => {
  periodNoteDirty = true;
  $("period-note-status").textContent = "Unsaved";
});
$("day-note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("day-note").value;
  try {
    await api("notes/", { period: "day", date: selectedDay, text: value });
    if ($("day-note").value === value) dayNoteDirty = false;
    $("day-note-status").textContent = dayNoteDirty ? "Unsaved" : "Saved";
  } catch (error) {
    showError(error);
  }
});
$("period-note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("period-note").value;
  try {
    await api("notes/", { period, date: weekStart, text: value });
    if ($("period-note").value === value) periodNoteDirty = false;
    $("period-note-status").textContent = periodNoteDirty ? "Unsaved" : "Saved";
  } catch (error) {
    showError(error);
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dayNoteDirty || periodNoteDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy) refresh().catch(showError);
});
setInterval(tick, 250);
setInterval(() => {
  if (!document.hidden && !busy) refresh().catch(showError);
}, 15000);
(async () => {
  try {
    await refresh();
    await loadDayNote();
  } catch (error) {
    showError(error);
  }
})();
