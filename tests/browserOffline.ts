import { establishOfflineSession, endOfflineSession, setCsrfToken, apiRequest, syncOfflineQueue } from '../src/lib/apiTransport';
import { cacheGet,cacheSet,clearOfflineStore,enqueueMutation,listQueuedMutations,offlineOwner,setOfflineOwner } from '../src/lib/offlineDb';
const output=document.querySelector('pre')!;
const checks:string[]=[];
function check(condition:unknown,name:string){if(!condition)throw new Error(name);checks.push(name);}
const user=(id:string)=>({id,role:'employee',permissions:{},fullName:id}) as any;
async function main(){
  if(!localStorage.getItem('test-reloaded')) {
    await establishOfflineSession(user('alice'));setCsrfToken('token');await clearOfflineStore();
    await cacheSet('/private',{amount:12345});
    await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders/test/attachments',method:'POST',label:'file',formEntries:[{name:'file',value:new File(['persistent-file'],'photo.txt',{type:'text/plain'})}]});
    localStorage.setItem('test-reloaded','1');location.reload();return;
  }
  await establishOfflineSession(user('alice'));setCsrfToken('token');
  let queue=await listQueuedMutations();
  check(queue.length===1,'queue survives browser page reload');
  const file=queue[0].formEntries![0].value as File;
  check(await file.text()==='persistent-file' && file.name==='photo.txt','File survives IndexedDB restart');
  check((await cacheGet<any>('/private'))?.amount===12345,'cache survives restart');
  await establishOfflineSession(user('bob'));
  check((await listQueuedMutations()).length===0 && await cacheGet('/private')===null,'different account cannot access old queue or cache');
  setOfflineOwner('alice');check((await listQueuedMutations()).length===0,'old account queue was erased on account change');
  await establishOfflineSession(user('bob'));setCsrfToken('token');
  let count=0;let lost=true;const processed=new Map<string,any>();
  globalThis.fetch=async(_url,init)=>{
    const id=(init?.headers as Record<string,string>)['Idempotency-Key'];
    if(!processed.has(id)){count++;processed.set(id,{ok:true,number:count});}
    if(lost){lost=false;throw new TypeError('response lost');}
    return Response.json(processed.get(id));
  };
  const sent=await apiRequest('/api/orders/example/resources',{method:'POST',body:{qtyMilli:1000}});
  check(sent.offlineQueued && (await listQueuedMutations()).length===1,'lost response retains durable operation');
  await syncOfflineQueue();
  check(count===1 && (await listQueuedMutations()).length===0,'retry keeps original operation ID');
  let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({error:'login required'},{status:401});};
  await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'one'});
  await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'two'});
  await syncOfflineQueue();check(requests===1 && offlineOwner()===null,'401 stops synchronization before next operation');
  await establishOfflineSession(user('bob'));setCsrfToken('token');
  check((await listQueuedMutations()).length===2,'same user can review queue after re-login');
  globalThis.fetch=async()=>Response.json({error:'Version conflict'},{status:409});
  await syncOfflineQueue();queue=await listQueuedMutations();
  check(queue[0].status==='failed' && queue[0].lastError==='Version conflict' && queue[1].status==='pending','conflict remains visible and blocks dependent operations');
  await endOfflineSession();setOfflineOwner('bob');
  check((await listQueuedMutations()).length===0 && await cacheGet('/private')===null,'logout erases queue and cache');
  let oversized=false;try{await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'large',formEntries:[{name:'file',value:new File([new Uint8Array(14*1024*1024)],'large')}]});}catch{oversized=true;}
  check(oversized,'oversize operations rejected');
  for(let i=0;i<100;i++)await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'limit'});
  let full=false;try{await enqueueMutation({id:crypto.randomUUID(),url:'/api/orders',method:'POST',label:'overflow'});}catch{full=true;}
  check(full && (await listQueuedMutations()).length===100,'queue cap rejects operation without claiming success');
  await clearOfflineStore();
  output.textContent=JSON.stringify({passed:checks.length,checks});
  document.title='TESTS_PASSED';
}
main().catch(error=>{output.textContent=JSON.stringify({error:String(error),checks});document.title='TESTS_FAILED';});
