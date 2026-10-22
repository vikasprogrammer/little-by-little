import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Layers2,Loader2,LogOut} from 'lucide-react';
import Board from './board';
import './style.css';
function App(){
 const [authenticated,setAuthenticated]=useState<boolean|null>(null);const [password,setPassword]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const check=()=>fetch('/api/session',{cache:'no-store'}).then(r=>r.json()).then(d=>setAuthenticated(d.authenticated)).catch(()=>{setAuthenticated(false);setError('Your board could not connect. Try signing in again.');});
 useEffect(()=>{void check();},[]);
 useEffect(()=>{const listener=()=>{setAuthenticated(false);setPassword('');setError('Please sign in again to continue.');};window.addEventListener('board-session-expired',listener);return()=>window.removeEventListener('board-session-expired',listener);},[]);
 if(authenticated===null)return <div className="login-shell"><Loader2 className="spin" aria-label="Opening your board"/></div>;
 if(authenticated)return <><Board/><button className="logout-control" title="Sign out" aria-label="Sign out" onClick={async()=>{const r=await fetch('/api/logout',{method:'POST'});if(r.ok){setAuthenticated(false);setPassword('');setError('');}}}><LogOut size={16}/></button></>;
 return <main className="login-shell"><div className="login-card"><span className="brand-mark"><Layers2 size={22}/></span><h1>little by little</h1><p className="login-description">Your private space for small steps.</p><form className="edit-form" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});const d=await r.json();if(!r.ok)throw new Error(d.error);setPassword('');setAuthenticated(true);}catch(e){setError(e instanceof Error?e.message:'Sign-in failed. Please try again.');}finally{setBusy(false);}}}><label htmlFor="board-password" className="field-label">Board password</label><input className="text-input" id="board-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required disabled={busy}/>{error&&<p className="dialog-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy||!password}>{busy?'Signing in…':'Open your board'}</button></form></div></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
