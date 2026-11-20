"use strict";
let overviewExportBlob=null, overviewExportURL=null, overviewExportName='', overviewExportBusy=false;
function exportParagraphs(day,data){
  const rows=[];
  const add=(text,kind='text')=>{if(text)rows.push({text,kind});};
  add(dateLabel(day.date,{weekday:'long',month:'short',day:'numeric',year:'numeric'}),'heading');
  if(day.daily_goal)add(`Goal · ${day.daily_goal}`,'goal');
  const tracked=new Set(day.sessions.map(s=>s.block_id));
  const events=[...day.sessions,...day.blocks.filter(b=>!tracked.has(b.id))].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  for(const event of events){
    add(`${clock(event.start)}–${clock(event.end)} · ${event.kind==='focus'?'Focus':event.kind==='work'?'Work reservation':event.kind==='planning'?'Review & planning':event.kind==='break'?'Break':'Meeting'}`,'time');
    rows[rows.length-1].eventKind=event.kind;
    add(event.title,'event');
    for(const allocation of event.allocations||[])if(event.allocations.length!==1||allocation.label!==event.title)add(`${allocation.label}${allocation.sand ? ` · ${allocation.sand} sand` : ''}`,'task');
    if(event.focus_score!=null||event.effort!=null)rows.push({kind:'metrics',focus:event.focus_score,sand:event.effort});
    add(event.reflection,'note');
  }
  if(!events.length)add('No recorded activity','muted');
  const goals=day.goals||[], completed=day.completed_tasks||[];
  if(goals.length||completed.length){
    add('Tasks','subheading');const seen=new Set();
    for(const task of [...goals,...completed.map(t=>({...t,done:true}))]){
      if(seen.has(task.id))continue;seen.add(task.id);add(`${task.done?'✓':'○'} ${task.title}`,'task');
    }
  }
  const stats=day.summary;add(`${Math.floor(stats.seconds/3600)} h ${Math.floor(stats.seconds%3600/60)} min · ${stats.count} sessions`,'muted');
  add('Notes','subheading');add(data.notes[`day:${day.date}`]||'No notes','note');return rows;
}
function renderOverviewExport(data,first,last){
  const measure=document.createElement('canvas').getContext('2d');
  const ink='#293529', muted='#788272', green='#627b59', paper='#f8f6ef';
  const font=kind=>`${['heading','subheading','event'].includes(kind)?'600 ':kind==='goal'?'italic ':''}${kind==='heading'?16:kind==='time'||kind==='muted'?12:14}px Arial, sans-serif`;
  const wrap=(text,width,kind)=>{
    measure.font=font(kind);const lines=[];
    for(const paragraph of String(text).split('\n')){
      let line='';for(const char of paragraph){
        if(line&&measure.measureText(line+char).width>width){const space=line.lastIndexOf(' ');if(space>line.length/2){lines.push(line.slice(0,space));line=line.slice(space+1);}else{lines.push(line);line='';}}
        line+=char;
      }lines.push(line);
    }return lines;
  };
  const multiWeek=monday(first)!==monday(last);
  const leadingDays=multiWeek?(Date.parse(first)-Date.parse(monday(first)))/86400000:0;
  const slots=[...Array(leadingDays).fill(null),...data.days];
  const width=(multiWeek?7:data.days.length)*312+48, column=296, layouts=[];let y=90;
  const layout=(rows,x,top,w)=>{
    let cursor=top+18;const items=rows.map(row=>{
      if(row.kind==='metrics'){const item={...row,x:x+16,y:cursor};cursor+=30;return item;}
      const lines=wrap(row.text,w-32,row.kind);const item={...row,lines,x:x+16,y:cursor};cursor+=lines.length*20+(['heading','subheading','note'].includes(row.kind)?12:7);return item;
    });return {x,y:top,w,h:cursor-top+8,items};
  };
  for(let offset=0;offset<slots.length;offset+=7){
    const row=slots.slice(offset,offset+7).flatMap((day,index)=>day?[layout(exportParagraphs(day,data),24+index*312,y,column)]:[]);
    const height=Math.max(...row.map(card=>card.h));row.forEach(card=>{card.h=height;layouts.push(card);});y+=height+24;
  }
  const periods=new Set();for(const day of data.days){periods.add(`week:${monday(day.date)}`);periods.add(`month:${month(day.date)}`);periods.add(`quarter:${day.date.slice(0,4)}-${String(Math.floor((Number(day.date.slice(5,7))-1)/3)*3+1).padStart(2,'0')}-01`);}
  for(const key of [...periods].sort((a,b)=>['week','month','quarter'].indexOf(a.split(':')[0])-['week','month','quarter'].indexOf(b.split(':')[0])||a.localeCompare(b))){
    const goal=data.period_goals[key],note=data.notes[key];if(!goal&&!note)continue;
    const [period,date]=key.split(':');const rows=[{kind:'heading',text:periodLabel(period,date)}];
    if(goal)rows.push({kind:'subheading',text:'Goals'},{kind:'goal',text:goal});
    if(note)rows.push({kind:'subheading',text:'Notes'},{kind:'note',text:note});
    const card=layout(rows,24,y,width-48);layouts.push(card);y+=card.h+20;
  }
  const height=Math.ceil(y+24), scale=Math.min(2,Math.floor(Math.min(16000/width,30000/height,Math.sqrt(64000000/(width*height)))*100)/100);
  if(scale<1)throw new Error('This range is too large for a legible single image. Please export a shorter range.');
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image export is unavailable in this browser.');ctx.scale(scale,scale);
  ctx.fillStyle=paper;ctx.fillRect(0,0,width,height);ctx.fillStyle=green;ctx.font='600 24px Arial';ctx.fillText('paradeis · Overview',24,38);
  ctx.font='14px Arial';ctx.fillStyle=muted;ctx.fillText(`${first} — ${last} · ${state.preferences.timezone}`,24,64);
  for(const card of layouts){
    ctx.fillStyle='#fbfaf5';ctx.strokeStyle='#d8dece';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(card.x,card.y,card.w,card.h,12);ctx.fill();ctx.stroke();
    for(let i=0;i<card.items.length;i++){
      const item=card.items[i];if(item.kind!=='time')continue;
      let stop=card.y+card.h-10;
      for(let j=i+1;j<card.items.length;j++)if(['time','subheading','muted'].includes(card.items[j].kind)){stop=card.items[j].y-5;break;}
      ctx.fillStyle=item.eventKind==='meeting'?'#eee8f2':item.eventKind==='break'?'#f2eddf':'#eaf0e3';
      ctx.beginPath();ctx.roundRect(card.x+8,item.y-4,card.w-16,stop-item.y+2,5);ctx.fill();
    }
    for(const item of card.items){
      if(item.kind==='metrics'){
        let x=item.x;
        if(item.focus!=null){for(let i=0;i<item.focus;i++){const r=3+i;ctx.strokeStyle=green;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x+r,item.y+8,r,0,Math.PI*2);ctx.stroke();x+=r*2+6;}if(!item.focus){ctx.fillStyle=muted;ctx.font='11px Arial';ctx.fillText('Focus 0',x,item.y+12);x+=48;}}
        x+=10;ctx.fillStyle='#b49a61';for(let i=0;i<(item.sand||0);i++){const size=6+i*2;ctx.beginPath();ctx.moveTo(x,item.y+16);ctx.lineTo(x+size/2,item.y+16-size);ctx.lineTo(x+size,item.y+16);ctx.fill();x+=size+4;}continue;
      }
      ctx.font=font(item.kind);ctx.fillStyle=['time','muted'].includes(item.kind)?muted:item.kind==='goal'?green:ink;
      item.lines.forEach((line,index)=>ctx.fillText(line,item.x,item.y+15+index*20));
    }
  }
  return canvas;
}
function initializeOverviewExport(){
  const dialog=$('overview-export-dialog'),status=$('overview-export-status');
  $('overview-export-open').onclick=()=>{if(overviewExportBusy)return;reset();$('overview-export-start').value=calendarWeek||monday(state.today);$('overview-export-end').value=shiftDay($('overview-export-start').value,6);openDialog(dialog);};
  const reset=()=>{dialog.querySelector('.dialog-error').hidden=true;overviewExportBlob=null;$('overview-export-result').hidden=true;if(overviewExportURL){URL.revokeObjectURL(overviewExportURL);overviewExportURL=null;}$('overview-export-preview').removeAttribute('src');status.textContent='';};
  for(const id of ['overview-export-start','overview-export-end'])$(id).oninput=reset;
  $('overview-export-form').onsubmit=async event=>{
    event.preventDefault();if(overviewExportBusy)return;reset();
    const first=$('overview-export-start').value,last=$('overview-export-end').value;
    const count=(Date.parse(last)-Date.parse(first))/86400000+1;
    if(!Number.isFinite(count)||count<1||count>112){showError(new Error('Choose between 1 and 112 days, including both dates.'),dialog);return;}
    overviewExportBusy=true;for(const id of ['overview-export-start','overview-export-end','overview-export-generate'])$(id).disabled=true;status.textContent='Preparing image…';
    try{
      for(const key of [...drafts.keys()])if(!await flushNote(key))throw new Error('Some notes could not be saved. Retry saving them before exporting.');
      const data=await api(`history/?start=${first}&end=${last}`);
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      const canvas=renderOverviewExport(data,first,last);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('The browser could not create this image. Try a shorter range.');
      overviewExportBlob=blob;overviewExportName=`paradeis-${first}-${last}.png`;overviewExportURL=URL.createObjectURL(blob);
      $('overview-export-preview').src=overviewExportURL;$('overview-export-download').href=overviewExportURL;$('overview-export-download').download=overviewExportName;
      $('overview-export-result').hidden=false;$('overview-export-copy').disabled=!navigator.clipboard?.write||!window.ClipboardItem;
      status.textContent=`${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} pixels · PNG${$('overview-export-copy').disabled?' · Copy is unavailable here; download the PNG instead.':''}`;
    }catch(error){status.textContent='';showError(error,dialog);}finally{overviewExportBusy=false;for(const id of ['overview-export-start','overview-export-end','overview-export-generate'])$(id).disabled=false;}
  };
  $('overview-export-copy').onclick=async()=>{
    if(!overviewExportBlob)return;
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':overviewExportBlob})]);status.textContent='Image copied. Ready to paste.';}
    catch(error){status.textContent='Could not copy the image. Download the PNG instead.';}
  };
}
initializeOverviewExport();
