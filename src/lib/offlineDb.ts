export interface QueuedFormEntry { name: string; value: string | File }
export interface QueuedMutation {
  id: string; ownerId: string; url: string; method: string; label: string;
  body?: unknown; formEntries?: QueuedFormEntry[]; version?: string;
  createdAt: string; status: 'pending' | 'failed'; lastError?: string;
  sequence?: number;
}
const DB_NAME = 'pv_offline_db';
const QUEUE = 'mutation_queue';
const CACHE = 'api_cache';
let owner: string | null = null;
let epoch = 0;
let opened: Promise<IDBDatabase> | null = null;
export const offlineOwner = () => owner;
export const offlineEpoch = () => epoch;
export function setOfflineOwner(id: string | null) { if(owner!==id) {owner=id; epoch++;} }
export function emitQueueChanged() { if(typeof window!=='undefined') window.dispatchEvent(new CustomEvent('pv:queue-changed')); }
function openDb(): Promise<IDBDatabase> {
  if(opened) return opened;
  opened = new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined') {reject(new Error('Локальное хранилище недоступно. Действие не сохранено.')); return;}
    const request=indexedDB.open(DB_NAME,2);
    request.onupgradeneeded=()=>{
      const db=request.result;
      // Legacy unscoped records must never be replayed under another account.
      for(const name of [QUEUE,CACHE]) {
        if(db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        db.createObjectStore(name,{keyPath:name===QUEUE?'id':'key'});
      }
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();opened=null;};resolve(request.result);};
    request.onerror=()=>reject(new Error('Не удалось открыть локальное хранилище. Действие не сохранено.'));
    request.onblocked=()=>reject(new Error('Закройте другие вкладки приложения для обновления хранилища.'));
  });
  opened.catch(()=>{opened=null;});
  return opened;
}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,fn:(tx:IDBTransaction,done:(value:T)=>void)=>void):Promise<T> {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,mode);
    let result:T;
    tx.oncomplete=()=>resolve(result);
    tx.onerror=tx.onabort=()=>reject(new Error('Не удалось сохранить данные: проверьте свободное место. Действие не подтверждено.'));
    try {fn(tx,value=>{result=value;});} catch(e) {tx.abort();reject(e);}
  });
}
export async function cacheGet<T>(url:string):Promise<T|null> {
  const id=owner;
  if(!id) return null;
  return transaction<T|null>([CACHE],'readonly',(tx,done)=>{
    const req=tx.objectStore(CACHE).get(`${id}:${url}`);
    req.onsuccess=()=>done(owner===id ? req.result?.data??null : null);
  });
}
export async function cacheSet(url:string,data:unknown,id=owner) {
  if(!id || owner!==id) return;
  await transaction<void>([CACHE],'readwrite',(tx,done)=>{tx.objectStore(CACHE).put({key:`${id}:${url}`,ownerId:id,data});done();});
}
export async function enqueueMutation(item:Omit<QueuedMutation,'ownerId'|'createdAt'|'status'>):Promise<string> {
  const id=owner;
  if(!id) throw new Error('Для сохранения действия сначала войдите в аккаунт.');
  const size=(item.formEntries||[]).reduce((sum,e)=>sum+(typeof e.value==='string'?e.value.length*2:e.value.size),0)+JSON.stringify(item.body??null).length*2;
  if(size>13*1024*1024) throw new Error('Размер операции превышает 13 МБ.');
  await transaction<void>([QUEUE],'readwrite',(tx,done)=>{
    const store=tx.objectStore(QUEUE);
    const req=store.getAll();
    req.onsuccess=()=>{
      if(owner!==id) {tx.abort();return;}
      const rows=req.result as QueuedMutation[];
      const bytes=rows.reduce((sum,row)=>sum+(row.formEntries||[]).reduce((n,e)=>n+(typeof e.value==='string'?e.value.length*2:e.value.size),0)+JSON.stringify(row.body??null).length*2,0);
      if(rows.length>=100 || bytes+size>40*1024*1024) {tx.abort();return;}
      const sequence=rows.reduce((maximum,row)=>Math.max(maximum,row.sequence||0),0)+1;
      store.put({...item,ownerId:id,sequence,createdAt:new Date().toISOString(),status:'pending'});
      done();
    };
  });
  emitQueueChanged();return item.id;
}
export async function listQueuedMutations():Promise<QueuedMutation[]> {
  const id=owner;
  if(!id) return [];
  return transaction<QueuedMutation[]>([QUEUE],'readonly',(tx,done)=>{
    const req=tx.objectStore(QUEUE).getAll();
    req.onsuccess=()=>done(owner===id ? (req.result as QueuedMutation[]).filter(r=>r.ownerId===id).sort((a,b)=>(a.sequence||0)-(b.sequence||0)||a.createdAt.localeCompare(b.createdAt)) : []);
  });
}
export async function updateQueuedMutation(id:string,patch:Partial<Pick<QueuedMutation,'status'|'lastError'|'body'>>) {
  await transaction<void>([QUEUE],'readwrite',(tx,done)=>{
    const store=tx.objectStore(QUEUE),req=store.get(id);
    req.onsuccess=()=>{if(req.result?.ownerId===owner) store.put({...req.result,...patch});done();};
  });emitQueueChanged();
}
export async function removeQueuedMutation(id:string) {
  await transaction<void>([QUEUE],'readwrite',(tx,done)=>{
    const store=tx.objectStore(QUEUE),req=store.get(id);
    req.onsuccess=()=>{if(req.result?.ownerId===owner) store.delete(id);done();};
  });emitQueueChanged();
}
export async function clearOfflineStore() {
  epoch++;
  await transaction<void>([QUEUE,CACHE],'readwrite',(tx,done)=>{tx.objectStore(QUEUE).clear();tx.objectStore(CACHE).clear();done();});
  emitQueueChanged();
}
