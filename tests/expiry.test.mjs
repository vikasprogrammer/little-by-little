import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBoardStore,DAY,InputError,startOfDayIn} from '../board-store.mjs';
import {isExpired,canBump,matchesView} from '../src/expiry.js';

function fixture(){
 let clock=Date.UTC(2026,9,5);const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const store=createBoardStore(db,{now:()=>clock});
 const act=p=>{db.exec('BEGIN IMMEDIATE');try{const value=store.mutate(p);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const bucket=act({op:'createBucket',name:'Project',color:'green'}).buckets[0];
 const task=act({op:'createTask',id:bucket.id,title:'Small step'}).buckets[0].tasks[0];
 return {db,store,act,bucket,task,setClock:value=>clock=value,now:()=>clock};
}

test('default lifetime and settings apply only to new items; edits preserve expiry',()=>{
 const f=fixture();try{
  assert.equal(f.task.expiresAt-f.task.createdAt,15*DAY);
  f.act({op:'updateSettings',expiryDays:30});
  const data=f.act({op:'createTask',id:f.bucket.id,title:'Next step'});
  assert.equal(data.settings.expiryDays,30);
  assert.equal(data.buckets[0].tasks.find(t=>t.id===f.task.id).expiresAt,f.task.expiresAt);
  assert.equal(data.buckets[0].tasks.find(t=>t.title==='Next step').expiresAt-f.now(),30*DAY);
  const edited=f.act({op:'updateTask',id:f.task.id,title:'Renamed',done:true,today:true,important:true}).buckets[0].tasks.find(t=>t.id===f.task.id);
  assert.equal(edited.expiresAt,f.task.expiresAt);
  assert.equal(edited.done,true);assert.equal(edited.today,true);assert.equal(edited.important,true);
  for(const expiryDays of [0,-1,366,1.5,'15',null])assert.throws(()=>f.act({op:'updateSettings',expiryDays}),InputError);
  assert.equal(f.store.board().settings.expiryDays,30);
 }finally{f.db.close();}
});

test('bump is permitted only within five days, adds to original expiry, and cannot be repeated immediately',()=>{
 const f=fixture();try{
  f.setClock(f.task.expiresAt-5*DAY-1);
  assert.throws(()=>f.act({op:'bumpTask',id:f.task.id}),/last five days/);
  f.setClock(f.task.expiresAt-5*DAY);
  const bumped=f.act({op:'bumpTask',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(bumped.expiresAt,f.task.expiresAt+7*DAY);
  assert.throws(()=>f.act({op:'bumpTask',id:f.task.id}),/last five days/);
  f.setClock(bumped.expiresAt-1);
  const again=f.act({op:'bumpTask',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(again.expiresAt,bumped.expiresAt+7*DAY);
  f.setClock(again.expiresAt);
  assert.throws(()=>f.act({op:'bumpTask',id:f.task.id}),/has expired/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1);
 }finally{f.db.close();}
});

test('expired items restore using current settings and preserve their content and flags',()=>{
 const f=fixture();try{
  assert.throws(()=>f.act({op:'restoreTask',id:f.task.id}),/not expired/);
  f.act({op:'updateTask',id:f.task.id,done:true,today:true,important:true});
  f.setClock(f.task.expiresAt);f.act({op:'updateSettings',expiryDays:10});
  const restored=f.act({op:'restoreTask',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(restored.expiresAt,f.now()+10*DAY);
  assert.equal(restored.createdAt,f.task.createdAt);
  assert.equal(restored.title,f.task.title);assert.equal(restored.done,true);assert.equal(restored.important,true);
  // Today lapses at midnight, so fifteen days later it is no longer set.
  assert.equal(restored.today,false);assert.equal(restored.todayAt,f.task.createdAt);
 }finally{f.db.close();}
});

test('UI expiry boundaries hide items from every active view, including completed flagged items',()=>{
 const now=123456789;
 for(const done of [false,true]){
  const task={done,today:true,important:true,expiresAt:now+5*DAY+1};
  assert.equal(canBump(task,now),false);
  task.expiresAt=now+5*DAY;assert.equal(canBump(task,now),true);
  task.expiresAt=now+1;assert.equal(canBump(task,now),true);
  task.expiresAt=now;assert.equal(canBump(task,now),false);assert.equal(isExpired(task,now),true);
  for(const view of ['all','today','important'])assert.equal(matchesView(task,view,now),false);
  assert.equal(matchesView(task,'expired',now),true);
  task.expiresAt=now+DAY;assert.equal(matchesView(task,'expired',now),false);
  for(const view of ['all','today','important'])assert.equal(matchesView(task,view,now),true);
 }
});

test('legacy database migration preserves records and restarts do not reset expiry or settings',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'board-expiry-'));const file=path.join(dir,'board.sqlite');let db;
 try{
  db=new DatabaseSync(file);
  db.exec(`CREATE TABLE buckets(id TEXT PRIMARY KEY,name TEXT,color TEXT,important INTEGER,today INTEGER,position INTEGER);
   CREATE TABLE tasks(id TEXT PRIMARY KEY,bucket_id TEXT,title TEXT,done INTEGER,important INTEGER,today INTEGER,position INTEGER);
   CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?)').run('b','Existing','red',1,1,9);
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run('t','b','Keep me',1,1,1,3);
  const started=Date.UTC(2026,9,5);
  const first=createBoardStore(db,{now:()=>started});const original=first.board().buckets[0].tasks[0];
  assert.equal(original.expiresAt,started+15*DAY);assert.equal(original.createdAt,started);
  assert.equal(original.done,true);assert.equal(original.important,true);assert.equal(original.today,true);
  assert.equal(first.board().buckets[0].position,9);assert.equal(original.position,3);
  first.mutate({op:'updateSettings',expiryDays:22});db.close();
  db=new DatabaseSync(file);const reopened=createBoardStore(db,{now:()=>started+20*DAY});
  // Everything survives the restart; only Today has lapsed because twenty days have passed.
  assert.deepEqual(reopened.board().buckets[0].tasks[0],{...original,today:false});
  assert.equal(reopened.board().settings.expiryDays,22);
  assert.equal(reopened.board().buckets[0].color,'red');
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('one-time JSON import still works and gives imported items expiry timestamps',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'board-import-'));const seedPath=path.join(dir,'seed.json');const db=new DatabaseSync(':memory:');
 try{
  const now=1000000;
  writeFileSync(seedPath,JSON.stringify({buckets:[{id:'b',name:'Imported',color:'blue',today:false,important:false,tasks:[{id:'t',title:'Imported task',done:false,today:true,important:false}]}]}));
  const first=createBoardStore(db,{seedPath,now:()=>now});assert.equal(first.board().buckets[0].tasks[0].expiresAt,now+15*DAY);
  const again=createBoardStore(db,{seedPath,now:()=>now+DAY});assert.equal(again.board().buckets[0].tasks.length,1);
  assert.equal(again.board().buckets[0].tasks[0].expiresAt,now+15*DAY);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('completion time is recorded once, kept on re-marking, and cleared when reopened',()=>{
 const f=fixture();try{
  assert.equal(f.task.doneAt,null);
  const first=f.now();
  assert.equal(f.act({op:'updateTask',id:f.task.id,done:true}).buckets[0].tasks[0].doneAt,first);
  f.setClock(first+DAY);
  assert.equal(f.act({op:'updateTask',id:f.task.id,done:true,today:true}).buckets[0].tasks[0].doneAt,first);
  assert.equal(f.act({op:'updateTask',id:f.task.id,title:'Renamed'}).buckets[0].tasks[0].doneAt,first);
  assert.equal(f.act({op:'updateTask',id:f.task.id,done:false}).buckets[0].tasks[0].doneAt,null);
  assert.equal(f.act({op:'updateTask',id:f.task.id,done:true}).buckets[0].tasks[0].doneAt,f.now());
 }finally{f.db.close();}
});

test('Today lasts until midnight in the board time zone and re-marking starts a new day',()=>{
 const f=fixture();try{
  const tz='America/New_York';f.act({op:'updateSettings',timeZone:tz});
  const midnight=startOfDayIn(tz,f.now())+DAY;
  f.setClock(midnight-60000);
  assert.equal(f.act({op:'updateTask',id:f.task.id,today:true}).buckets[0].tasks[0].today,true);
  f.setClock(midnight-1);assert.equal(f.store.board().buckets[0].tasks[0].today,true);
  f.setClock(midnight);assert.equal(f.store.board().buckets[0].tasks[0].today,false);
  assert.equal(f.act({op:'updateTask',id:f.task.id,today:true}).buckets[0].tasks[0].today,true);
  assert.equal(f.act({op:'updateTask',id:f.task.id,today:false}).buckets[0].tasks[0].todayAt,null);
  assert.equal(f.store.board().settings.timeZone,tz);
  for(const timeZone of ['Not/AZone','',42])assert.throws(()=>f.act({op:'updateSettings',timeZone}),InputError);
  assert.throws(()=>f.act({op:'updateSettings'}),InputError);
  assert.equal(f.store.board().settings.timeZone,tz);
  assert.equal(startOfDayIn('Asia/Kolkata',Date.UTC(2026,9,8,20,0)),Date.UTC(2026,9,8,18,30));
  assert.equal(startOfDayIn('UTC',Date.UTC(2026,9,8,20,0)),Date.UTC(2026,9,8));
 }finally{f.db.close();}
});

test('brain dump fills one Unsorted bucket in order, and it is recreated if deleted',()=>{
 const f=fixture();try{
  let data=f.act({op:'brainDump',titles:['  Call mum ','Pay the gas bill','Book a haircut']});
  const inbox=data.buckets[0];
  assert.equal(inbox.name,'Unsorted');assert.equal(inbox.color,'slate');
  assert.deepEqual(inbox.tasks.map(t=>t.title),['Call mum','Pay the gas bill','Book a haircut']);
  assert.equal(inbox.tasks[0].expiresAt-f.now(),15*DAY);
  data=f.act({op:'brainDump',titles:['One more']});
  assert.equal(data.buckets.filter(b=>b.name==='Unsorted').length,1);assert.equal(data.buckets[0].tasks.length,4);
  f.act({op:'deleteBucket',id:inbox.id});
  data=f.act({op:'brainDump',titles:['Fresh start']});
  assert.notEqual(data.buckets[0].id,inbox.id);assert.deepEqual(data.buckets[0].tasks.map(t=>t.title),['Fresh start']);
  for(const titles of [[],['ok',''],'text',Array(101).fill('x'),['x'.repeat(501)]])assert.throws(()=>f.act({op:'brainDump',titles}),InputError);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,2);
 }finally{f.db.close();}
});

test('setToday makes Today exactly the picked open tasks and moveTask changes bucket',()=>{
 const f=fixture();try{
  const [a,b,c]=f.act({op:'brainDump',titles:['A','B','C']}).buckets[0].tasks;
  const first=f.now();
  f.act({op:'setToday',ids:[a.id,b.id]});
  f.setClock(first+60000);
  let tasks=f.act({op:'setToday',ids:[b.id,c.id]}).buckets[0].tasks;
  const byTitle=Object.fromEntries(tasks.map(t=>[t.title,t]));
  assert.equal(byTitle.A.today,false);assert.equal(byTitle.A.todayAt,null);
  assert.equal(byTitle.B.today,true);assert.equal(byTitle.B.todayAt,first);
  assert.equal(byTitle.C.today,true);assert.equal(byTitle.C.todayAt,first+60000);
  f.act({op:'updateTask',id:f.task.id,today:true,done:true});
  tasks=f.act({op:'setToday',ids:[]}).buckets.flatMap(x=>x.tasks);
  assert.deepEqual(tasks.filter(t=>t.today).map(t=>t.id),[f.task.id]);
  for(const ids of [['missing'],[a.id,a.id],'x',[1]])assert.throws(()=>f.act({op:'setToday',ids}),InputError);
  const moved=f.act({op:'moveTask',id:a.id,bucketId:f.bucket.id}).buckets.find(x=>x.id===f.bucket.id).tasks;
  assert.ok(moved.some(t=>t.id===a.id&&t.title==='A'));
  assert.throws(()=>f.act({op:'moveTask',id:a.id,bucketId:'nope'}),InputError);
 }finally{f.db.close();}
});

test('progress counts once per day, can be undone for today, and is refused on done or expired tasks',()=>{
 const f=fixture();try{
  assert.equal(f.task.progress,0);assert.equal(f.task.progressAt,null);
  const first=f.now();
  let t=f.act({op:'logProgress',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(t.progress,1);assert.equal(t.progressAt,first);
  t=f.act({op:'logProgress',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(t.progress,1);
  f.setClock(first+DAY);
  t=f.act({op:'logProgress',id:f.task.id}).buckets[0].tasks[0];
  assert.equal(t.progress,2);assert.equal(t.progressAt,first+DAY);
  t=f.act({op:'logProgress',id:f.task.id,undo:true}).buckets[0].tasks[0];
  assert.equal(t.progress,1);assert.equal(t.progressAt,null);
  t=f.act({op:'logProgress',id:f.task.id,undo:true}).buckets[0].tasks[0];
  assert.equal(t.progress,1);
  assert.throws(()=>f.act({op:'logProgress',id:f.task.id,undo:'yes'}),InputError);
  f.act({op:'updateTask',id:f.task.id,done:true});
  assert.throws(()=>f.act({op:'logProgress',id:f.task.id}),/already done/);
  f.act({op:'updateTask',id:f.task.id,done:false});f.setClock(f.task.expiresAt);
  assert.throws(()=>f.act({op:'logProgress',id:f.task.id}),/expired/);
 }finally{f.db.close();}
});
