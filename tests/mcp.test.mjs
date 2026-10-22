import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBoardStore,DAY} from '../board-store.mjs';
import {createBoardMcpRoute} from '../board-mcp.mjs';

async function fixture(t,{configured=true}={}){
 let now=Date.UTC(2026,9,5);
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const store=createBoardStore(db,{now:()=>now});
 const token='disposable_test_token_1234567890';
 const change=p=>{db.exec('BEGIN IMMEDIATE');try{const value=store.mutate(p);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const route=createBoardMcpRoute({board:store.board,change,tokenHash:configured?createHash('sha256').update(token).digest('hex'):undefined,allowedOrigin:req=>!req.headers.origin||req.headers.origin==='http://'+req.headers.host});
 const server=http.createServer((req,res)=>void route.handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=new URL('http://127.0.0.1:'+server.address().port+'/mcp');
 const clients=[];
 t.after(async()=>{for(const client of clients)await client.close();await route.close();await new Promise(resolve=>server.close(resolve));db.close();});
 const connect=async(mode='legacy')=>{
  const client=new Client({name:'board-test-agent',version:'1.0.0'},{versionNegotiation:{mode}});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;
 };
 const raw=(body,extra={},method='POST')=>fetch(url,{method,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token,...extra},body:method==='POST'?typeof body==='string'?body:JSON.stringify(body):undefined});
 return {db,store,change,url,token,connect,raw,setClock:value=>now=value,now:()=>now};
}
const call=(client,name,args={})=>client.callTool({name,arguments:args});
const output=async(client,name,args={})=>{const data=await call(client,name,args);assert(!data.isError,JSON.stringify(data));return data.structuredContent??JSON.parse(data.content[0].text);};

test('remote endpoint requires its own bearer token and validates origins',async t=>{
 const f=await fixture(t);const request={jsonrpc:'2.0',id:1,method:'tools/list'};
 for(const Authorization of ['', 'Bearer wrong', 'Basic anything']){
  const response=await f.raw(request,{Authorization,Cookie:'board_session=anything'});assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/Bearer/);
 }
 assert.equal((await f.raw(request,{Origin:'https://other.example'})).status,403);
 assert.equal((await f.raw(request,{Origin:f.url.origin})).status,200);
 assert.equal((await f.raw(undefined,{},'GET')).status,405);
 const queryUrl=new URL(f.url);queryUrl.searchParams.set('token',f.token);
 assert.equal((await fetch(queryUrl,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(request)})).status,401);
});

test('unconfigured agent endpoint stays inaccessible',async t=>{
 const f=await fixture(t,{configured:false});assert.equal((await f.raw({jsonrpc:'2.0',id:1,method:'tools/list'})).status,503);
});

for(const mode of ['legacy',{pin:'2026-07-28'}])test('SDK client discovers and calls tools: '+JSON.stringify(mode),async t=>{
 const f=await fixture(t);const client=await f.connect(mode);
 const {tools}=await client.listTools();assert.equal(tools.length,12);
 assert.equal(tools.find(tool=>tool.name==='read_board').annotations.readOnlyHint,true);
 assert.equal(tools.find(tool=>tool.name==='delete_task').annotations.destructiveHint,true);
 assert.equal(tools.find(tool=>tool.name==='update_bucket').inputSchema.additionalProperties,false);
 assert.deepEqual((await output(client,'read_board')).buckets,[]);
 assert.equal((await output(client,'get_settings')).settings.expiryDays,15);
});

