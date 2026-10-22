import { useRef } from 'react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel } from '@/components/ui/dropdown-menu';

export type Win={id:string;title:string;color:string;doneAt:number;step?:boolean};

// About one completion in five earns a golden pebble. Derived from the task id so it stays the same across reloads.
export const isGolden=(id:string)=>{let h=0;for(const c of id)h=(h*31+c.charCodeAt(0))|0;return Math.abs(h)%5===0;};
export const startOfDay=(stamp:number)=>{const d=new Date(stamp);d.setHours(0,0,0,0);return d.getTime();};
const reducedMotion=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A short burst from the checkbox. Lives in a fixed overlay because the row moves to Done right after.
export function celebrate(from:HTMLElement,golden:boolean){
 if(reducedMotion())return;
 const rect=from.getBoundingClientRect();const color=getComputedStyle(from).getPropertyValue('--bucket-color').trim()||'#2458d3';
 const burst=document.createElement('div');burst.className='win-burst'+(golden?' is-golden':'');burst.setAttribute('aria-hidden','true');
 burst.style.left=rect.left+rect.width/2+'px';burst.style.top=rect.top+rect.height/2+'px';
 const count=golden?14:8;
 for(let i=0;i<count;i++){
  const angle=(i/count)*Math.PI*2+Math.random()*.4;const distance=(golden?30:20)+Math.random()*(golden?22:12);
  const dot=document.createElement('span');dot.style.setProperty('--dx',Math.cos(angle)*distance+'px');dot.style.setProperty('--dy',Math.sin(angle)*distance+'px');
  dot.style.background=golden?(i%2?'#f5b81c':'#ffd862'):color;burst.appendChild(dot);
 }
 document.body.appendChild(burst);window.setTimeout(()=>burst.remove(),900);
}

const slots=[[10,33],[16,33.5],[22,33],[13,27.6],[19,27.8],[9.5,22.4],[16,22.2],[22.5,22.4],[12.5,17],[19.5,17.2],[10,11.8],[22,11.8]];

// Today's wins: one pebble per finished task, in its bucket's color. Empties at local midnight; no history, no streaks.
export function WinsJar({wins,ready}:{wins:Win[];ready:boolean}){
 // Pebbles already in the jar when the board first loads sit still; only ones added afterwards drop in.
 const born=useRef(new Map<string,number>());const primed=useRef(false);
 if(ready){const ids=new Set(wins.map(w=>w.id));for(const id of born.current.keys())if(!ids.has(id))born.current.delete(id);for(const w of wins)if(!born.current.has(w.id))born.current.set(w.id,primed.current?Date.now():0);primed.current=true;}
 const isNew=(id:string)=>Date.now()-(born.current.get(id)??0)<1000;
 const shown=wins.slice(0,slots.length);const steps=wins.filter(w=>w.step).length;const done=wins.length-steps;
 const label=!steps?(done===1?'1 thing done today':done+' things done today'):[done&&(done===1?'1 thing done':done+' things done'),steps===1?'1 step forward':steps+' steps forward'].filter(Boolean).join(', ')+' today';
 return <DropdownMenu><DropdownMenuTrigger asChild><button className={'wins-jar'+(wins.length?' has-wins':'')} aria-label={label} title={label}>
  <svg viewBox="0 0 32 40" width="30" height="37" aria-hidden="true">
   <rect x="9" y="1.5" width="14" height="4" rx="1.6" className="jar-lid"/>
   <path d="M10 5.5v2.2C6.2 9 4 11.6 4 15.2V33a5 5 0 0 0 5 5h14a5 5 0 0 0 5-5V15.2c0-3.6-2.2-6.2-6-7.5V5.5" className="jar-glass"/>
   {shown.map((w,i)=><circle key={w.id} cx={slots[i][0]} cy={slots[i][1]} r="3.1" className={'pebble color-'+w.color+(w.step?' is-step':isGolden(w.id)?' is-golden':'')+(isNew(w.id)?' is-new':'')}/>)}
  </svg>
  {wins.length>0&&<span className="wins-count">{wins.length}</span>}
 </button></DropdownMenuTrigger>
 <DropdownMenuContent align="end" className="wins-menu"><DropdownMenuLabel>Today’s wins</DropdownMenuLabel>
  {wins.length?<ul>{wins.map(w=><li key={w.id}><span className={'wins-dot color-'+w.color+(w.step?' is-step':isGolden(w.id)?' is-golden':'')}/><span>{w.title}{w.step&&<span className="wins-step"> · a step</span>}</span></li>)}</ul>:<p>Your jar fills as you finish things today.</p>}
 </DropdownMenuContent></DropdownMenu>;
}
