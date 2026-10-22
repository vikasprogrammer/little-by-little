import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';

export const DAY=86400000;
export class InputError extends Error{}
const text=(value,max)=>{
 if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new InputError('Please enter a name within the character limit.');
 return value.trim();
};
const flag=value=>{if(typeof value!=='boolean')throw new InputError('Invalid flag.');return Number(value);};
const colors=['blue','green','orange','violet','teal','pink','red','yellow','sky','slate'];
const validTimeZone=value=>{try{return typeof value==='string'&&value.length<=64&&!!new Intl.DateTimeFormat('en-US',{timeZone:value});}catch{return false;}};
// Midnight at the start of the day containing `stamp` in `timeZone` (uses the offset at `stamp`, so DST days can be off by an hour).
export function startOfDayIn(timeZone,stamp){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}).formatToParts(stamp).map(p=>[p.type,Number(p.value)]));
 const offset=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second)-Math.floor(stamp/1000)*1000;
 return Date.UTC(parts.year,parts.month-1,parts.day)-offset;
}

export function createBoardStore(db,{seedPath,now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS buckets(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT 'blue',important INTEGER NOT NULL DEFAULT 0,today INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,important INTEGER NOT NULL DEFAULT 0,today INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_tasks_bucket ON tasks(bucket_id);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 db.exec('BEGIN IMMEDIATE');
 try{
  if(seedPath&&existsSync(seedPath)&&!db.prepare("SELECT value FROM metadata WHERE key='legacy_import'").get()){
   if(db.prepare('SELECT COUNT(*) AS count FROM buckets').get().count)throw new Error('Existing board found; migration requires an explicit merge.');
   const initial=JSON.parse(readFileSync(seedPath,'utf8'));
   for(const b of initial.buckets){
    if(!colors.includes(b.color))throw new Error('Invalid imported color');
    db.prepare('INSERT INTO buckets(id,name,color,important,today,position) VALUES(?,?,?,?,?,?)').run(text(b.id,128),text(b.name,80),b.color,flag(b.important),flag(b.today),b.position??now());
    for(const t of b.tasks)db.prepare('INSERT INTO tasks(id,bucket_id,title,done,important,today,position) VALUES(?,?,?,?,?,?,?)').run(text(t.id,128),b.id,text(t.title,500),flag(t.done),flag(t.important),flag(t.today),t.position??now());
   }
   db.prepare('INSERT INTO metadata VALUES(?,?)').run('legacy_import','1');
  }
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('expiry_days','15')").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('time_zone','UTC')").run();
  const columns=db.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name);
  if(!columns.includes('created_at'))db.exec('ALTER TABLE tasks ADD COLUMN created_at INTEGER');
  if(!columns.includes('expires_at'))db.exec('ALTER TABLE tasks ADD COLUMN expires_at INTEGER');
  if(!columns.includes('done_at'))db.exec('ALTER TABLE tasks ADD COLUMN done_at INTEGER');
  // Progress without finishing: how many days you have moved a task forward, and when you last did.
  if(!columns.includes('progress'))db.exec('ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0');
  if(!columns.includes('progress_at'))db.exec('ALTER TABLE tasks ADD COLUMN progress_at INTEGER');
  // Today lasts until midnight. Items already marked Today when this column arrives keep it for the rest of the current day.
  if(!columns.includes('today_at')){db.exec('ALTER TABLE tasks ADD COLUMN today_at INTEGER');db.prepare('UPDATE tasks SET today_at=? WHERE today=1').run(now());}
  // Existing items start a full window on first migration; restarts never reset it.
  const started=now();
  db.prepare('UPDATE tasks SET created_at=COALESCE(created_at,?),expires_at=COALESCE(expires_at,?) WHERE created_at IS NULL OR expires_at IS NULL').run(started,started+expiryDays()*DAY);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}

 function expiryDays(){return Number(db.prepare("SELECT value FROM metadata WHERE key='expiry_days'").get().value);}
 function timeZone(){return db.prepare("SELECT value FROM metadata WHERE key='time_zone'").get().value;}
 function board(){
  const buckets=db.prepare('SELECT * FROM buckets ORDER BY position,id').all();
  const tasks=db.prepare('SELECT * FROM tasks ORDER BY position,id').all();const current=now();const dayStart=startOfDayIn(timeZone(),current);
  return {settings:{expiryDays:expiryDays(),timeZone:timeZone(),inboxId:db.prepare("SELECT value FROM metadata WHERE key='inbox_bucket'").get()?.value??null},serverTime:current,buckets:buckets.map(({today,important,...bucket})=>({...bucket,tasks:tasks.filter(task=>task.bucket_id===bucket.id).map(({created_at,expires_at,done_at,today_at,progress_at,...task})=>({...task,createdAt:created_at,expiresAt:expires_at,doneAt:done_at??null,todayAt:today_at??null,progress:task.progress??0,progressAt:progress_at??null,done:!!task.done,important:!!task.important,today:!!task.today&&today_at!=null&&today_at>=dayStart}))}))};
 }
 function mutate(p){
  const {op,id}=p;
  if(op==='updateSettings'){
   if(!('expiryDays' in p)&&!('timeZone' in p))throw new InputError('Nothing to update.');
   if('expiryDays' in p&&(!Number.isInteger(p.expiryDays)||p.expiryDays<1||p.expiryDays>365))throw new InputError('Choose a whole number of days from 1 to 365.');
   if('timeZone' in p&&!validTimeZone(p.timeZone))throw new InputError('Unknown time zone.');
   if('expiryDays' in p)db.prepare("UPDATE metadata SET value=? WHERE key='expiry_days'").run(String(p.expiryDays));
   if('timeZone' in p)db.prepare("UPDATE metadata SET value=? WHERE key='time_zone'").run(p.timeZone);
  }else if(op==='createBucket'){
   const name=text(p.name,80);if(!colors.includes(p.color))throw new InputError('Choose a bucket color.');
   db.prepare('INSERT INTO buckets(id,name,color,position) VALUES(?,?,?,?)').run(randomUUID(),name,p.color,now());
  }else if(op==='reorderBuckets'){
   const current=db.prepare('SELECT id FROM buckets ORDER BY position,id').all().map(b=>b.id);const ids=p.ids;
   if(!Array.isArray(ids)||ids.length!==current.length||new Set(ids).size!==current.length||!ids.every(id=>typeof id==='string'&&current.includes(id)))throw new InputError('Include every current bucket exactly once. If your buckets changed, reload the board and try again.');
   const update=db.prepare('UPDATE buckets SET position=? WHERE id=?');ids.forEach((id,index)=>update.run(index,id));
  }else if(op==='brainDump'){
   // Everything on your mind lands in one Unsorted bucket, in the order written; sorting can wait.
   const titles=p.titles;
   if(!Array.isArray(titles)||!titles.length||titles.length>100)throw new InputError('Add between 1 and 100 lines.');
   const clean=titles.map(title=>text(title,500));
   let inbox=db.prepare("SELECT value FROM metadata WHERE key='inbox_bucket'").get()?.value;
   if(!inbox||!db.prepare('SELECT id FROM buckets WHERE id=?').get(inbox)){
    inbox=randomUUID();const first=db.prepare('SELECT MIN(position) AS p FROM buckets').get().p;
    db.prepare('INSERT INTO buckets(id,name,color,position) VALUES(?,?,?,?)').run(inbox,'Unsorted','slate',first==null?now():first-1);
    db.prepare("INSERT INTO metadata(key,value) VALUES('inbox_bucket',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(inbox);
   }
   const started=now();const insert=db.prepare('INSERT INTO tasks(id,bucket_id,title,position,created_at,expires_at) VALUES(?,?,?,?,?,?)');
   clean.forEach((title,index)=>insert.run(randomUUID(),inbox,title,started+index,started,started+expiryDays()*DAY));
  }else if(op==='setToday'){
   // Today becomes exactly these open tasks. Ones already picked today keep their original time.
   const ids=p.ids;
   if(!Array.isArray(ids)||ids.length>50||!ids.every(id=>typeof id==='string')||new Set(ids).size!==ids.length)throw new InputError('Choose tasks for today.');
   const marks=ids.map(()=>'?').join(',');
   if(ids.length&&db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id IN ('+marks+')').get(...ids).n!==ids.length)throw new InputError('That task was not found.');
   const current=now();const dayStart=startOfDayIn(timeZone(),current);
   db.prepare('UPDATE tasks SET today=0,today_at=NULL WHERE done=0 AND today=1'+(ids.length?' AND id NOT IN ('+marks+')':'')).run(...ids);
   const pick=db.prepare('UPDATE tasks SET today_at=CASE WHEN today=1 AND today_at>=? THEN today_at ELSE ? END,today=1 WHERE id=?');
   for(const taskId of ids)pick.run(dayStart,current,taskId);
  }else if(['updateBucket','deleteBucket','createTask'].includes(op)){
   if(typeof id!=='string'||!db.prepare('SELECT id FROM buckets WHERE id=?').get(id))throw new InputError('That bucket was not found.');
   if(op==='deleteBucket')db.prepare('DELETE FROM buckets WHERE id=?').run(id);
   else if(op==='createTask'){
    const started=now();db.prepare('INSERT INTO tasks(id,bucket_id,title,position,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,text(p.title,500),started,started,started+expiryDays()*DAY);
   }else{
    if('today' in p||'important' in p)throw new InputError('Today and Important are available on individual tasks.');
    const fields=[],values=[];
    for(const key of ['name','color'])if(key in p){fields.push(key+'=?');if(key==='name')values.push(text(p[key],80));else{if(!colors.includes(p[key]))throw new InputError('Choose a bucket color.');values.push(p[key]);}}
    if(!fields.length)throw new InputError('Nothing to update.');
    db.prepare('UPDATE buckets SET '+fields.join(',')+' WHERE id=?').run(...values,id);
   }
  }else if(['updateTask','deleteTask','bumpTask','restoreTask','moveTask','logProgress'].includes(op)){
   const task=typeof id==='string'?db.prepare('SELECT * FROM tasks WHERE id=?').get(id):null;
   if(!task)throw new InputError('That task was not found.');
   const remaining=task.expires_at-now();
   if(op==='deleteTask')db.prepare('DELETE FROM tasks WHERE id=?').run(id);
   else if(op==='logProgress'){
    // Counts once per day; undo takes back only today's step.
    if('undo' in p&&typeof p.undo!=='boolean')throw new InputError('Invalid flag.');
    const loggedToday=task.progress_at!=null&&task.progress_at>=startOfDayIn(timeZone(),now());
    if(p.undo){if(loggedToday)db.prepare('UPDATE tasks SET progress=MAX(0,progress-1),progress_at=NULL WHERE id=?').run(id);}
    else{
     if(task.done)throw new InputError('This task is already done.');
     if(remaining<=0)throw new InputError('This item has expired. Restore it from Expired items.');
     if(!loggedToday)db.prepare('UPDATE tasks SET progress=progress+1,progress_at=? WHERE id=?').run(now(),id);
    }
   }else if(op==='moveTask'){
    if(typeof p.bucketId!=='string'||!db.prepare('SELECT id FROM buckets WHERE id=?').get(p.bucketId))throw new InputError('That bucket was not found.');
    db.prepare('UPDATE tasks SET bucket_id=?,position=? WHERE id=?').run(p.bucketId,now(),id);
   }else if(op==='bumpTask'){
    if(remaining<=0)throw new InputError('This item has expired. Restore it from Expired items.');
    if(remaining>5*DAY)throw new InputError('You can bump an item during its last five days.');
    db.prepare('UPDATE tasks SET expires_at=expires_at+? WHERE id=?').run(7*DAY,id);
   }else if(op==='restoreTask'){
    if(remaining>0)throw new InputError('This item has not expired.');
    db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run(now()+expiryDays()*DAY,id);
   }else{
    const fields=[],values=[];
    for(const key of ['title','done','today','important'])if(key in p){fields.push(key+'=?');values.push(key==='title'?text(p[key],500):flag(p[key]));}
    // Completion time feeds the daily wins jar; re-marking a done task keeps its original time.
    if('done' in p){fields.push('done_at=CASE WHEN ?=1 THEN COALESCE(done_at,?) ELSE NULL END');values.push(flag(p.done),now());}
    // Marking Today stamps the moment; the flag then counts only until midnight in the board's time zone.
    if('today' in p){fields.push('today_at=?');values.push(p.today?now():null);}
    if(!fields.length)throw new InputError('Nothing to update.');
    db.prepare('UPDATE tasks SET '+fields.join(',')+' WHERE id=?').run(...values,id);
   }
  }else throw new InputError('Unknown board action.');
  return board();
 }
 return {board,mutate};
}
