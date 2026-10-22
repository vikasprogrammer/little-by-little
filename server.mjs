import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHmac,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {createBoardStore,InputError} from './board-store.mjs';
import {createBoardMcpRoute} from './board-mcp.mjs';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.resolve(process.env.BOARD_DATA_DIR||path.join(root,'data'));
mkdirSync(dataDir,{recursive:true,mode:0o700});
const dbPath=path.join(dataDir,'board.sqlite');
const db=new DatabaseSync(dbPath);chmodSync(dbPath,0o600);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const {board,mutate}=createBoardStore(db,{seedPath:path.join(root,'initial-data.json')});
const passwordHash=process.env.BOARD_PASSWORD_HASH||'';
const sessionKey=process.env.BOARD_SESSION_KEY||'';
const authReady=!!passwordHash&&sessionKey.length>=32;
const secure=process.env.NODE_ENV!=='development';
function safeEqual(a,b){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function authenticated(req){if(!authReady)return false;const value=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('board_session='))?.slice(14);if(!value)return false;const parts=value.split('.');if(parts.length!==3)return false;const [expiry,nonce,signature]=parts;if(!/^\d+$/.test(expiry)||Number(expiry)<=Date.now()||Number(expiry)>Date.now()+31*86400000)return false;const expected=createHmac('sha256',sessionKey).update(expiry+'.'+nonce).digest('base64url');return safeEqual(signature,expected);}
function cookie(value,maxAge){return `board_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;}
function sessionCookie(){const expiry=String(Date.now()+30*86400000);const nonce=randomBytes(16).toString('base64url');const signature=createHmac('sha256',sessionKey).update(expiry+'.'+nonce).digest('base64url');return cookie(expiry+'.'+nonce+'.'+signature,30*86400);}
function allowedOrigin(req){if(req.headers['sec-fetch-site']==='cross-site')return false;if(!req.headers.origin)return true;try{const origin=new URL(req.headers.origin);return process.env.APP_ORIGIN?origin.origin===new URL(process.env.APP_ORIGIN).origin:origin.host===req.headers.host;}catch{return false;}}
async function payload(req){let result='';for await(const chunk of req){result+=chunk;if(result.length>20000)throw new InputError('That request is too large.');}const p=JSON.parse(result);if(!p||typeof p!=='object'||Array.isArray(p))throw new InputError('Invalid board action.');return p;}
function json(res,data,status=200,extra={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(data));}
function changeBoard(p){db.exec('BEGIN IMMEDIATE');try{const data=mutate(p);db.exec('COMMIT');return data;}catch(error){db.exec('ROLLBACK');throw error;}}
const mcp=createBoardMcpRoute({board,change:changeBoard,tokenHash:process.env.BOARD_MCP_TOKEN_HASH,allowedOrigin});
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const publicRoot=path.join(root,'public');let failures=0,windowStart=Date.now();
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 try{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/mcp')return await mcp.handle(req,res);
 if(pathname==='/healthz')return json(res,{status:'ok'});
 if(pathname==='/api/session'&&req.method==='GET')return json(res,{authenticated:authenticated(req)});
 if(pathname==='/api/login'&&req.method==='POST'){
 if(!allowedOrigin(req))return json(res,{error:'This request is not allowed.'},403);
 if(!authReady)return json(res,{error:'Private access is being configured. Please try again shortly.'},503);
 if(Date.now()-windowStart>15*60000){failures=0;windowStart=Date.now();}if(failures>=10)return json(res,{error:'Too many sign-in attempts. Please try again in 15 minutes.'},429);
 const p=await payload(req);if(typeof p.password!=='string'||p.password.length>256)return json(res,{error:'Enter your board password.'},400);
 const [salt,hash]=passwordHash.split(':');const candidate=scryptSync(p.password,salt,64).toString('hex');if(!hash||!safeEqual(candidate,hash)){failures++;return json(res,{error:'That password did not match. Try again.'},401);}failures=0;
 return json(res,{authenticated:true},200,{'Set-Cookie':sessionCookie()});}
 if(pathname==='/api/logout'&&req.method==='POST'){if(!allowedOrigin(req))return json(res,{error:'This request is not allowed.'},403);return json(res,{authenticated:false},200,{'Set-Cookie':cookie('',0)});}
 if(pathname.startsWith('/api/')){
 if(!authenticated(req))return json(res,{error:'Please sign in to open your board.'},401);
 if(pathname==='/api/board'&&req.method==='GET')return json(res,board());
 if(pathname==='/api/board'&&req.method==='POST'){if(!allowedOrigin(req))return json(res,{error:'This request is not allowed.'},403);const p=await payload(req);return json(res,changeBoard(p));}
 return json(res,{error:'Not found'},404);}
 if(!['GET','HEAD'].includes(req.method))return json(res,{error:'Method not allowed'},405);
 const decoded=decodeURIComponent(pathname);const filename=decoded==='/'?'index.html':decoded.replace(/^\/+/, '');const target=path.resolve(publicRoot,filename);
 if(!target.startsWith(publicRoot+path.sep))return json(res,{error:'Not found'},404);
 let meta;try{meta=await stat(target);}catch{return json(res,{error:'Not found'},404);}if(!meta.isFile())return json(res,{error:'Not found'},404);
 const content=await readFile(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':filename.startsWith('assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
 }catch(e){if(e instanceof InputError||e instanceof SyntaxError||e instanceof URIError)return json(res,{error:e.message},400);console.error('Board request failed:',e.message);return json(res,{error:'That change could not be saved. Please try again.'},503);}
});
const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log('Little by Little listening on port '+port));
function stop(){void mcp.close();server.close(()=>{db.close();process.exit(0);});}process.on('SIGTERM',stop);process.on('SIGINT',stop);
