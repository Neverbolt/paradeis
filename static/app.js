"use strict";
const $ = (id) => document.getElementById(id);
let state,
  selectedDay = null,
  serverOffset = 0,
  busy = false,
  overviewVisible = false,
  recurringVisible = false;
let reviewFocus = null;
let reviewing,
  editingBlock,
  templates = [],
  editingTemplate,
  requestVersion = 0,
  historyVersion = 0;
let calendarAnchor,
  calendarData,
  loadingCalendar = false,
  expiryRefresh = 0,
  toastTimeout;
const taskDrafts = new Map();
const noteReads = new Map();
let completionTitle = "";
let nextTopicChoice = "", autoStarting = false, autoRetryAt = 0;
function titleMode() {
  return localStorage.getItem("tab-title-mode") === "completion" ? "completion" : "countdown";
}
let calendarWeek,
  calendarDayWidth = 208;
const drafts = new Map(),
  savedNotes = new Map(),
  notified = new Set();
const el = (tag, cls = "", text = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
};
function button(text, cls, action, label) {
  const n = el("button", cls, text);
  n.type = "button";
  n.onclick = action;
  if (label) n.setAttribute("aria-label", label);
  return n;
}
function sand(value) {
  const n = el("span", "sand-pile");
  n.setAttribute("aria-label", `${value || 0} sand`);
  for (let i = 0; i < (value || 0); i++) n.append(el("i", "sand-grain"));
  return n;
}
function lens(size) {
  const icon = el("i", "lens-icon");
  icon.style.setProperty("--lens-size", `${[7, 10, 13][size - 1]}px`);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
function lenses(value) {
  const icons = el("span", "focus-lenses");
  icons.setAttribute("aria-label", `Focus ${value} out of 3`);
  icons.title = `Focus: ${value} out of 3`;
  for (let i = 1; i <= value; i++) icons.append(lens(i));
  return icons;
}
const now = () => Date.now() + serverOffset;
function shiftDay(day, amount) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function monday(day) {
  return shiftDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}
function month(day, offset = 0) {
  const d = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
}
function dateLabel(day, options = {}) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    ...options,
  }).format(new Date(`${day}T12:00:00Z`));
}
function clock(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: state.preferences.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
function localDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: state.preferences.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k).value)
    .join("-");
}
function duration(value) {
  const seconds = Math.max(0, Math.ceil(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function stats(s) {
  const minutes = Math.floor((s?.seconds || 0) / 60);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min · ${s?.count || 0} sessions`;
}
function renderStats(target, summary) {
  const total = el("span", "sand-total", String(summary?.effort || 0));
  total.append(el("i", "sand-symbol"));
  total.setAttribute("aria-label", `${summary?.effort || 0} sand`);
  target.replaceChildren(
    document.createTextNode(stats(summary) + " · "),
    total,
  );
}
function csrf() {
  return document.querySelector('[name="csrfmiddlewaretoken"]').value;
}
async function api(path, body) {
  const options = {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.headers["X-CSRFToken"] = csrf();
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/${path}`, options);
  if (response.status === 401) {
    location.assign("/login/?next=/");
    throw new Error("Sign in again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.status === 403
        ? "Refresh the page and try again."
        : "Server error. Please try again.",
    );
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function showError(error, dialog) {
  const target = dialog?.open
    ? dialog.querySelector(".dialog-error")
    : $("error");
  target.textContent = error.message || String(error);
  target.hidden = false;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ($("toast").hidden = true), 2500);
}
async function mutate(path, data, dialog, close = true) {
  if (busy) return false;
  busy = true;
  tick();
  try {
    await api(path, data);
    if (dialog && close) dialog.close();
    await refresh();
    if (overviewVisible) await loadCalendar({ preserve: true });
    return true;
  } catch (e) {
    showError(e, dialog);
    return false;
  } finally {
    busy = false;
    tick();
  }
}
function openDialog(dialog) {
  dialog.querySelectorAll(".dialog-error").forEach((n) => (n.hidden = true));
  if (!dialog.open) dialog.showModal();
}
async function refresh() {
  const version = ++requestVersion,
    previous = state?.active;
  const data = await api(`state/${selectedDay ? `?date=${selectedDay}` : ""}`);
  if (version !== requestVersion) return;
  if (state && selectedDay === state.today && data.today !== state.today) {
    selectedDay = data.today;
    await refresh();
    if (overviewVisible) await loadCalendar({ preserve: true });
    return;
  }
  if (data.active && data.active.id !== previous?.id) completionTitle = "";
  state = data;
  serverOffset = Date.parse(data.now) - Date.now();
  selectedDay = data.day.date;
  calendarAnchor ||= month(data.today);
  $("error").hidden = true;
  renderDay();
  tick();
  clearTimeout(deadlineTimeout);
  if (data.active?.status === "running") {
    const session = data.active;
    deadlineTimeout = setTimeout(
      () => {
        notifyEnd(session);
        refresh().catch(showError);
      },
      Math.max(0, Date.parse(session.end) - now()) + 20,
    );
  }
  if (previous && !data.active) {
    notifyEnd(previous);
    const finished = data.pending.find((s) => s.id === previous.id);
    if (finished && !document.hidden && !document.querySelector("dialog[open]"))
      openReview(finished);
  }
}
function renderDay() {
  $("timezone-label").textContent = state.preferences.timezone;
  $("timeline-date").textContent = dateLabel(state.day.date, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  renderStats($("day-summary"), state.day.summary);
  renderTimeline($("timeline"), state.day);
  renderFocusControls();
  if (recurringVisible && $("recurrence-week").dataset.month !== localDate(now()).slice(0, 7)) renderRecurrenceWeek();
  if (reviewing && $("review-dialog").open)
    $("review-overrun").hidden = !!state.active || !extendable(reviewing);
  renderTasks();
  const pending = state.pending[0];
  $("review-prompt").hidden = !pending;
  if (pending) {
    const card = timelineCard({ ...pending, type: "session" });
    card.classList.add("pending-review");
    card.prepend(
      el(
        "span",
        "review-context small",
        `Review · ${dateLabel(pending.date, { weekday: "short" })} ${clock(pending.start)}${state.pending.length > 1 ? ` · +${state.pending.length - 1}` : ""}`,
      ),
    );
    $("review-prompt").replaceChildren(card);
  }
  loadDayNote().catch(showError);
}
let draggedTask = null;
async function reorderTasks(ids, focusId = null, control = ".task-handle") {
  if (busy) return;
  busy = true;
  try {
    await api("tasks/reorder/", { ids });
  } catch (error) {
    showError(error);
  } finally {
    try {
      await refresh();
      if (focusId) {
        const row = $("task-list").querySelector(`[data-task-id="${focusId}"]`);
        const target = row?.querySelector(control);
        (target?.disabled ? row.querySelector(".task-handle") : target)?.focus();
      }
    } catch (error) {
      showError(error);
    }
    busy = false;
    tick();
  }
}
function moveTask(id, offset, control) {
  const ids = state.tasks.filter(t => !t.done).map(t => t.id);
  const index = ids.indexOf(id), target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  reorderTasks(ids, id, control);
}
function renderTasks() {
  if (draggedTask !== null) return;
  $("task-count").textContent = state.tasks.filter((t) => !t.done).length;
  const list = $("task-list");
  // A server refresh must not replace the input being edited.
  const completed = $("completed-task-list");
  if (
    (list.contains(document.activeElement) ||
      completed.contains(document.activeElement)) &&
    document.activeElement.matches("input.task-title")
  )
    return;
  list.replaceChildren();
  completed.replaceChildren();
  const pending = state.tasks.filter(t => !t.done);
  const first = pending[0];
  const ordered = [...state.tasks].sort((a, b) =>
    Number(a.done && !a.completed_on) - Number(b.done && !b.completed_on));
  let undatedHeading = false;
  for (const t of ordered) {
    if (t.done && !t.completed_on && !undatedHeading) {
      completed.append(el("p", "small muted task-group-label", "Undated"));
      undatedHeading = true;
    }
    const row = el("div", `task-row${t.done ? " completed" : ""}`);
    row.dataset.taskId = t.id;
    if (!t.done) {
      const handle = button("⠿", "task-handle", () => {}, `Drag to reorder ${t.title}`);
      handle.draggable = !busy && pending.length > 1;
      handle.ondragstart = e => {
        if (busy || pending.length < 2) { e.preventDefault(); return; }
        draggedTask = t.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(t.id));
        row.classList.add("dragging");
      };
      handle.ondragend = () => {
        draggedTask = null;
        if (!busy) renderTasks();
      };
      row.ondragover = e => {
        if (draggedTask === null || busy) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const moving = list.querySelector(`[data-task-id="${draggedTask}"]`);
        if (moving && moving !== row) {
          const bounds = row.getBoundingClientRect();
          list.insertBefore(moving, e.clientY < bounds.top + bounds.height / 2
            ? row : row.nextSibling);
        }
      };
      row.ondrop = e => {
        if (draggedTask === null || busy) return;
        e.preventDefault();
        const id = draggedTask;
        const ids = [...list.children].map(r => Number(r.dataset.taskId));
        draggedTask = null;
        list.querySelector(".dragging")?.classList.remove("dragging");
        reorderTasks(ids, id);
      };
      row.append(handle);
    }
    const input = el("input", "task-title");
    input.value = taskDrafts.get(t.id) ?? t.title;
    input.maxLength = 200;
    input.setAttribute("aria-label", "Task name");
    input.dataset.taskId = t.id;
    input.oninput = () => taskDrafts.set(t.id, input.value);
    input.onblur = async () => {
      const title = input.value.trim();
      if (!title) {
        input.value = t.title;
        taskDrafts.delete(t.id);
        return;
      }
      if (title === t.title) {
        taskDrafts.delete(t.id);
        return;
      }
      try {
        await api(`tasks/${t.id}/`, { action: "rename", title });
        if (taskDrafts.get(t.id)?.trim() === title) taskDrafts.delete(t.id);
        await refresh();
      } catch (error) {
        showError(error);
      }
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = t.title;
        taskDrafts.delete(t.id);
        input.blur();
      }
    };
    row.append(
      button(
        t.done ? "✓" : "",
        `task-check${t.done ? " checked" : ""}`,
        () => mutate(`tasks/${t.id}/`, { action: "toggle" }),
        `${t.done ? "Reopen" : "Complete"} ${t.title}`,
      ),
      input,
    );
    const actions = el("div", "task-actions");
    if (t.done && !t.completed_on)
      actions.append(button("↳", "", () => mutate(`tasks/${t.id}/`,
        {action: "date_completed", date: selectedDay}),
        `Attach ${t.title} to ${selectedDay}`));
    if (!t.done) {
      const index = pending.findIndex(task => task.id === t.id);
      const up = button("↑", "task-up", () => moveTask(t.id, -1, ".task-up"), `Move ${t.title} up`);
      const down = button("↓", "task-down", () => moveTask(t.id, 1, ".task-down"), `Move ${t.title} down`);
      up.disabled = busy || index === 0;
      down.disabled = busy || index === pending.length - 1;
      actions.append(up, down);
    }
    if (!t.done && t.id !== first?.id)
      actions.append(
        button(
          "⇈",
          "",
          () => mutate(`tasks/${t.id}/`, { action: "first" }),
          "Move to top",
        ),
      );
    actions.append(
      button(
        "×",
        "",
        () => {
          taskDrafts.delete(t.id);
          mutate(`tasks/${t.id}/`, { action: "archive" });
        },
        "Archive task",
      ),
    );
    row.append(actions);
    (t.done ? completed : list).append(row);
  }
}
function entries(day) {
  const tracked = new Set(day.sessions.map((s) => s.block_id));
  return [
    ...day.sessions.map((s) => ({ ...s, type: "session" })),
    ...day.blocks
      .filter((b) => b.kind !== "work" && !tracked.has(b.id))
      .map((b) => ({ ...b, type: "block" })),
    ...day.plan.map((p) => ({ ...p, type: "plan", title: p.title || "Focus" })),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
function timelineCard(item) {
  const pastMeeting =
    item.type === "block" &&
    item.kind === "meeting" &&
    Date.parse(item.end) <= now();
  const cls = `timeline-item${item.type === "plan" ? " planned" : item.type === "block" ? ` reserved ${item.kind}` : item.status !== "completed" ? " running" : ""}`;
  const card =
    item.type === "block"
      ? button(
          "",
          cls,
          () => (pastMeeting ? reviewMeeting(item) : openBlock(item)),
          `${pastMeeting ? "Review" : "Edit"} ${item.title}`,
        )
      : item.status === "completed"
        ? button("", cls, () => openReview(item), `Review ${item.title}`)
        : el("div", cls);
  card.append(el("p", "", item.title));
  if (item.allocations?.length > 1) {
    const chips = el("div", "allocation-chips");
    for (const a of item.allocations) {
      const chip = el("span", "allocation-chip", a.label);
      chip.append(sand(a.sand));
      chips.append(chip);
    }
    card.append(chips);
  }
  const meta = el("div", "item-meta"),
    details = el("span", "item-details");
  details.append(
    el(
      "span",
      "",
      item.type === "session"
        ? item.status === "completed"
          ? `${duration(item.elapsed)}${item.kind === "meeting" ? " · meeting" : ""}`
          : item.status === "paused"
            ? "Paused"
            : "Running"
        : `${duration((Date.parse(item.end) - Date.parse(item.start)) / 1000)}${item.type === "block" ? ` · ${item.kind}${item.template_id ? " ↻" : ""}` : ""}`,
    ),
  );
  if (item.reflection)
    details.append(el("span", "item-note", ` · ${item.reflection}`));
  meta.append(details);
  if (item.status === "completed") {
    if (item.kind === "focus" && item.focus_score > 0) {
      const metrics = el("span", "session-metrics");
      card.classList.add("has-session-metrics", "has-focus-lenses");
      metrics.append(lenses(item.focus_score), sand(item.effort));
      meta.append(metrics);
    } else {
      meta.append(sand(item.effort));
      if (item.kind === "focus" && item.focus_score === 0) card.title = "Focus: 0 out of 3";
    }
  }
  card.append(meta);
  return card;
}
function renderTimeline(container, day) {
  const previousScroll = container.scrollTop;
  container.replaceChildren();
  const works = day.blocks.filter(b => b.kind === "work")
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const units = [];
  const groups = new Map();
  const workAt = value => works.find(work => Date.parse(work.start) <= value && value < Date.parse(work.end));
  for (const work of works) {
    const group = el("section", "work-reservation");
    group.dataset.workId = work.id;
    group.setAttribute("aria-label", `Work · ${work.title} · ${clock(work.start)}–${clock(work.end)}`);
    const heading = button("", "work-reservation-heading", () => openBlock(work),
      `Edit Work reservation ${work.title}`);
    heading.append(el("span", "work-reservation-label", "Work"),
      el("strong", "work-reservation-title", work.title),
      el("span", "work-reservation-range", `${clock(work.start)}–${clock(work.end)}`));
    const body = el("div", "work-reservation-items");
    group.append(heading, body);
    groups.set(work.id, body);
    units.push({start: Date.parse(work.start), node: group});
  }
  const all = entries(day);
  const current =
    day.date === state.today
      ? all.find(
          (item) => item.id === state.active?.id && item.type === "session",
        ) ||
        all.find(
          (item) =>
            Date.parse(item.start) <= now() && Date.parse(item.end) > now(),
        ) ||
        all.find((item) => Date.parse(item.start) >= now())
      : null;
  const rows = new Map();
  for (const item of all) {
    if (
      container.id !== "timeline" &&
      item.type === "plan" &&
      item.kind === "break"
    )
      continue;
    const row = el(
      "div",
      `timeline-row${item === current ? " current-time" : ""}`,
    );
    row.dataset.start = item.start;
    row.append(el("span", "timeline-time", clock(item.start)));
    if (item.type === "plan" && item.kind === "break")
      row.append(
        el(
          "div",
          "timeline-rest",
          `Break · ${duration((Date.parse(item.end) - Date.parse(item.start)) / 1000)}`,
        ),
      );
    else row.append(timelineCard(item));
    rows.set(item, row);
    const work = workAt(Date.parse(item.start));
    if (work) groups.get(work.id).append(row);
    else units.push({start: Date.parse(item.start), node: row});
  }
  if (day.date === state.today) {
    const marker = el("div", "now-marker", `Now · ${clock(now())}`);
    marker.setAttribute("aria-label", `Current time ${clock(now())}`);
    const work = workAt(now());
    const body = work && groups.get(work.id);
    const currentRow = rows.get(current);
    if (body) {
      const next = currentRow?.parentNode === body ? currentRow :
        [...body.children].find(row => Date.parse(row.dataset.start) >= now());
      body.insertBefore(marker, next || null);
    } else if (currentRow && !currentRow.closest(".work-reservation")) {
      const unit = units.find(unit => unit.node === currentRow);
      units.splice(units.indexOf(unit), 0, {start: unit.start, node: marker});
    } else units.push({start: now(), node: marker});
  }
  units.sort((a, b) => a.start - b.start);
  container.append(...units.map(unit => unit.node));
  if (!all.length && !works.length) container.append(el("p", "timeline-empty", "No sessions"));
  if (all.length || works.length) {
    const end = Math.max(...[...all, ...works].map(item => Date.parse(item.end)));
    const marker = el("div", "timeline-end");
    marker.setAttribute("aria-label", `Day ends at ${clock(end)}`);
    marker.append(el("span", "timeline-time", clock(end)), el("span", "timeline-end-label", "End"));
    container.append(marker);
  }
  container.scrollTop = previousScroll;
  if (container.id === "timeline" && !overviewVisible && day.date === state.today)
    requestAnimationFrame(() => followCurrentTime(container));
}
function followCurrentTime(container) {
  const row = container.querySelector(".current-time") || container.querySelector(".now-marker");
  if (!row || !container.clientHeight) return;
  const box = row.getBoundingClientRect(),
    parent = container.getBoundingClientRect();
  if (box.top < parent.top + 10 || box.bottom > parent.bottom - 10)
    container.scrollTop += box.top - parent.top - 12;
}
async function reviewMeeting(block) {
  if (busy) return;
  busy = true;
  try {
    const data = await api("timer/", {
      action: "record_meeting",
      block_id: block.id,
    });
    await refresh();
    if (overviewVisible) await loadCalendar({ preserve: true });
    openReview(data.session);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    tick();
  }
}
function remaining(s) {
  return s.status === "running"
    ? Math.max(0, (Date.parse(s.end) - now()) / 1000)
    : s.remaining;
}
function nextSeconds(ignore = false) {
  let value = state.next_requested;
  if (state.next_block)
    value = Math.min(
      value,
      Math.max(
        0,
        Math.floor((Date.parse(state.next_block.start) - now()) / 1000) -
          (ignore ? 0 : state.preferences.short_break * 60),
      ),
    );
  return value;
}
function extendable(s) {
  return (
    s &&
    s.can_overrun &&
    (s.status === "running" ||
      s.status === "paused" ||
      (s.status === "completed" &&
        now() - Date.parse(s.end) < 3600000 &&
        state.last_completed?.id === s.id))
  );
}
function renderFocusControls() {
  const select = $("timer-topic");
  const choice = state.active?.kind === "focus" ? state.active.topic_choice || "" : nextTopicChoice;
  select.replaceChildren();
  const add = (value, label) => {const option = el("option", "", label); option.value = value; select.append(option);};
  add("", `Default · ${state.active?.topic_default || state.default_topic || "Open focus"}`);
  for (const task of state.tasks.filter(t => !t.done)) add(String(task.id), task.title);
  add("open", "Open focus");
  select.value = choice;
  if (select.selectedIndex < 0) {select.value = ""; nextTopicChoice = "";}
  $("auto-focus").checked = !!state.preferences.auto_focus;
  $("auto-break").checked = !!state.preferences.auto_break;
}
$("timer-topic").onchange = () => {
  if (state.active?.kind === "focus") timerAction("set_topic", {topic: $("timer-topic").value});
  else nextTopicChoice = $("timer-topic").value;
};
for (const id of ["auto-focus", "auto-break"]) $(id).onchange = () => {
  autoRetryAt = 0;
  mutate("timer/", {action: "configure_auto", auto_focus: $("auto-focus").checked,
    auto_break: $("auto-break").checked});
};
$("timer-skip-break").onclick = () => timerAction("skip_break");
function currentBlock() {
  return [state.live_block, state.next_block].find(block => block &&
    Date.parse(block.start) <= now() && now() < Date.parse(block.end)) || null;
}
function tick() {
  if (!state) return;
  const taskRows = [...$("task-list").children];
  taskRows.forEach((row, index) => {
    const up = row.querySelector(".task-up"), down = row.querySelector(".task-down"),
      handle = row.querySelector(".task-handle");
    if (up) up.disabled = busy || index === 0;
    if (down) down.disabled = busy || index === taskRows.length - 1;
    if (handle) handle.draggable = !busy && taskRows.length > 1;
  });
  const a = state.active, block = currentBlock();
  const resting = !a && !block && Date.parse(state.break_until) > now();
  const waitingBreak = !a && !block && !resting ? state.pending_break : null;
  $("timer-topic").hidden = !!block || resting || !!waitingBreak || a?.kind === "meeting";
  $("timer-topic").disabled = busy;
  for (const id of ["auto-focus", "auto-break"]) $(id).disabled = busy;
  $("timer-skip-break").hidden = !waitingBreak;
  $("timer-skip-break").disabled = busy;
  let seconds, mode, task, label;
  if (a) {
    seconds = remaining(a);
    mode =
      a.kind === "meeting"
        ? "Meeting"
        : a.status === "paused"
          ? "Paused"
          : "Focus";
    task = a.title;
    label =
      a.kind === "meeting"
        ? "Finish"
        : a.status === "paused"
          ? "Resume"
          : "Pause";
  } else if (block) {
    seconds = Math.max(0, (Date.parse(block.end) - now()) / 1000);
    mode = block.kind === "meeting" ? "Meeting" : "Break";
    task = block.title;
    label = "Start meeting";
  } else if (resting) {
    seconds = (Date.parse(state.break_until) - now()) / 1000;
    mode = "Break";
    task = "";
    label = "Skip break";
  } else if (waitingBreak) {
    seconds = waitingBreak.pending_break_seconds;
    mode = "Break";
    task = "Ready when you are";
    label = "Start break";
  } else {
    seconds = nextSeconds();
    mode = "Focus";
    task = nextTopicChoice === "open" ? "Open focus" :
      state.tasks.find(t => String(t.id) === nextTopicChoice)?.title || state.default_topic || "";
    label = "Start";
  }
  const waiting = !a && !block && !resting && !waitingBreak && seconds < 1 &&
    state.next_block && Date.parse(state.next_block.start) > now();
  if (waiting) {
    seconds = (Date.parse(state.next_block.start) - now()) / 1000;
    mode = state.next_block.kind === "meeting" ? "Meeting soon" : "Break soon";
    task = state.next_block.title;
    label = `Starts at ${clock(state.next_block.start)}`;
  }
  const tabTitle = titleMode() === "completion"
    ? completionTitle || "Paradeis"
    : `${duration(seconds)} · Paradeis`;
  if (document.title !== tabTitle) document.title = tabTitle;
  const [minutes, secondPart] = duration(seconds).split(":");
  $("timer-minutes").textContent = minutes;
  $("timer-seconds").textContent = `:${secondPart}`;
  $("timer-mode").textContent = mode;
  $("timer-task").textContent = task;
  $("timer-main").textContent = label;
  $("timer-main").disabled =
    busy || waiting ||
    (!a && block && (block.kind === "break" || block.tracked)) ||
    (!a && !block && !resting && seconds < 1);
  $("timer-time").disabled = (!!block && !a) || !!waitingBreak || resting;
  $("timer-cycle").textContent =
    `${state.day.sessions.filter((s) => s.status === "completed").length} completed`;
  for (const id of ["timer-finish", "timer-cancel", "timer-overrun"])
    $(id).disabled = busy;
  $("timer-finish").hidden = !a || a.kind === "meeting";
  $("timer-cancel").hidden = !a;
  $("timer-overrun").hidden =
    !extendable(a || state.last_completed) ||
    (!!block && !a && block.kind === "break");
  $("timer-ignore-break").hidden =
    !!a ||
    !!block ||
    resting || !!waitingBreak ||
    !state.next_block ||
    nextSeconds(true) <= nextSeconds();
  $("timer-ignore-break").disabled = busy || nextSeconds(true) < 1;
  document
    .querySelector(".timer-card")
    .classList.toggle("resting", mode === "Break");
  if (a?.status === "running" && seconds <= 0) {
    notifyEnd(a);
    if (now() - expiryRefresh > 1500) {
      expiryRefresh = now();
      refresh().catch(showError);
    }
  } else if (
    !a &&
    ((state.live_block && Date.parse(state.live_block.end) <= now()) ||
      (!state.live_block && state.next_block && Date.parse(state.next_block.start) <= now()) ||
      (state.break_until && !resting && Date.parse(state.break_until) <= now()))
  ) {
    if (now() - expiryRefresh > 1500) {
      expiryRefresh = now();
      refresh().catch(showError);
    }
  }
  const automaticBreak = waitingBreak && state.preferences.auto_break;
  if (!busy && !autoStarting && now() >= autoRetryAt && (automaticBreak || state.can_auto_start)) {
    autoStarting = true;
    mutate("timer/", {action: automaticBreak ? "auto_break" : "auto_start"})
      .then(ok => {if (!ok) autoRetryAt = now() + 15000;})
      .finally(() => {autoStarting = false;});
  }
}
async function timerAction(action, extra = {}) {
  await mutate("timer/", {
    action,
    ...(state.active ? { id: state.active.id } : {}),
    ...extra,
  });
}
$("timer-main").onclick = () => {
  const a = state.active, b = currentBlock();
  if (a)
    timerAction(
      a.kind === "meeting"
        ? "finish"
        : a.status === "paused"
          ? "resume"
          : "pause",
    );
  else if (b && Date.parse(b.end) > now()) {
    askNotificationPermission();
    timerAction("start", { block_id: b.id });
  } else if (Date.parse(state.break_until) > now()) timerAction("skip_break");
  else if (state.pending_break) timerAction("start_break");
  else {
    askNotificationPermission();
    timerAction("start", {topic: nextTopicChoice});
    nextTopicChoice = "";
  }
};
$("timer-ignore-break").onclick = () => {
  askNotificationPermission();
  timerAction("start", { ignore_break: true, topic: nextTopicChoice });
  nextTopicChoice = "";
};
$("timer-finish").onclick = () => timerAction("finish");
$("timer-cancel").onclick = () => timerAction("cancel");
$("timer-overrun").onclick = () =>
  timerAction("overrun", { id: (state.active || state.last_completed).id });
$("timer-time").onclick = () => {
  $("timer-time").hidden = true;
  $("duration-form").hidden = false;
  $("duration-input").value = duration(
    state.active ? remaining(state.active) : state.next_requested,
  );
  $("duration-input").focus();
  $("duration-input").select();
};
function closeDuration() {
  $("duration-form").hidden = true;
  $("timer-time").hidden = false;
}
$("duration-input").onkeydown = (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeDuration();
  }
};
$("duration-form").onsubmit = async (e) => {
  e.preventDefault();
  const raw = $("duration-input").value.trim();
  if (!/^\d+(?::[0-5]\d)?$/.test(raw)) {
    $("duration-input").setCustomValidity("Use minutes or minutes:seconds.");
    $("duration-input").reportValidity();
    return;
  }
  const [minutes, seconds = "0"] = raw.split(":"),
    value = Number(minutes) * 60 + Number(seconds);
  if (await timerActionResult(value)) closeDuration();
};
$("duration-input").oninput = () => $("duration-input").setCustomValidity("");
async function timerActionResult(seconds) {
  return mutate(
    "timer/",
    state.active
      ? { action: "resize", id: state.active.id, seconds }
      : { action: "set_next", seconds },
  );
}
function openReview(s) {
  reviewing = s;
  $("review-delete").hidden = s.kind !== "focus";
  reviewFocus = s.focus_score ?? null;
  $("review-focus").hidden = s.kind !== "focus";
  renderReviewFocus();
  $("review-title").textContent = s.kind === "meeting" ? "Meeting" : "Focus";
  $("review-meta").textContent = `${clock(s.start)} · ${duration(s.elapsed)}`;
  $("review-reflection").value = s.reflection || "";
  $("allocations").replaceChildren();
  for (const a of s.allocations.length
    ? s.allocations
    : [{ label: s.title, sand: 0 }])
    addAllocation(a);
  addAllocation();
  updateSand();
  $("review-overrun").hidden = !!state.active || !extendable(s);
  openDialog($("review-dialog"));
}
function renderReviewFocus() {
  const control = $("focus-control");
  control.replaceChildren();
  for (let value = 1; value <= 3; value++) {
    const choice = button("", "focus-choice", () => {
      reviewFocus = reviewFocus === value ? 0 : value;
      renderReviewFocus();
    }, `${value} ${value === 1 ? "lens" : "lenses"} of focus`);
    choice.title = `${["Low focus", "Steady focus", "Deep focus"][value - 1]} · click again for zero`;
    choice.setAttribute("aria-pressed", reviewFocus != null && value <= reviewFocus);
    choice.append(lens(value));
    control.append(choice);
  }
  control.setAttribute("aria-label", reviewFocus == null ? "Focus not rated" : `Focus ${reviewFocus} out of 3`);
}
function addAllocation(a = {}) {
  const row = el("div", "allocation-row");
  row.dataset.sand = a.sand || 0;
  if (a.task_id) row.dataset.taskId = a.task_id;
  const input = el("input");
  input.value = a.label || "";
  input.placeholder = "Task";
  input.maxLength = 200;
  input.setAttribute("aria-label", "Task worked on");
  input.oninput = () => {
    for (const field of $("allocations").querySelectorAll("input")) field.setCustomValidity("");
    updateSand();
  };
  input.onblur = () => {
    if (!input.value.trim() && row !== $("allocations").lastElementChild) {
      row.remove();
      updateSand();
    }
  };
  const control = el("div", "sand-control");
  for (let i = 1; i <= 5; i++)
    control.append(
      button(
        "",
        "",
        () => {
          row.dataset.sand = Number(row.dataset.sand) === i ? i - 1 : i;
          updateSand();
        },
        `${i} sand`,
      ),
    );
  row.append(
    input,
    control,
    button(
      "×",
      "icon-button muted",
      () => {
        row.remove();
        updateSand();
      },
      "Remove task",
    ),
  );
  $("allocations").append(row);
}
function updateSand() {
  const list = $("allocations");
  if (!list.lastElementChild || list.lastElementChild.querySelector("input").value.trim())
    addAllocation();
  const rows = [...list.children];
  const filled = rows.filter(r => r.querySelector("input").value.trim());
  for (const r of rows) {
    const empty = !r.querySelector("input").value.trim();
    if (empty) r.dataset.sand = 0;
    r.querySelector(".sand-control").hidden = empty;
    r.querySelector('[aria-label="Remove task"]').hidden = empty;
    r.querySelector("input").disabled = empty && filled.length >= 200;
  }
  const total = filled.reduce((n, r) => n + Number(r.dataset.sand), 0);
  $("allocation-total").textContent = `${total} / 5 sand`;
  for (const r of rows)
    r.querySelectorAll(".sand-control button").forEach((b, index) => {
      const value = index + 1,
        count = Number(r.dataset.sand);
      b.classList.toggle("filled", value <= count);
      b.setAttribute("aria-pressed", value <= count);
      b.disabled = value > count && total - count + value > 5;
    });
}
$("review-form").onsubmit = async (e) => {
  e.preventDefault();
  const filled = [...$("allocations").children].filter(r => r.querySelector("input").value.trim());
  if (!filled.length) {
    const input = $("allocations").querySelector("input");
    input.setCustomValidity("Add a task worked on before saving.");
    input.reportValidity();
    return;
  }
  await mutate(
    `sessions/${reviewing.id}/review/`,
    {
      reflection: $("review-reflection").value,
      focus_score: reviewing.kind === "focus" ? reviewFocus : null,
      allocations: filled.map((r) => ({
        task_id: r.dataset.taskId ? Number(r.dataset.taskId) : null,
        label: r.querySelector("input").value.trim(),
        sand: Number(r.dataset.sand),
      })),
    },
    $("review-dialog"),
  );
};
$("review-overrun").onclick = () =>
  mutate("timer/", { action: "overrun", id: reviewing.id }, $("review-dialog"));
$("review-delete").onclick = async () => {
  if (!confirm("Delete this pomo and its sand/focus ratings?")) return;
  if (await mutate(`sessions/${reviewing.id}/delete/`, {}, $("review-dialog")))
    reviewing = null;
};
function openManualPomo() {
  const start = now() - state.preferences.focus_minutes * 60000;
  $("manual-pomo-task").value = "";
  $("manual-pomo-date").value = selectedDay === state.today || selectedDay > localDate(now())
    ? localDate(start) : selectedDay;
  $("manual-pomo-start").value = clock(start);
  $("manual-pomo-minutes").value = state.preferences.focus_minutes;
  openDialog($("manual-pomo-dialog"));
  $("manual-pomo-task").focus();
}
document.addEventListener("keydown", e => {
  if (e.code !== "KeyP" || !e.ctrlKey || !e.altKey || !e.shiftKey || e.metaKey ||
      e.repeat || e.isComposing || e.defaultPrevented || busy || !state ||
      document.querySelector("dialog[open]") ||
      e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  openManualPomo();
});
$("manual-pomo-form").onsubmit = async e => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  try {
    const result = await api("sessions/", {title: $("manual-pomo-task").value,
      date: $("manual-pomo-date").value, start: $("manual-pomo-start").value,
      minutes: Number($("manual-pomo-minutes").value)});
    $("manual-pomo-dialog").close();
    selectedDay = result.session.date;
    await showView(false);
    openReview(result.session);
  } catch (error) { showError(error, $("manual-pomo-dialog")); }
  finally { busy = false; tick(); }
};
function openBlock(b = null) {
  editingBlock = b;
  const rounded = Math.ceil((now() + 1) / 300000) * 300000;
  $("block-kind").value = b?.kind || "meeting";
  $("block-name").value = b?.title || "";
  $("block-date").value =
    b?.date || (selectedDay === state.today ? localDate(rounded) : selectedDay);
  $("block-start").value = b?.start_time || clock(rounded);
  $("block-end").value =
    b?.end_time ||
    (localDate(rounded + 3600000) === localDate(rounded)
      ? clock(rounded + 3600000)
      : "23:59");
  $("block-delete").hidden = !b;
  $("block-repeat-controls").hidden = !!b;
  $("block-repeat").checked = false;
  $("block-template-edit").hidden = !b?.template_id;
  openDialog($("block-dialog"));
}
$("block-open").onclick = () => openBlock();
$("block-form").onsubmit = (e) => {
  e.preventDefault();
  const data = {
    title: $("block-name").value,
    kind: $("block-kind").value,
    date: $("block-date").value,
    start: $("block-start").value,
    end: $("block-end").value,
  };
  if (!editingBlock && $("block-repeat").checked)
    data.repeat = {
      frequency: $("block-interval").value === "daily" ? "daily" : "weekly",
      interval_weeks:
        $("block-interval").value === "daily"
          ? 1
          : Number($("block-interval").value),
    };
  mutate(
    `blocks/${editingBlock ? `${editingBlock.id}/` : ""}`,
    data,
    $("block-dialog"),
  );
};
$("block-delete").onclick = () =>
  mutate(`blocks/${editingBlock.id}/`, { action: "delete" }, $("block-dialog"));
function recurrenceMonthDates(template, today) {
  const first = month(today), last = shiftDay(month(today, 1), -1), dates = [];
  for (let day = first; day <= last; day = shiftDay(day, 1)) {
    if (day < (template.effective_from || template.anchor_date)) continue;
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    if (template.frequency === "daily" || (weekday === template.weekday &&
        Math.floor((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${template.anchor_date}T12:00:00Z`)) / 604800000) % template.interval_weeks === 0))
      dates.push(day);
  }
  return dates;
}
function recurrenceLayout(items) {
  const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const sorted = items.map(template => ({template, start: minute(template.start),
    end: minute(template.end)}))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.template.id - b.template.id);
  let cluster = [], lanes = [], stop = -1;
  const finish = () => cluster.forEach(item => item.columns = lanes.length);
  for (const item of sorted) {
    if (item.start >= stop) { finish(); cluster = []; lanes = []; stop = -1; }
    let lane = lanes.findIndex(end => end <= item.start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = item.end;
    item.lane = lane;
    cluster.push(item);
    stop = Math.max(stop, item.end);
  }
  finish();
  return sorted;
}
function renderRecurrenceWeek() {
  const week = $("recurrence-week"), today = localDate(now());
  const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const days = Array.from({length: 7}, (_, weekday) => recurrenceLayout(
    templates.filter(t => t.frequency === "daily" || t.weekday === weekday)));
  const start = Math.floor(Math.min(minutes(state.preferences.day_start),
    ...days.flat().map(item => item.start)) / 60) * 60;
  const end = Math.ceil(Math.max(minutes(state.preferences.day_end),
    ...days.flat().map(item => item.end)) / 60) * 60;
  week.replaceChildren();
  const widths = days.map(items => Math.max(112, ...items.map(item => item.columns * 120)));
  week.style.gridTemplateColumns = `44px ${widths.map(width => `minmax(${width}px, 1fr)`).join(" ")}`;
  week.style.minWidth = `max(100%, ${44 + widths.reduce((sum, width) => sum + width, 0)}px)`;
  week.style.setProperty("--schedule-height", `${end - start}px`);
  week.dataset.month = today.slice(0, 7);
  $("recurring-month").textContent = `${dateLabel(month(today), {month: "long", year: "numeric"})} · ${templates.length} schedules`;
  $("recurrence-empty").hidden = templates.length > 0;
  const ruler = el("div", "recurrence-ruler");
  ruler.append(el("div", "recurrence-day-heading", "Time"));
  const scale = el("div", "recurrence-day-slots");
  for (let time = start; time <= Math.min(end, 1440); time += 60) {
    const label = el("span", "recurrence-hour", `${String(Math.floor(time / 60)).padStart(2, "0")}:00`);
    label.style.top = `${time - start}px`;
    scale.append(label);
  }
  ruler.append(scale);
  week.append(ruler);
  for (const [weekday, name] of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].entries()) {
    const day = el("section", "recurrence-day");
    day.setAttribute("aria-label", name);
    day.append(el("h2", "recurrence-day-heading", name));
    const slots = el("div", "recurrence-day-slots");
    for (const item of days[weekday]) {
      const t = item.template, dates = recurrenceMonthDates(t, today);
      const cadence = t.frequency === "daily" ? "Daily" : t.interval_weeks === 1 ? "Weekly" : `Every ${t.interval_weeks} weeks`;
      const monthDates = !dates.length ? "No dates this month" : t.frequency === "daily" ? "Every day" :
        `${dateLabel(month(today), {month: "short"})} ${dates.map(date => Number(date.slice(-2))).join(", ")}`;
      const card = button("", `recurrence-card ${t.kind}`, () => editRecurrence(t),
        `Edit ${t.title} · ${name} · ${t.start}–${t.end} · ${cadence}`);
      card.dataset.templateId = t.id;
      card.style.top = `${item.start - start}px`;
      const duration = item.end - item.start;
      card.style.height = `${duration}px`;
      if (duration < 30) card.classList.add("compact");
      if (duration < 60) card.classList.add("brief");
      card.style.left = `calc(${item.lane / item.columns * 100}% + 2px)`;
      card.style.width = `calc(${100 / item.columns}% - 4px)`;
      const body = el("span", "recurrence-card-body");
      body.append(el("strong", "", t.title), el("span", "recurrence-card-time", `${t.start}–${t.end}`),
        el("span", "recurrence-card-detail", `${t.kind === "work" ? "Work" : t.kind === "meeting" ? "Meeting" : "Break"} · ${cadence}`),
        el("span", "recurrence-card-dates", monthDates));
      if (t.timezone && t.timezone !== state.preferences.timezone)
        body.append(el("span", "recurrence-card-detail", t.timezone));
      card.append(body);
      card.setAttribute("aria-description", `${monthDates}${t.timezone ? ` · ${t.timezone}` : ""}`);
      card.title = `${t.title} · ${t.start}–${t.end} · ${cadence} · ${monthDates}${t.timezone ? ` · ${t.timezone}` : ""}`;
      slots.append(card);
    }
    day.append(slots);
    week.append(day);
  }
}
async function openRecurrences(id) {
  closeRouteDialogs();
  setRoute("/recurring");
  recurringVisible = true;
  overviewVisible = false;
  $("day-view").hidden = true;
  $("overview").hidden = true;
  $("recurring-view").hidden = false;
  updateViewButtons("recurrences-open");
  try {
    const loaded = (await api("recurrences/")).templates;
    if (!recurringVisible) return;
    templates = loaded;
    renderRecurrenceWeek();
    if (id) editRecurrence(templates.find(t => t.id === id));
  } catch (e) { showError(e); }
}
function editRecurrence(t) {
  if (!t) return;
  editingTemplate = t;
  $("recurrence-form").hidden = false;
  openDialog($("recurrences-dialog"));
  $("recurrence-delete").hidden = !t.id;
  for (const [field, key] of [
    ["frequency", "frequency"],
    ["title", "title"],
    ["kind", "kind"],
    ["weekday", "weekday"],
    ["interval", "interval_weeks"],
    ["start", "start"],
    ["end", "end"],
    ["anchor", "anchor_date"],
  ])
    $(`repeat-${field}`).value = t[key];
  updateRepeatFrequency();
}
function updateRepeatFrequency() {
  $("repeat-weekly").hidden = $("repeat-frequency").value === "daily";
}
$("repeat-frequency").onchange = updateRepeatFrequency;
$("recurrence-add").onclick = () => {
  const rounded = Math.ceil((now() + 1) / 300000) * 300000;
  editRecurrence({
    title: "",
    kind: "meeting",
    frequency: "weekly",
    weekday:
      new Date(localDate(rounded) + "T12:00:00Z").getUTCDay() === 0
        ? 6
        : new Date(localDate(rounded) + "T12:00:00Z").getUTCDay() - 1,
    interval_weeks: 1,
    start: clock(rounded),
    end:
      localDate(rounded + 3600000) === localDate(rounded)
        ? clock(rounded + 3600000)
        : "23:59",
    anchor_date: localDate(rounded),
  });
};
$("recurrences-open").onclick = () => openRecurrences();
$("block-template-edit").onclick = () => {
  $("block-dialog").close();
  openRecurrences(editingBlock.template_id);
};
$("recurrence-form").onsubmit = async (e) => {
  e.preventDefault();
  const saved = await mutate(
    `recurrences/${editingTemplate.id ? editingTemplate.id + "/" : ""}`,
    {
      title: $("repeat-title").value,
      kind: $("repeat-kind").value,
      frequency: $("repeat-frequency").value,
      weekday: Number($("repeat-weekday").value),
      interval_weeks: Number($("repeat-interval").value),
      anchor_date: $("repeat-anchor").value,
      start: $("repeat-start").value,
      end: $("repeat-end").value,
    },
    $("recurrences-dialog"),
    false,
  );
  if (saved) { $("recurrences-dialog").close(); await openRecurrences(); }
};
$("recurrence-delete").onclick = async () => {
  const saved = await mutate(
    `recurrences/${editingTemplate.id}/`,
    { action: "delete" },
    $("recurrences-dialog"),
    false,
  );
  if (saved) { $("recurrences-dialog").close(); await openRecurrences(); }
};
async function loadDayNote() {
  const day = selectedDay,
    key = `day:${day}`;
  const version = (noteReads.get(key) || 0) + 1;
  noteReads.set(key, version);
  const n = await api(`notes/?period=day&date=${day}`);
  if (noteReads.get(key) !== version) return;
  savedNotes.set(key, n.text);
  if (selectedDay !== day) return;
  $("day-note").value = drafts.get(key) ?? n.text;
  $("day-note-status").textContent = drafts.has(key) ? "Unsaved" : "";
}
$("day-note").oninput = () => {
  drafts.set(`day:${selectedDay}`, $("day-note").value);
  $("day-note-status").textContent = "Unsaved";
};
async function saveNote(period, day, textarea, status) {
  const key = `${period}:${day}`,
    text = textarea.value;
  try {
    await api("notes/", { period, date: day, text });
    noteReads.set(key, (noteReads.get(key) || 0) + 1);
    savedNotes.set(key, text);
    if (drafts.get(key) === text) drafts.delete(key);
    if (calendarData) calendarData.notes[key] = text;
    status.textContent = drafts.has(key) ? "Unsaved" : "Saved";
  } catch (e) {
    showError(e);
  }
}
$("day-note-form").onsubmit = (e) => {
  e.preventDefault();
  saveNote("day", selectedDay, $("day-note"), $("day-note-status"));
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey ||
      e.isComposing || e.repeat || e.defaultPrevented ||
      !(e.target instanceof HTMLTextAreaElement) || !e.target.form)
    return;
  e.preventDefault();
  e.target.form.requestSubmit();
});
function noteEditor(period, day, summary, title) {
  const key = `${period}:${day}`,
    wrapper = el(
      "section",
      period === "day" ? "daily-summary" : "period-editor",
    );
  const heading = el("div", "section-heading");
  heading.append(el("h2", "", title), el("span", "small muted"));
  renderStats(heading.lastChild, summary);
  wrapper.append(heading);
  const form = el("form"),
    textarea = el("textarea");
  textarea.rows = 2;
  textarea.maxLength = 10000;
  textarea.placeholder = "Notes";
  textarea.setAttribute("aria-label", `${title} summary`);
  textarea.dataset.note = key;
  textarea.value =
    drafts.get(key) ?? savedNotes.get(key) ?? calendarData.notes[key] ?? "";
  const actions = el("div", "note-actions"),
    status = el("span", "small muted", drafts.has(key) ? "Unsaved" : "");
  status.setAttribute("aria-live", "polite");
  textarea.oninput = () => {
    drafts.set(key, textarea.value);
    status.textContent = "Unsaved";
  };
  const save = el("button", "secondary small", "Save");
  save.type = "submit";
  actions.append(status, save);
  form.append(textarea, actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    saveNote(period, day, textarea, status);
  };
  wrapper.append(form);
  return wrapper;
}
async function changeDay(day) {
  selectedDay = day;
  await showView(false);
}
function updateViewButtons(selected) {
  for (const id of ["today-view", "overview-view", "recurrences-open"]) {
    $(id).classList.toggle("selected", id === selected);
    $(id).setAttribute("aria-pressed", id === selected);
  }
}
async function showView(overview, updateUrl = true) {
  if (updateUrl) {
    closeRouteDialogs();
    setRoute(overview ? "/overview" : "/");
  }
  recurringVisible = false;
  $("recurring-view").hidden = true;
  overviewVisible = overview;
  $("day-view").hidden = overview;
  $("overview").hidden = !overview;
  updateViewButtons(overview ? "overview-view" : "today-view");
  try {
    if (overview) await loadCalendar({ target: state.today });
    else await refresh();
  } catch (e) {
    showError(e);
  }
}
$("home-link").onclick = (e) => {
  e.preventDefault();
  selectedDay = state.today;
  showView(false);
};
$("today-view").onclick = () => showView(false);
$("overview-view").onclick = () => showView(true);
$("day-prev").onclick = () => changeDay(shiftDay(selectedDay, -1));
$("day-next").onclick = () => changeDay(shiftDay(selectedDay, 1));
$("go-today").onclick = () => changeDay(state.today);
function stride() {
  return (
    calendarDayWidth +
    (parseFloat(
      getComputedStyle($("calendar-scroll")).getPropertyValue("--day-gap"),
    ) || 8)
  );
}
async function loadCalendar({ target, preserve = false } = {}) {
  const version = ++historyVersion,
    oldStart = calendarData?.days[0].date,
    oldScroll = $("calendar-scroll").scrollLeft;
  loadingCalendar = true;
  const first = monday(month(calendarAnchor, -1)),
    last = shiftDay(monday(shiftDay(month(calendarAnchor, 2), -1)), 6);
  try {
    const data = await api(`history/?start=${first}&end=${last}`);
    if (version !== historyVersion) return;
    calendarData = data;
    for (const [key, value] of Object.entries(data.notes))
      savedNotes.set(key, value);
    renderCalendar();
    if (preserve && oldStart) {
      const delta = (Date.parse(first) - Date.parse(oldStart)) / 86400000;
      $("calendar-scroll").scrollLeft = oldScroll - delta * stride();
    } else {
      const date = monday(target || calendarWeek || calendarAnchor),
        index = data.days.findIndex((d) => d.date === date);
      $("calendar-scroll").scrollLeft = Math.max(0, index) * stride();
    }
  } finally {
    if (version === historyVersion) {
      loadingCalendar = false;
      updateCalendarWeek();
    }
  }
}
function completedTasks(day) {
  const group = el("section", "day-completed-tasks");
  group.setAttribute("aria-label", "Completed tasks");
  group.append(el("h3", "small muted", "Completed"));
  for (const task of day.completed_tasks || []) {
    const row = el("p", "completed-result", `✓ ${task.title}`);
    group.append(row);
  }
  return group;
}
function renderCalendar() {
  const grid = $("calendar-grid"),
    days = calendarData.days;
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${days.length}, var(--day-width))`;
  days.forEach((day, index) => {
    const card = el(
      "article",
      `calendar-day${day.date === state.today ? " today" : ""}${day.date === monday(day.date) ? " monday" : ""}`,
    );
    card.style.gridColumn = index + 1;
    const header = button(
      "",
      "calendar-day-header",
      () => changeDay(day.date),
      `Open ${day.date}`,
    );
    header.append(
      el("span", "", dateLabel(day.date, { weekday: "short", month: "short" })),
      el("strong", "", dateLabel(day.date, { day: "numeric" })),
    );
    const timeline = el("div", "timeline");
    renderTimeline(timeline, day);
    card.append(
      header,
      timeline,
      noteEditor("day", day.date, day.summary, day.date),
    );
    if (day.completed_tasks?.length) card.lastChild.prepend(completedTasks(day));
    grid.append(card);
  });
  for (let i = 0; i < days.length; i += 7)
    addPeriod(
      "week",
      days[i].date,
      i,
      7,
      `Week · ${dateLabel(days[i].date, { month: "short", day: "numeric" })}`,
    );
  for (let offset = -1; offset <= 1; offset++) {
    const first = month(calendarAnchor, offset),
      next = month(first, 1),
      index = days.findIndex((d) => d.date === first),
      length = (Date.parse(next) - Date.parse(first)) / 86400000;
    addPeriod(
      "month",
      first,
      index,
      length,
      dateLabel(first, { month: "long", year: "numeric" }),
    );
  }
  resizeEditors();
}
function addPeriod(period, day, index, length, title) {
  if (index < 0) return;
  const group = el("section", `period-group ${period}`);
  group.style.gridColumn = `${index + 1} / span ${length}`;
  group.dataset.period = `${period}:${day}`;
  group.append(
    noteEditor(
      period,
      day,
      calendarData.period_summaries[`${period}:${day}`],
      title,
    ),
  );
  $("calendar-grid").append(group);
}
function updateCalendarWeek() {
  if (!calendarData) return;
  const index = Math.max(
    0,
    Math.min(
      calendarData.days.length - 7,
      Math.round($("calendar-scroll").scrollLeft / (stride() * 7)) * 7,
    ),
  );
  calendarWeek = calendarData.days[index].date;
  $("calendar-label").textContent =
    `${dateLabel(calendarWeek, { month: "short", day: "numeric" })} – ${dateLabel(shiftDay(calendarWeek, 6), { month: "short", day: "numeric", year: "numeric" })}`;
  renderStats(
    $("calendar-total"),
    calendarData.period_summaries[`week:${calendarWeek}`],
  );
}
function resizeEditors() {
  const scroll = $("calendar-scroll"),
    width = scroll.clientWidth;
  if (!width) return;
  const oldStride = stride(),
    weekIndex = Math.round(scroll.scrollLeft / (oldStride * 7));
  const gap =
    parseFloat(getComputedStyle(scroll).getPropertyValue("--day-gap")) || 8;
  calendarDayWidth = (width - gap * 6) / 7;
  scroll.style.setProperty("--day-width", `${calendarDayWidth}px`);
  scroll.style.setProperty("--editor-width", `${width - 2}px`);
  scroll.scrollLeft = weekIndex * stride() * 7;
  updateCalendarWeek();
}
if (window.ResizeObserver)
  new ResizeObserver(resizeEditors).observe($("calendar-scroll"));
window.addEventListener("resize", resizeEditors);
$("calendar-scroll").onscroll = () => {
  if (loadingCalendar || !overviewVisible || !calendarData) return;
  updateCalendarWeek();
  const scroll = $("calendar-scroll"),
    edge = stride() * 3;
  if (scroll.scrollLeft < edge) {
    calendarAnchor = month(calendarAnchor, -1);
    loadCalendar({ preserve: true }).catch(showError);
  } else if (
    scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft <
    edge
  ) {
    calendarAnchor = month(calendarAnchor, 1);
    loadCalendar({ preserve: true }).catch(showError);
  }
};
async function navigateCalendarWeek(offset) {
  const target = shiftDay(calendarWeek || monday(state.today), offset * 7);
  const index = calendarData?.days.findIndex((d) => d.date === target) ?? -1;
  if (index >= 0 && index <= calendarData.days.length - 7) {
    $("calendar-scroll").scrollLeft = index * stride();
    updateCalendarWeek();
  } else {
    calendarAnchor = month(target);
    await loadCalendar({ target });
  }
}
$("month-prev").onclick = () => navigateCalendarWeek(-1).catch(showError);
$("month-next").onclick = () => navigateCalendarWeek(1).catch(showError);
$("calendar-today").onclick = () => {
  calendarAnchor = month(state.today);
  loadCalendar({ target: state.today }).catch(showError);
};
$("task-form").onsubmit = async (e) => {
  e.preventDefault();
  if (await mutate("tasks/", { title: $("task-title").value }))
    $("task-title").value = "";
};
function openSettings() {
  $("tab-title-mode").value = titleMode();
  for (const [key, value] of Object.entries(state.preferences))
    if ($(key)) $(key).value = value;
  updateNotifications();
  setRoute("/settings");
  openDialog($("settings-dialog"));
}
$("settings-open").onclick = openSettings;
$("settings-form").onsubmit = (e) => {
  e.preventDefault();
  const data = {};
  for (const field of ["timezone", "day_start", "day_end", "day_rollover"])
    data[field] = $(field).value;
  for (const field of [
    "focus_minutes",
    "short_break",
    "long_break",
    "long_every",
  ])
    data[field] = Number($(field).value);
  mutate("settings/", data, $("settings-dialog"));
};
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => b.closest("dialog").close();
$("recurrences-dialog").addEventListener("close", () => {
  $("recurrence-form").hidden = true;
});
let routeTransition = false;
function setRoute(path) {
  if (!routeTransition && location.pathname !== path)
    history.pushState({}, "", path);
}
function closeRouteDialogs() {
  routeTransition = true;
  for (const id of ["settings-dialog", "recurrences-dialog"]) {
    if ($(id).open) {
      $(id).dataset.routeClosing = "yes";
      $(id).close();
    }
  }
  routeTransition = false;
}
for (const id of ["settings-dialog"])
  $(id).addEventListener("close", () => {
    if ($(id).dataset.routeClosing) {
      delete $(id).dataset.routeClosing;
      return;
    }
    if (
      !document.querySelector(
        "#settings-dialog[open], #recurrences-dialog[open]",
      ) &&
      location.pathname === "/settings"
    )
      setRoute(recurringVisible ? "/recurring" : overviewVisible ? "/overview" : "/");
  });
async function applyRoute() {
  const path = location.pathname;
  closeRouteDialogs();
  if (path === "/overview") await showView(true, false);
  else if (path === "/settings") openSettings();
  else if (path === "/recurring") await openRecurrences();
  else await showView(false, false);
}
window.addEventListener("popstate", () => applyRoute().catch(showError));
$("tab-title-mode").value = titleMode();
$("tab-title-mode").onchange = () => {
  localStorage.setItem("tab-title-mode", $("tab-title-mode").value);
  tick();
};
let worker;
let deadlineTimeout;
if ("serviceWorker" in navigator)
  worker = navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
function notificationEnabled() {
  return localStorage.getItem("notifications") !== "off";
}
function updateNotifications() {
  const available = "Notification" in window;
  $("notifications-toggle").setAttribute(
    "aria-pressed",
    available && Notification.permission === "granted" && notificationEnabled(),
  );
  $("notifications-status").textContent = !available
    ? "unavailable"
    : Notification.permission === "denied"
      ? "blocked"
      : Notification.permission === "granted" && notificationEnabled()
        ? "on"
        : "off";
}
function askNotificationPermission() {
  if (
    "Notification" in window &&
    Notification.permission === "default" &&
    localStorage.getItem("notification-asked") !== "yes"
  ) {
    localStorage.setItem("notification-asked", "yes");
    Notification.requestPermission()
      .then(updateNotifications)
      .catch(() => {});
  }
}
$("notifications-toggle").onclick = async () => {
  if (!("Notification" in window)) {
    toast("Notifications unavailable in this browser");
    return;
  }
  if (Notification.permission === "default")
    await Notification.requestPermission();
  else if (Notification.permission === "granted")
    localStorage.setItem("notifications", notificationEnabled() ? "off" : "on");
  if (Notification.permission === "denied")
    toast("Enable notifications in your browser's site settings");
  updateNotifications();
};
async function notifyEnd(s) {
  if (
    s.status !== "running" ||
    Date.parse(s.end) > now() ||
    !("Notification" in window) ||
    Notification.permission !== "granted" ||
    !notificationEnabled()
  )
    return;
  const key = `notified:${s.id}:${s.end}`;
  if (notified.has(key) || localStorage.getItem(key)) return;
  notified.add(key);
  localStorage.setItem(key, "yes");
  const title = s.kind === "meeting" ? "Meeting complete" : "Focus complete",
    options = { body: s.title, tag: key, icon: "/static/icon.svg" };
  if (titleMode() === "completion") {
    completionTitle = `${title} · Paradeis`;
    document.title = completionTitle;
  }
  try {
    const registration = worker ? await worker : null;
    if (registration) await registration.showNotification(title, options);
    else {
      const n = new Notification(title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* Browser notification failures must not interrupt the timer. */
  }
}
window.addEventListener("beforeunload", (e) => {
  if (drafts.size || taskDrafts.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function updateWindowFocus() {
  document.documentElement.classList.toggle("window-unfocused",
    document.hidden || !document.hasFocus());
}
window.addEventListener("blur", () => document.documentElement.classList.add("window-unfocused"));
window.addEventListener("focus", updateWindowFocus);
updateWindowFocus();
document.addEventListener("visibilitychange", () => {
  updateWindowFocus();
  if (!document.hidden) refresh().catch(showError);
});
setInterval(tick, 250);
setInterval(() => {
  if (!document.hidden && !busy) refresh().catch(showError);
}, 15000);
updateNotifications();
refresh().then(applyRoute).catch(showError);
