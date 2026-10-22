import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Check, Footprints } from 'lucide-react';
import { celebrate, isGolden } from './wins';

type FocusTask={id:string;title:string;done:boolean;today:boolean;progressAt:number|null};
type FocusBucket={id:string;name:string;color:string;tasks:FocusTask[]};

// One thing: only the next Today task, nothing else on screen. Done brings the next one; Made progress and Not now send it to the back.
export function OneThing({open,onClose,onPick,buckets,busy,mutate,dayStart}:{dayStart:number;open:boolean;onClose:()=>void;onPick:()=>void;buckets:FocusBucket[];busy:boolean;mutate:(p:Record<string,unknown>)=>Promise<unknown>}){
 const [later,setLater]=useState<string[]>([]);
 const today=buckets.flatMap(b=>b.tasks.filter(t=>t.today).map(t=>({...t,bucket:b.name,color:b.color})));
 const waiting=today.filter(t=>!t.done);
 const queue=[...waiting.filter(t=>!later.includes(t.id)),...later.flatMap(id=>waiting.filter(t=>t.id===id))];
 const current=queue[0];
 const close=()=>{setLater([]);onClose();};
 return <Dialog open={open} onOpenChange={next=>{if(!next)close();}}>
  <DialogContent className="focus-dialog">
   <DialogTitle className="sr-only">One thing</DialogTitle>
   <DialogDescription className="sr-only">Your next task for today, on its own.</DialogDescription>
   {today.length>1&&<div className="focus-dots" aria-hidden="true">{today.map(t=><span key={t.id} className={'color-'+t.color+(t.done?' is-done':'')+(t.id===current?.id?' is-current':'')}/>)}</div>}
   {current?<div className="focus-card" key={current.id}>
    <span className={'focus-bucket color-'+current.color}>{current.bucket}</span>
    <p className="focus-title">{current.title}</p>
    <div className="focus-actions">
     <button type="button" className={'focus-done color-'+current.color} autoFocus disabled={busy} onClick={e=>{celebrate(e.currentTarget,isGolden(current.id));void mutate({op:'updateTask',id:current.id,done:true}).catch(()=>{});}}><Check size={20}/> Done</button>
     {current.progressAt!=null&&current.progressAt>=dayStart?<span className="focus-stepped"><Footprints size={16}/> Progress noted for today</span>:<button type="button" className={'focus-step color-'+current.color} disabled={busy} onClick={e=>{celebrate(e.currentTarget,false);const id=current.id;void mutate({op:'logProgress',id}).then(()=>setLater(l=>[...l.filter(x=>x!==id),id])).catch(()=>{});}}><Footprints size={17}/> Made progress</button>}
     {queue.length>1&&<button type="button" className="text-button" disabled={busy} onClick={()=>setLater(l=>[...l.filter(id=>id!==current.id),current.id])}>Not now</button>}
    </div>
   </div>:<div className="focus-card is-rest">
    <p className="focus-title">{today.length?'That’s everything you picked.':'Nothing picked for today yet.'}</p>
    <p className="focus-note">{today.length?'Rest counts too.':'Choose one to three things, then come back here.'}</p>
    <div className="focus-actions">{today.length?<button type="button" className="secondary-button" autoFocus onClick={close}>Back to board</button>:<button type="button" className="secondary-button" autoFocus onClick={()=>{close();onPick();}}>Pick up to three</button>}</div>
   </div>}
  </DialogContent>
 </Dialog>;
}
