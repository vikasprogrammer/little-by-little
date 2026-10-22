import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sun } from 'lucide-react';

type PlanTask={id:string;title:string;done:boolean;today:boolean;todayAt:number|null;expiresAt:number;progress:number};
type PlanBucket={id:string;name:string;color:string;tasks:PlanTask[]};
export type PlanStep='dump'|'pick';

const DUMP_MINUTES=15;const DAY=86400000;const DRAFT_KEY='lbl-brain-dump';
const readDraft=()=>{try{return localStorage.getItem(DRAFT_KEY)??'';}catch{return '';}};
const keepDraft=(value:string)=>{try{if(value)localStorage.setItem(DRAFT_KEY,value);else localStorage.removeItem(DRAFT_KEY);}catch{}};
// One task per line; list markers people paste in ("- ", "1.", "[ ]") are dropped.
export const dumpLines=(text:string)=>text.split('\n').map(line=>line.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]?\])\s*/,'').trim()).filter(Boolean).map(line=>line.slice(0,500)).slice(0,100);

// Empty your head first, then choose up to three things for today. Nothing else on screen.
export function PlanFlow({step,setStep,buckets,clock,dayStart,busy,error,mutate,onPicked}:{step:PlanStep|null;setStep:(s:PlanStep|null)=>void;buckets:PlanBucket[];clock:number;dayStart:number;busy:boolean;error:string;mutate:(p:Record<string,unknown>)=>Promise<{buckets:PlanBucket[]}>;onPicked:()=>void}){
 const [fresh,setFresh]=useState<string[]>([]);
 const close=()=>{if(!busy){setStep(null);setFresh([]);}};
 return <Dialog open={!!step} onOpenChange={open=>{if(!open)close();}}>
  <DialogContent className="board-dialog plan-dialog">
   {step==='dump'&&<Dump busy={busy} onSkip={()=>setStep('pick')} onSave={async titles=>{
    const before=new Set(buckets.flatMap(b=>b.tasks.map(t=>t.id)));
    const data=await mutate({op:'brainDump',titles});
    setFresh(data.buckets.flatMap(b=>b.tasks.filter(t=>!before.has(t.id)).map(t=>t.id)));setStep('pick');
   }}/>}
   {step&&error&&<p className="dialog-error" role="alert">{error}</p>}
   {step==='pick'&&<Pick buckets={buckets} fresh={fresh} clock={clock} dayStart={dayStart} busy={busy} onLater={close} onSave={async ids=>{await mutate({op:'setToday',ids});setStep(null);setFresh([]);onPicked();}}/>}
  </DialogContent>
 </Dialog>;
}

function Dump({busy,onSave,onSkip}:{busy:boolean;onSave:(titles:string[])=>Promise<void>;onSkip:()=>void}){
 const [text,setText]=useState(readDraft);const lines=dumpLines(text);
 const started=useRef(Date.now());const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{const timer=window.setInterval(()=>setElapsed(Date.now()-started.current),5000);return()=>window.clearInterval(timer);},[]);
 const progress=Math.min(1,elapsed/(DUMP_MINUTES*60000));const ring=2*Math.PI*7;
 const save=async()=>{if(!lines.length||busy)return;try{await onSave(lines);keepDraft('');}catch{}};
 return <>
  <div className="plan-head"><DialogTitle>Brain dump</DialogTitle>
   <svg className="dump-ring" viewBox="0 0 18 18" width="18" height="18" role="img" aria-label={DUMP_MINUTES+' minutes is plenty'}><title>{DUMP_MINUTES} minutes is plenty. Stop whenever you feel empty.</title><circle cx="9" cy="9" r="7"/><circle cx="9" cy="9" r="7" className="dump-ring-fill" strokeDasharray={ring} strokeDashoffset={ring*(1-progress)}/></svg>
  </div>
  <DialogDescription>Everything on your mind, one per line. No sorting.</DialogDescription>
  <textarea className="dump-text" aria-label="Brain dump, one thing per line" value={text} autoFocus disabled={busy} onChange={e=>{setText(e.target.value);keepDraft(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();void save();}}}/>
  <div className="plan-foot"><button type="button" className="text-button" disabled={busy} onClick={onSkip}>Just pick for today</button><button type="button" className="primary-button" disabled={busy||!lines.length} onClick={()=>void save()}>{busy?'Saving…':'Next'}</button></div>
 </>;
}

function Pick({buckets,fresh,clock,dayStart,busy,onSave,onLater}:{buckets:PlanBucket[];fresh:string[];clock:number;dayStart:number;busy:boolean;onSave:(ids:string[])=>Promise<void>;onLater:()=>void}){
 // What's worth a look first: today's picks, what you just dumped, yesterday's leftovers, then what is about to expire.
 const candidates=useMemo(()=>{
  const open=buckets.flatMap(b=>b.tasks.filter(t=>!t.done&&t.expiresAt>clock).map(t=>({...t,color:b.color})));
  const rank=(t:PlanTask)=>t.today?0:fresh.includes(t.id)?1:(t.todayAt!=null&&t.todayAt<dayStart)||t.progress>0?2:t.expiresAt-clock<=5*DAY?3:4;
  return open.map((t,i)=>({...t,rank:rank(t),i})).sort((a,b)=>a.rank-b.rank||a.i-b.i);
 },[]);// eslint-disable-line react-hooks/exhaustive-deps -- the list holds still while you choose
 const [chosen,setChosen]=useState(()=>candidates.filter(t=>t.today).map(t=>t.id));
 const [all,setAll]=useState(false);
 const visible=all?candidates:candidates.slice(0,Math.max(7,candidates.filter(t=>t.rank<4).length));
 const tag=(t:PlanTask&{rank:number})=>t.rank===2?(t.todayAt!=null&&t.todayAt<dayStart?'yesterday':'in progress'):t.rank===3?'expires soon':'';
 const toggle=(id:string)=>setChosen(c=>c.includes(id)?c.filter(x=>x!==id):[...c,id]);
 return <>
  <div className="plan-head"><DialogTitle>Pick up to three</DialogTitle><span className={'pick-count'+(chosen.length>3?' is-over':'')} aria-live="polite">{chosen.length>3?'Three is plenty':chosen.length+' of 3'}</span></div>
  <DialogDescription>Just these, for today. Everything else can wait.</DialogDescription>
  {candidates.length?<ul className="pick-list">{visible.map(t=><li key={t.id}><button type="button" className={'pick-item color-'+t.color+(chosen.includes(t.id)?' is-chosen':'')} aria-pressed={chosen.includes(t.id)} disabled={busy} onClick={()=>toggle(t.id)}><Sun size={15} aria-hidden="true"/><span className="pick-title">{t.title}</span>{tag(t)&&<span className="pick-tag">{tag(t)}</span>}</button></li>)}</ul>:<p className="pick-empty">Nothing open right now. A clear board is a good place to be.</p>}
  {!all&&visible.length<candidates.length&&<button type="button" className="text-button pick-more" onClick={()=>setAll(true)}>Show everything ({candidates.length})</button>}
  <div className="plan-foot"><button type="button" className="text-button" disabled={busy} onClick={onLater}>Not now</button><button type="button" className="primary-button" disabled={busy||!candidates.length} onClick={()=>void onSave(chosen).catch(()=>{})}>{busy?'Saving…':'Start'}</button></div>
 </>;
}
