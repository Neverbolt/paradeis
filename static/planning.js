"use strict";
const goalDrafts = new Map(), promptedGoals = new Set();
let periodEditing = null, periodRead = 0, periodSaving = false, periodLoading = false, planningRouteDeferred = false;
const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function quarter(day) {return `${day.slice(0,4)}-${String(Math.floor((Number(day.slice(5,7))-1)/3)*3+1).padStart(2,"0")}-01`;}
function periodLabel(period, day) {
  if (period === "day") return dateLabel(day,{weekday:"long",month:"short",day:"numeric",year:"numeric"});
  if (period === "week") return `Week of ${dateLabel(day, {month:"short", day:"numeric", year:"numeric"})}`;
  if (period === "quarter") return `Q${Math.floor((Number(day.slice(5,7))-1)/3)+1} ${day.slice(0,4)}`;
  return dateLabel(day, {month:"long", year:"numeric"});
}
function sourceMarkdown(target, source) {
  target.replaceChildren();
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  source.split("\n").forEach((line, index) => {
    if (index) target.append(document.createTextNode("\n"));
    const body = /^#{1,3} /.test(line) ? el("span", "md-heading") : document.createDocumentFragment();
    let cursor = 0;
    for (const match of line.matchAll(pattern)) {
      body.append(document.createTextNode(line.slice(cursor, match.index)));
      const tag = match[0].startsWith("**") || match[0].startsWith("__") ? "strong" : match[0][0] === "`" ? "code" : "em";
      body.append(el(tag, "", match[0]));
      cursor = match.index + match[0].length;
    }
    body.append(document.createTextNode(line.slice(cursor)));
    target.append(body);
  });
}
function paintMarkdown(textarea) {
  const mirror = textarea.parentElement?.querySelector(".markdown-mirror");
  if (!mirror) return;
  sourceMarkdown(mirror, textarea.value + "\n");
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
  const style = getComputedStyle(textarea);
  for (const property of ["font", "padding", "letterSpacing", "lineHeight", "tabSize"]) mirror.style[property] = style[property];
  mirror.style.width = `${textarea.clientWidth + 2}px`;
}
function enhanceMarkdown(textarea) {
  if (textarea.parentElement?.classList.contains("markdown-input")) return;
  const wrapper = el("div", "markdown-input"), mirror = el("pre", "markdown-mirror");
  mirror.setAttribute("aria-hidden", "true");
  textarea.before(wrapper);
  wrapper.append(mirror, textarea);
  textarea.classList.add("markdown-source");
  textarea.addEventListener("input", () => paintMarkdown(textarea));
  textarea.addEventListener("scroll", () => {mirror.scrollTop = textarea.scrollTop; mirror.scrollLeft = textarea.scrollLeft;});
  if (window.ResizeObserver) new ResizeObserver(() => paintMarkdown(textarea)).observe(textarea);
  paintMarkdown(textarea);
}
function goalReference(goal, label) {
  const card = el("section", "goal-reference");
  card.append(el("h3", "small muted", label || periodLabel(goal.period, goal.date)));
  const body = el("div", "goal-text markdown-readonly");
  sourceMarkdown(body, goal.text || "No goals set for this period.");
  if (!goal.text) body.classList.add("muted");
  card.append(body);
  return card;
}
function renderDailyGoalContext() {
  const goal = state?.planning?.weekly, target = $("day-plan-weekly-context");
  if (!goal || !target) return;
  const signature = JSON.stringify(goal);
  if (target.dataset.value !== signature) {
    target.dataset.value = signature;
    target.replaceChildren(goalReference(goal, `Weekly goals · ${periodLabel("week", goal.date)}`));
  }
}
function renderPeriodPlanning() {
  if (!state?.planning) return false;
  renderDailyGoalContext();
  if ($("period-goal-dialog").open || periodLoading) return true;
  if (renderReviewPrompts()) return true;
  if (document.querySelector("dialog[open]")) return false;
  const next = state.planning.pending.find(goal => !promptedGoals.has(`${goal.period}:${goal.date}`));
  if (!next) return false;
  openPeriodGoals(next.period, next.date).catch(showError);
  return true;
}
async function openPeriodGoals(period, day, afterReview=false) {
  if(period==='day')return openPeriodReview(period,day);
  const previous=previousReviewDate(period,day), reviewKey=`${period}:${previous}`;
  if(periodLoading)return;
  if(!afterReview&&!promptedReviews.has(reviewKey)){
    periodLoading=true;
    try {
      const prior=await api(`reviews/?period=${period}&date=${previous}`);
      if(prior.has_activity||prior.text.trim()){periodLoading=false;return openPeriodReview(period,previous,()=>openPeriodGoals(period,day,true).catch(showError));}
    } finally {periodLoading=false;}
  }
  const key = `${period}:${day}`, version = ++periodRead;
  promptedGoals.add(key);
  periodLoading = true;
  periodEditing = {period, date:day};
  $("period-goal-title").textContent = `${{week:"Weekly",month:"Monthly",quarter:"Quarterly"}[period]} goals`;
  $("period-goal-date").textContent = periodLabel(period, day);
  $("period-goal-text").value = goalDrafts.get(key) || "";
  $("period-goal-text").disabled = true;
  $("period-goal-context").replaceChildren();
  $("period-goal-previous").replaceChildren();
  openDialog($("period-goal-dialog"));
  try {
    const data = await api(`goals/?period=${period}&date=${day}`);
    if (version !== periodRead || !$("period-goal-dialog").open) return;
    periodEditing = data;
    $("period-goal-context").replaceChildren(...data.context.map(goal => goalReference(goal)));
    $("period-goal-previous").replaceChildren(goalReference(data.previous, `Previous ${period} · ${periodLabel(period, data.previous.date)}`));
    $("period-goal-text").value = goalDrafts.get(key) ?? data.text;
    $("period-goal-text").disabled = false;
    $("period-goal-later").textContent = data.text ? "Close" : "Later";
    $("period-goal-status").textContent = goalDrafts.has(key) ? "Unsaved" : "";
    paintMarkdown($("period-goal-text"));
    fillPlanningReservation(data);
    $("period-goal-text").focus();
  } catch (error) {showError(error, $("period-goal-dialog"));}
  finally {if (version === periodRead) periodLoading = false;}
}
function fillPlanningReservation(data) {
  const block = data.reservation, missed = block && !block.tracked && Date.parse(block.end) <= now();
  $("planning-reservation-status").textContent = block
    ? `${missed ? "Planning time has passed · " : block.tracked ? "Tracked planning pomo · " : ""}${dateLabel(block.date,{month:"short",day:"numeric"})} · ${block.start_time}–${block.end_time}`
    : data.reservation_conflict || "No planning pomo reserved.";
  const rounded = Math.ceil((now()+1)/300000)*300000;
  const suggestedFuture = data.suggested_date > localDate(now()) || (data.suggested_date === localDate(now()) && data.suggested_start > clock(now()));
  $("planning-reservation-date").value = (!missed && block?.date) || (suggestedFuture ? data.suggested_date : localDate(rounded));
  $("planning-reservation-start").value = (!missed && block?.start_time) || (suggestedFuture ? data.suggested_start : clock(rounded));
  $("planning-reservation-minutes").value = block ? Math.round((Date.parse(block.end)-Date.parse(block.start))/60000) : data.minutes;
  $("planning-reservation-fields").hidden = block?.tracked || (!data.reservation_conflict && !missed);
  $("planning-reservation-toggle").hidden = !!block?.tracked;
  $("planning-reservation-remove").hidden = !block || block.tracked;
  $("planning-reservation-start-timer").hidden = !block || block.tracked || !!state.active || Date.parse(block.start)>now() || Date.parse(block.end)<=now();
}
async function reservePlanning(remove=false) {
  if (!periodEditing || periodSaving) return;
  const payload = {period:periodEditing.period,date:periodEditing.date,action:remove?"remove_reservation":"reserve"};
  if (!remove) Object.assign(payload, {reservation_date:$("planning-reservation-date").value,
    start:$("planning-reservation-start").value,minutes:Number($("planning-reservation-minutes").value)});
  periodSaving = true;
  $("period-goal-dialog").querySelector(".dialog-error").hidden=true;
  try {
    const data = await api("goals/", payload);
    periodEditing = data;
    fillPlanningReservation(data);
    await refresh();
    if (overviewVisible) await loadCalendar({preserve:true});
  } catch (error) {showError(error, $("period-goal-dialog"));}
  finally {periodSaving = false;}
}
function goalCard(period, day) {
  const group = el("section", "period-goals");
  const heading = el("div", "section-heading");
  const text = calendarData.period_goals?.[`${period}:${day}`] || "";
  heading.append(el("h3", "", "Goals"), button(text?"Edit":"Set goals", "text-button small", () => openPeriodGoals(period,day), `Edit ${period} goals for ${day}`));
  const body = el("div", "goal-text markdown-readonly");
  sourceMarkdown(body, text || "No goals set.");
  if (!text) body.classList.add("muted");
  group.append(heading,body);
  return group;
}
function renderVisiblePeriods(force=false) {
  if (!calendarData || !calendarWeek) return;
  const shelf = $("calendar-periods");
  if (!force && shelf.dataset.week === calendarWeek) return;
  shelf.dataset.week = calendarWeek;
  shelf.replaceChildren();
  const append = (period, days) => {
    const row = el("div", `period-row ${period}-row`);
    for (const day of days) {
      const panel = el("section", `period-group ${period}`);
      panel.dataset.period = `${period}:${day}`;
      panel.append(noteEditor(period, day, calendarData.period_summaries[`${period}:${day}`], periodLabel(period, day)));
      row.append(panel);
    }
    shelf.append(row);
  };
  const end = shiftDay(calendarWeek,6);
  append("week", [calendarWeek]);
  append("month", [...new Set([month(calendarWeek),month(end)])]);
  append("quarter", [...new Set([quarter(calendarWeek),quarter(end)])]);
}
function makeWeekdays(container, selected=Array.from({length:7},(_,i)=>i)) {
  const legend = container.querySelector("legend");
  container.replaceChildren();
  if (legend) container.append(legend);
  weekdayNames.forEach((name,day) => {
    const label = el("label", "weekday-choice"), input = el("input");
    input.type="checkbox"; input.value=day; input.checked=selected.includes(day); input.setAttribute("aria-label",name);
    label.append(input, document.createTextNode(name.slice(0,3)));
    container.append(label);
  });
}
function chosenWeekdays(container) {return [...container.querySelectorAll("input:checked")].map(input=>Number(input.value));}
function updateBlockWeekdays() {$("block-weekdays").hidden = !$("block-repeat").checked || $("block-interval").value !== "daily";}
async function openPlanningSettings() {
  const dialog = $("planning-settings-dialog");
  openDialog(dialog);
  try {
    const settings = await api("planning-settings/");
    makeWeekdays($("planning-workdays"),settings.workdays);
    $("daily-review-enabled").checked=settings.daily_review_enabled;
    $("daily-review-minutes").value=settings.daily_review_minutes;
    const fields = $("planning-rule-fields"); fields.replaceChildren();
    for (const rule of settings.rules) {
      const group = el("fieldset", "planning-rule"); group.dataset.period=rule.period;
      group.append(el("legend","",`${{week:"Weekly",month:"Monthly",quarter:"Quarterly"}[rule.period]} planning`));
      const enabled=el("input"); enabled.type="checkbox"; enabled.checked=rule.enabled; enabled.dataset.field="enabled";
      const enableLabel=el("label","inline-label"); enableLabel.append(enabled,document.createTextNode("Plan the next period in advance")); group.append(enableLabel);
      const add=(name,label,node) => {node.dataset.field=name;node.setAttribute("aria-label",`${rule.period} ${label}`);const wrap=el("label","",label);wrap.append(node);group.append(wrap);return node;};
      if (rule.period==="week") {
        const select=el("select"); weekdayNames.forEach((name,i)=>{const opt=el("option","",name);opt.value=i;select.append(opt);}); select.value=rule.weekday;add("weekday","Day in previous week",select);
      } else {
        const select=el("select"); for(const [value,label] of [["last_workday","Last working day"],["day","Day of month"]]){const opt=el("option","",label);opt.value=value;select.append(opt);} select.value=rule.trigger_mode;
        add("trigger_mode",rule.period==="quarter"?"In the previous quarter’s final month":"In the previous month",select);
        const number=el("input");number.type="number";number.min=1;number.max=31;number.value=rule.day_of_month;add("day_of_month","Day (short months use their last day)",number);
        select.onchange=()=>number.parentElement.hidden=select.value!=="day";select.onchange();
      }
      const trigger=el("input");trigger.type="time";trigger.value=rule.time;trigger.required=true;add("time","Trigger time",trigger);
      const duration=el("input");duration.type="number";duration.min=1;duration.max=180;duration.value=rule.minutes;duration.required=true;add("minutes","Planning pomo (minutes)",duration);
      enabled.onchange=()=>{
        for (const control of group.querySelectorAll("[data-field]"))
          if (!["enabled","minutes"].includes(control.dataset.field)) control.disabled=!enabled.checked;
      };
      enabled.onchange();
      fields.append(group);
    }
  } catch(error){showError(error,dialog);}
}
function initializePlanning() {
  enhanceMarkdown($("day-note")); enhanceMarkdown($("period-goal-text"));
  makeWeekdays($("block-weekdays")); makeWeekdays($("repeat-weekdays"));
  $("block-repeat").addEventListener("change",updateBlockWeekdays);
  $("block-interval").addEventListener("change",updateBlockWeekdays);
  $("period-goal-text").addEventListener("input",()=>{
    if (!periodEditing) return;
    goalDrafts.set(`${periodEditing.period}:${periodEditing.date}`,$("period-goal-text").value);
    $("period-goal-status").textContent="Unsaved";
  });
  const close=()=>{if(periodSaving)return;periodRead++;periodLoading=false;periodEditing=null;$("period-goal-dialog").close();queueMicrotask(()=>{renderDayPlan();if(planningRouteDeferred&&!$("period-goal-dialog").open)applyRoute().catch(showError);});};
  $("period-goal-close").onclick=$("period-goal-later").onclick=close;
  $("period-goal-dialog").addEventListener("cancel",e=>{e.preventDefault();close();});
  $("period-goal-form").onsubmit=async e=>{
    e.preventDefault(); if(!periodEditing||periodSaving||periodLoading)return;
    const key=`${periodEditing.period}:${periodEditing.date}`, text=$("period-goal-text").value;
    periodSaving=true;
    if(await mutate("goals/",{period:periodEditing.period,date:periodEditing.date,text},$("period-goal-dialog"),false)) {
      if(goalDrafts.get(key)===text)goalDrafts.delete(key);
      periodSaving=false;close();
    }
    periodSaving=false;
  };
  $("planning-reservation-toggle").onclick=()=>$("planning-reservation-fields").hidden=!$("planning-reservation-fields").hidden;
  $("planning-reservation-save").onclick=()=>reservePlanning();
  $("planning-reservation-remove").onclick=()=>reservePlanning(true);
  $("planning-reservation-start-timer").onclick=async()=>{
    const block=periodEditing?.reservation;
    if(!block||periodSaving)return;
    periodSaving=true;
    try {
      if(await mutate("timer/",{action:"start",block_id:block.id},$("period-goal-dialog"),false)) {
        periodEditing=await api(`goals/?period=${periodEditing.period}&date=${periodEditing.date}`);
        fillPlanningReservation(periodEditing);
      }
    } catch(error){showError(error,$("period-goal-dialog"));}
    finally{periodSaving=false;}
  };
  $("planning-settings-open").onclick=()=>{$("settings-dialog").close();openPlanningSettings();};
  $("planning-settings-form").onsubmit=async e=>{
    e.preventDefault(); const rules=[...$("planning-rule-fields").children].map(group=>{
      const read=field=>group.querySelector(`[data-field="${field}"]`);
      return {period:group.dataset.period,enabled:read("enabled").checked,weekday:Number(read("weekday")?.value??4),
        trigger_mode:read("trigger_mode")?.value||"last_workday",day_of_month:Number(read("day_of_month")?.value??31),
        time:read("time").value,minutes:Number(read("minutes").value)};
    });
    await mutate("planning-settings/",{daily_review_enabled:$("daily-review-enabled").checked,daily_review_minutes:Number($("daily-review-minutes").value),workdays:chosenWeekdays($("planning-workdays")),rules},$("planning-settings-dialog"));
  };
}