test('bucket and task tools share persistence, flags, settings, and ordering',async t=>{
 const f=await fixture(t);const client=await f.connect();
 const a=(await output(client,'create_bucket',{name:'Project'})).bucket;
 const b=(await output(client,'create_bucket',{name:'Personal',color:'teal'})).bucket;
 const created=(await output(client,'create_task',{bucketId:a.id,title:'Small step'})).task;
 assert.equal(created.expiresAt-created.createdAt,15*DAY);
 const updated=(await output(client,'update_task',{id:created.id,title:'Next small step',today:true,important:true,done:true})).task;
 assert.equal(updated.expiresAt,created.expiresAt);assert.equal(updated.today,true);assert.equal(updated.important,true);assert.equal(updated.done,true);
 assert.equal((await output(client,'read_board',{view:'today'})).buckets[0].tasks[0].title,'Next small step');
 assert.equal((await output(client,'read_board',{view:'important',includeDone:false})).buckets.length,0);
 const reordered=await output(client,'reorder_buckets',{ids:[b.id,a.id]});assert.deepEqual(reordered.buckets.map(bucket=>bucket.id),[b.id,a.id]);
 const renamed=(await output(client,'update_bucket',{id:a.id,name:'Renamed',color:'red'})).bucket;assert.equal(renamed.name,'Renamed');
 await output(client,'update_settings',{expiryDays:30});
 const future=(await output(client,'create_task',{bucketId:b.id,title:'Future step'})).task;assert.equal(future.expiresAt-f.now(),30*DAY);
 assert.equal(f.store.board().buckets.find(bucket=>bucket.id===a.id).tasks[0].expiresAt,created.expiresAt);
 await output(client,'delete_task',{id:future.id,confirm:true});assert.equal(f.store.board().buckets[0].tasks.length,0);
 await output(client,'delete_bucket',{id:a.id,confirm:true});assert.equal(f.store.board().buckets.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
});

test('invalid calls cannot delete, bypass bucket rules, overwrite expiry, or partially reorder',async t=>{
 const f=await fixture(t);const client=await f.connect();const a=(await output(client,'create_bucket',{name:'Keep'})).bucket;
 const task=(await output(client,'create_task',{bucketId:a.id,title:'Keep task'})).task;
 for(const [tool,args] of [
  ['delete_task',{id:task.id}],['delete_bucket',{id:a.id,confirm:false}],
  ['update_bucket',{id:a.id,today:true}],['update_task',{id:task.id,expiresAt:0}],
  ['update_task',{id:task.id}],['reorder_buckets',{ids:[a.id,a.id]}],
  ['create_task',{bucketId:'missing',title:'Nope'}],['update_settings',{expiryDays:0}]
 ]){
  const response=await call(client,tool,args);assert.equal(response.isError,true,tool);
 }
 assert.equal(f.store.board().buckets[0].tasks.length,1);assert.equal(f.store.board().buckets[0].tasks[0].expiresAt,task.expiresAt);
});

test('expiry and bump constraints are enforced through MCP and expired items restore',async t=>{
 const f=await fixture(t);const client=await f.connect();const bucket=(await output(client,'create_bucket',{name:'Project'})).bucket;
 const task=(await output(client,'create_task',{bucketId:bucket.id,title:'Keep this'})).task;
 assert.equal((await call(client,'bump_task',{id:task.id})).isError,true);
 f.setClock(task.expiresAt-5*DAY);
 const bumped=(await output(client,'bump_task',{id:task.id})).task;assert.equal(bumped.expiresAt,task.expiresAt+7*DAY);
 assert.equal((await call(client,'bump_task',{id:task.id})).isError,true);
 f.setClock(bumped.expiresAt);
 assert.equal((await output(client,'read_board')).buckets[0].tasks.length,0);
 assert.equal((await output(client,'read_board',{view:'expired'})).buckets[0].tasks[0].expired,true);
 assert.equal((await call(client,'bump_task',{id:task.id})).isError,true);
 const restored=(await output(client,'restore_task',{id:task.id})).task;assert.equal(restored.expiresAt,f.now()+15*DAY);
 assert.equal((await output(client,'read_board',{view:'expired'})).buckets.length,0);
});

test('bad JSON, oversized bodies, and unknown methods return errors without state changes',async t=>{
 const f=await fixture(t);
 assert.equal((await f.raw('{oops')).status,400);
 assert.equal((await f.raw('x'.repeat(65537))).status,413);
 const response=await f.raw({jsonrpc:'2.0',id:1,method:'not/a/method'});
 const data=await response.text();assert.match(data,/-32601/);
 assert.deepEqual(f.store.board().buckets,[]);
});
