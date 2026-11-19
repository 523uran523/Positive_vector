import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

// Test the production transport with an injected storage adapter. Actual IndexedDB
// durability and File cloning are covered separately by test:browser.
test('offline transport: lost response, 401, account isolation, conflicts and storage failure',async()=>{
  const globals=globalThis as any;
  const local=new Map<string,string>();
  globals.window=new EventTarget();
  globals.localStorage={getItem:(key:string)=>local.get(key)??null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
  const storage=`
    let owner=null,epoch=0,failure=false; const queue=new Map(),cache=new Map();
    export const offlineOwner=()=>owner,offlineEpoch=()=>epoch;
    export function setOfflineOwner(id){if(owner!==id){owner=id;epoch++;}}
    export function emitQueueChanged(){}
    export const cacheGet=async url=>cache.get(owner+':'+url)??null;
    export const cacheSet=async(url,data,id=owner)=>{if(owner===id)cache.set(id+':'+url,data);};
    export async function clearOfflineStore(){epoch++;queue.clear();cache.clear();}
    export async function enqueueMutation(item){if(failure)throw new Error('quota exceeded');queue.set(item.id,{...item,ownerId:owner,status:'pending',createdAt:new Date().toISOString()});return item.id;}
    export const listQueuedMutations=async()=>[...queue.values()].filter(row=>row.ownerId===owner);
    export async function removeQueuedMutation(id){queue.delete(id);}
    export async function updateQueuedMutation(id,patch){queue.set(id,{...queue.get(id),...patch});}
    export function failStorage(){failure=true;}
  `;
  const bundle=await build({stdin:{contents:"export * from './src/lib/apiTransport'; export * from './src/lib/offlineDb';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'storage-adapter',setup(api){api.onResolve({filter:/offlineDb$/},()=>({path:'storage',namespace:'test'}));api.onLoad({filter:/.*/,namespace:'test'},()=>({contents:storage,loader:'js'}));}}]});
  const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const user=(id:string)=>({id,role:'employee',permissions:{}});
  await api.establishOfflineSession(user('alice'));api.setCsrfToken('csrf');
  const requests:any[]=[];let lost=true;
  globals.fetch=async(url:string,options:any)=>{
    requests.push({url,options});
    if(lost){lost=false;throw new TypeError('response lost');}
    return Response.json({ok:true},{headers:{'X-PV-User':'alice'}});
  };
  const sent=await api.apiRequest('/api/orders/one/resources',{method:'POST',body:{qtyMilli:1000}});
  assert.equal(sent.offlineQueued,true);assert.equal((await api.listQueuedMutations()).length,1);
  await api.syncOfflineQueue();assert.equal((await api.listQueuedMutations()).length,0);
  assert.equal(requests[0].options.headers['Idempotency-Key'],requests[1].options.headers['Idempotency-Key']);
  assert.ok(requests[1].options.headers['X-Operation-Created-At']);
  await api.enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'one'});
  await api.enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'two'});
  let calls=0;globals.fetch=async()=>{calls++;return Response.json({error:'session expired'},{status:401});};
  await api.syncOfflineQueue();assert.equal(calls,1);assert.equal(api.offlineOwner(),null);
  await api.establishOfflineSession(user('alice'));api.setCsrfToken('csrf');
  assert.equal((await api.listQueuedMutations()).length,2);
  await api.establishOfflineSession(user('bob'));api.setCsrfToken('bob-csrf');
  assert.equal((await api.listQueuedMutations()).length,0);
  globals.fetch=async()=>Response.json({_versions:{'/api/orders/one':'version-1'}},{headers:{'X-PV-User':'bob'}});
  await api.apiRequest('/api/orders/one');
  globals.fetch=async(_url:string,options:any)=>{assert.equal(options.headers['If-Match'],'version-1');return Response.json({error:'Version conflict'},{status:409});};
  await assert.rejects(api.apiRequest('/api/orders/one',{method:'PATCH',body:{title:'stale'}}),/Version conflict/);
  assert.equal((await api.listQueuedMutations())[0].status,'failed');
  await api.endOfflineSession();api.setOfflineOwner('bob');
  assert.equal((await api.listQueuedMutations()).length,0);assert.equal(await api.cacheGet('/api/orders/one'),null);
  await api.establishOfflineSession(user('bob'));
  await api.enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'pending'});
  await api.establishOfflineSession({...user('bob'),dismissedAt:new Date().toISOString()});
  assert.equal(api.offlineOwner(),null); assert.equal(api.restoredOfflineSession(),null);
  api.setOfflineOwner('bob'); assert.equal((await api.listQueuedMutations()).length,1,'dismissal does not erase queued work');
  await api.endOfflineSession(); api.setOfflineOwner('bob');
  api.failStorage();let contacted=false;globals.fetch=async()=>{contacted=true;return Response.json({});};
  await assert.rejects(api.apiRequest('/api/orders',{method:'POST',body:{}}),/quota exceeded/);
  assert.equal(contacted,false);
});
