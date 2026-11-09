"use strict";
const promptedReviews = new Set();
let reviewVisitDay = null, reviewVisitCandidates = [];
let reviewPeriod = null, reviewRead = 0, reviewSaving = false, reviewContinuation = null;
function previousReviewDate(period, day) {
  if(period==='day')return shiftDay(day,-1);
  if(period==='week')return shiftDay(day,-7);
  return month(day,period==='quarter'?-3:-1);
}
function renderReviewPrompts() {
  if($("period-review-dialog").open)return true;
  if(document.querySelector('dialog[open]'))return false;
  if(reviewVisitDay!==state?.today){reviewVisitDay=state?.today;reviewVisitCandidates=[...(state?.planning?.reviews||[])];}
  const next=reviewVisitCandidates.find(item=>!promptedReviews.has(`${item.period}:${item.date}`));
  if(!next)return false;
  openPeriodReview(next.period,next.date).catch(showError);
  return true;
}
async function openPeriodReview(period, date, continuation=null) {
  if(reviewSaving)return;
  const version=++reviewRead, key=`${period}:${date}`, dialog=$("period-review-dialog");
  promptedReviews.add(key);reviewPeriod={period,date};reviewContinuation=continuation;
  $("period-review-title").textContent=`${{day:'Daily',week:'Weekly',month:'Monthly',quarter:'Quarterly'}[period]} review`;
  $("period-review-date").textContent=periodLabel(period,date);
  $("period-review-text").value=drafts.get(key)||'';$("period-review-text").disabled=true;
  $("period-review-context").replaceChildren(el('p','muted','Loading…'));
  $("review-reservation").hidden=true;
  $("period-review-save").textContent=continuation?'Save & continue':'Save review';
  $("period-review-status").textContent='';openDialog(dialog);
  try {
    const data=await api(`reviews/?period=${period}&date=${date}`);
    if(version!==reviewRead||!dialog.open)return;
    reviewPeriod=data;
    $("period-review-text").value=drafts.get(key)??data.text;
    $("period-review-text").disabled=false;paintMarkdown($("period-review-text"));
    const context=$("period-review-context");context.replaceChildren();
    if(period==='day') {
      const timeline=el('div','timeline review-day-timeline');
      renderTimeline(timeline,data.timeline);
      for(const button of timeline.querySelectorAll('button')) {
        const readonly=el('div',button.className);readonly.append(...button.childNodes);button.replaceWith(readonly);
      }
      context.append(timeline);
      $("review-reservation").hidden=false;fillReviewReservation(data.reservation);
    } else for(const note of data.context) {
      const card=el('section','review-note-reference');card.append(el('h3','small',periodLabel(note.period,note.date)));
      const body=el('div','markdown-readonly');sourceMarkdown(body,note.text||'No notes for this period.');
      if(!note.text)body.classList.add('muted');card.append(body);context.append(card);
    }
    $("period-review-text").focus();
  } catch(error){showError(error,dialog);}
}
function fillReviewReservation(data) {
  const block=data?.reservation;
  $("review-reservation-status").textContent=block?`${block.date} · ${block.start_time}–${block.end_time}${block.tracked?' · Tracked':''}`:data?.reservation_conflict||'No review pomo reserved.';
  const future=Math.ceil((now()+60000)/300000)*300000;
  $("review-slot-date").value=block?.date||localDate(future);
  $("review-slot-start").value=block?.start_time||clock(future);
  $("review-slot-minutes").value=block?Math.round((Date.parse(block.end)-Date.parse(block.start))/60000):data?.minutes||15;
  $("review-slot-fields").hidden=!!block?.tracked;
  $("review-slot-remove").hidden=!block||block.tracked;
  $("review-slot-start-timer").hidden=!block||block.tracked||!!state.active||Date.parse(block.start)>now()||Date.parse(block.end)<=now();
}
async function changeReviewReservation(remove=false) {
  if(!reviewPeriod||reviewSaving)return;
  reviewSaving=true;
  try {
    const data=await api('goals/',{period:'day',date:reviewPeriod.date,action:remove?'remove_reservation':'reserve',
      reservation_date:$("review-slot-date").value,start:$("review-slot-start").value,minutes:Number($("review-slot-minutes").value)});
    reviewPeriod.reservation=data;fillReviewReservation(data);await refresh();
    if(overviewVisible)await loadCalendar({preserve:true});
  } catch(error){showError(error,$("period-review-dialog"));}
  finally{reviewSaving=false;}
}
function closePeriodReview() {
  if(reviewSaving)return;
  ++reviewRead;const next=reviewContinuation;reviewContinuation=null;reviewPeriod=null;
  $("period-review-dialog").close();
  if(next)next();else queueMicrotask(()=>{renderDayPlan();if(planningRouteDeferred&&!document.querySelector('dialog[open]'))applyRoute().catch(showError);});
}
function initializeReviews() {
  enhanceMarkdown($("period-review-text"));
  $("period-review-text").addEventListener('input',()=>{
    if(reviewPeriod)drafts.set(`${reviewPeriod.period}:${reviewPeriod.date}`,$("period-review-text").value);
    $("period-review-status").textContent='Unsaved';
  });
  $("period-review-close").onclick=$("period-review-skip").onclick=closePeriodReview;
  $("period-review-dialog").addEventListener('cancel',event=>{event.preventDefault();closePeriodReview();});
  $("period-review-form").onsubmit=async event=>{
    event.preventDefault();if(!reviewPeriod||reviewSaving||$("period-review-text").disabled)return;
    const {period,date}=reviewPeriod,key=`${period}:${date}`,text=$("period-review-text").value;
    if(!text.trim()){showError(new Error('Write your review, or choose Skip review.'),$("period-review-dialog"));return;}
    reviewSaving=true;$("period-review-text").disabled=true;$("period-review-save").disabled=true;
    try {
      await api('notes/',{period,date,text});savedNotes.set(key,text);drafts.delete(key);
      noteReads.set(key,(noteReads.get(key)||0)+1);
      if(calendarData)calendarData.notes[key]=text;
      for(const input of document.querySelectorAll('textarea[data-note]'))if(input.dataset.note===key){input.value=text;paintMarkdown(input);}
      if(period==='day'&&selectedDay===date){$("day-note").value=text;paintMarkdown($("day-note"));$("day-note-status").textContent="Saved";}
      await refresh();if(overviewVisible)await loadCalendar({preserve:true});
      reviewSaving=false;closePeriodReview();
    } catch(error){showError(error,$("period-review-dialog"));}
    finally{reviewSaving=false;$("period-review-text").disabled=false;$("period-review-save").disabled=false;}
  };
  $("review-slot-save").onclick=()=>changeReviewReservation();
  $("review-slot-remove").onclick=()=>changeReviewReservation(true);
  $("review-slot-start-timer").onclick=async()=>{
    const block=reviewPeriod?.reservation?.reservation;if(!block||reviewSaving)return;
    reviewSaving=true;try{await api('timer/',{action:'start',block_id:block.id});await refresh();$("review-slot-start-timer").hidden=true;}
    catch(error){showError(error,$("period-review-dialog"));}finally{reviewSaving=false;}
  };
  $("day-review-open").onclick=()=>openPeriodReview('day',state.day.date);
}
