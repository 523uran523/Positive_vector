import { cacheGet, cacheSet, clearOfflineStore, emitQueueChanged, enqueueMutation, listQueuedMutations, offlineEpoch, offlineOwner, removeQueuedMutation, setOfflineOwner, updateQueuedMutation, type QueuedMutation } from './offlineDb';
import type { AuthUser } from '../types/crm';
let csrf:string|null=null;
const versions=new Map<string,string>();
let syncing:Promise<{synced:number;failed:number}>|null=null;
const SESSION_KEY='pv-offline-session-v2';
if(typeof window!=='undefined') window.addEventListener('storage',event=>{
  if([SESSION_KEY,'pv-queue-owner','pv-local-logout'].includes(event.key||'') && offlineOwner() && localStorage.getItem('pv-queue-owner')!==offlineOwner()) unauthorized();
});
export function setCsrfToken(value:string|null) {csrf=value;}
export async function establishOfflineSession(user:AuthUser) {
  if (user.dismissedAt) {
    setOfflineOwner(null); versions.clear(); results.clear();
    // Preserve queued operations for explicit recovery, but do not restore the old workspace offline.
    localStorage.removeItem(SESSION_KEY); localStorage.removeItem('pv-local-logout');
    return;
  }
  const previous=offlineOwner() || localStorage.getItem('pv-queue-owner');
  if(previous!==user.id) { setOfflineOwner(null);versions.clear();results.clear();await clearOfflineStore(); }
  setOfflineOwner(user.id);
  localStorage.setItem('pv-queue-owner',user.id);
  localStorage.removeItem('pv-local-logout');
  localStorage.setItem(SESSION_KEY,JSON.stringify({user,expiresAt:Date.now()+7*24*3600_000}));
  const stored=await cacheGet<Record<string,string>>('__versions').catch(()=>null);
  for(const [url,v] of Object.entries(stored||{})) versions.set(url,v);
}
export function restoredOfflineSession():AuthUser|null {
  try {const saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return saved?.expiresAt>Date.now()?saved.user:null;}catch{return null;}
}
export async function endOfflineSession() {
  csrf=null;versions.clear();results.clear();setOfflineOwner(null);localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('pv-queue-owner');localStorage.setItem('pv-local-logout','true');
  await clearOfflineStore();
}
function remember(data:any) {
  for(const [url,v] of Object.entries(data?._versions||{})) if(typeof v==='string') versions.set(url,v);
  void cacheSet('__versions',Object.fromEntries(versions)).catch(()=>{});
}
function unauthorized() {
  csrf=null;setOfflineOwner(null);versions.clear();results.clear();localStorage.removeItem(SESSION_KEY);
  // Keep the owner's pending operations for an explicit re-login by that owner.
  // A different owner's login always clears them before activating that account.
  window.dispatchEvent(new CustomEvent('pv:unauthorized'));
}
export interface RequestOptions { method?:string;body?:unknown;formData?:FormData;offlineLabel?:string;skipOfflineQueue?:boolean;useCache?:boolean }
function queueable(url:string) {return /^\/api\/(orders|clients|warehouse|shifts|finance|notifications)(\/|$)/.test(url);}
export async function apiRequest<T=any>(url:string,options:RequestOptions={}):Promise<T> {
  const method=(options.method||'GET').toUpperCase();
  const mutation=['POST','PUT','PATCH','DELETE'].includes(method);
  const auth=url.startsWith('/api/auth/');
  const owner=offlineOwner(), epoch=offlineEpoch();
  const cacheable=method==='GET' && !auth && options.useCache!==false && Boolean(owner);
  if(mutation && !auth && !options.skipOfflineQueue && queueable(url)) {
    const entries=options.formData ? Array.from(options.formData.entries()).map(([name,value])=>({name,value})) : undefined;
    const item:Omit<QueuedMutation,'ownerId'|'createdAt'|'status'>={id:crypto.randomUUID(),url,method,body:options.body,formEntries:entries,version:versions.get(url),label:options.offlineLabel||'Изменение данных'};
    // Save before sending: if a response is lost, the same operation ID survives restart.
    await enqueueMutation(item);
    if(navigator.onLine) await syncOfflineQueue();
    if(offlineOwner()!==owner || offlineEpoch()!==epoch) throw new Error('Сессия изменилась. Войдите заново.');
    const pending=(await listQueuedMutations()).find(r=>r.id===item.id);
    if(pending?.status==='failed') throw new Error(pending.lastError||'Не удалось выполнить действие.');
    if(pending) return {offlineQueued:true,queueId:item.id} as T;
    // Mutation result is cached per operation until the caller consumes it.
    const result=results.get(item.id);results.delete(item.id);
    if(result!==undefined) return result as T;
    return {offlineQueued:true,queueId:item.id} as T;
  }
  const headers:Record<string,string>={};
  if(mutation && csrf) headers['X-CSRF-Token']=csrf;
  let body:BodyInit|undefined=options.formData;
  if(!body && options.body!==undefined) {headers['Content-Type']='application/json';body=JSON.stringify(options.body);}
  let res:Response;
  try {res=await fetch(url,{method,headers,body,credentials:'same-origin'});} catch(error) {
    if(cacheable && owner===offlineOwner() && epoch===offlineEpoch()) {
      const data=await cacheGet<T>(url).catch(()=>null);
      if(data!==null) {remember(data);return data;}
    }
    throw new Error('Нет соединения с сервером. Сохранённых данных для этой страницы нет.');
  }
  const data=(res.headers.get('content-type')||'').includes('application/json') ? await res.json() : null;
  if(!auth && owner && res.headers.get('X-PV-User') && res.headers.get('X-PV-User')!==owner) {unauthorized();throw new Error('Аккаунт изменился в другой вкладке.');}
  if(!res.ok) {if(res.status===401 && !auth) unauthorized();throw new Error(data?.error||`Ошибка сервера (${res.status})`);}
  if(!auth && (owner!==offlineOwner() || epoch!==offlineEpoch())) throw new Error('Сессия изменилась.');
  if(!auth) remember(data);
  if(cacheable) await cacheSet(url,data,owner).catch(()=>{});
  return data;
}
const results=new Map<string,unknown>();
async function runSync(includeFailed:boolean) {
  const owner=offlineOwner(),epoch=offlineEpoch();
  let synced=0,failed=0;
  if(!owner || !navigator.onLine) return {synced,failed};
  if(!csrf) {
    try {
      const res=await fetch('/api/auth/status',{credentials:'same-origin',cache:'no-store'});
      const status=await res.json();
      if(owner!==offlineOwner() || epoch!==offlineEpoch()) return {synced,failed};
      if(!res.ok || status.user?.id!==owner) {unauthorized();return {synced,failed};}
      csrf=status.csrfToken;
    } catch {return {synced,failed};}
    if(!csrf) return {synced,failed};
  }
  for(const item of await listQueuedMutations()) {
    if(offlineOwner()!==owner || epoch!==offlineEpoch() || localStorage.getItem('pv-queue-owner')!==owner) break;
    if(item.status==='failed' && !includeFailed) break;
    const headers:Record<string,string>={'Idempotency-Key':item.id,'X-CSRF-Token':csrf!,'X-Operation-Created-At':item.createdAt};
    if(item.version) headers['If-Match']=item.version;
    let body:BodyInit|undefined;
    if(item.formEntries) {const fd=new FormData();for(const entry of item.formEntries) fd.append(entry.name,entry.value);body=fd;}
    else if(item.body!==undefined) {headers['Content-Type']='application/json';body=JSON.stringify(item.body);}
    try {
      const res=await fetch(item.url,{method:item.method,headers,body,credentials:'same-origin'});
      if(owner!==offlineOwner() || epoch!==offlineEpoch()) break;
      const data=(res.headers.get('content-type')||'').includes('application/json') ? await res.json() : null;
      if(res.headers.get('X-PV-User') && res.headers.get('X-PV-User')!==owner) {unauthorized();break;}
      if(res.status===401) {unauthorized();break;}
      if(!res.ok) {
        if(res.status>=400 && res.status<500) {await updateQueuedMutation(item.id,{status:'failed',lastError:data?.error||`Ошибка сервера (${res.status})`});failed++;}
        break; // Preserve order; a dependent action must not overtake a failed one.
      }
      remember(data);
      results.set(item.id,data);
      if(results.size>100) results.delete(results.keys().next().value!);
      await removeQueuedMutation(item.id);synced++;
    } catch {break;}
  }
  emitQueueChanged();
  if(synced) window.dispatchEvent(new CustomEvent('pv:offline-synced',{detail:{synced,failed}}));
  return {synced,failed};
}
export function syncOfflineQueue(options:{includeFailed?:boolean}={}) {
  if(syncing) return syncing;
  syncing=(navigator.locks ? navigator.locks.request('pv-offline-sync',()=>runSync(Boolean(options.includeFailed))) : runSync(Boolean(options.includeFailed))).finally(()=>{syncing=null;});
  return syncing;
}
