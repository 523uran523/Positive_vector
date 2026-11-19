import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { restoreBackup, verifyBackup } from './backup.ts';

/** This module does not connect on its own. A future setup must explicitly supply a token. */
export interface CloudBackupStore {
  ensureRoot():Promise<void>;
  createFolder(name:string):Promise<void>;
  putFile(folder:string,name:string,file:string):Promise<void>;
  completeFolder(folder:string):Promise<void>;
  listComplete():Promise<string[]>;
  removeFolder(name:string):Promise<void>;
  getFile(folder:string,name:string,target:string):Promise<void>;
}
const weekly=/^pv-weekly-(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}$/;
// OAuth scope cloud_api:disk.app_folder restricts access to this application's folder.
const root='app:/PositiveVectorBackups';
function safeRelative(file:string) {return file.split(path.sep).join('/');}

export async function uploadWeeklyBackup(store:CloudBackupStore,backupDir:string,now=new Date()) {
  verifyBackup(backupDir);
  const date=now.toISOString().slice(0,10),name=`pv-weekly-${date}-${crypto.randomBytes(4).toString('hex')}`;
  const manifest=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8')) as {files:Record<string,string>};
  await store.ensureRoot();await store.createFolder(name);
  for(const file of Object.keys(manifest.files).sort()) {
    const target=path.resolve(backupDir,file);
    if(!target.startsWith(path.resolve(backupDir)+path.sep)) throw new Error('Небезопасный путь в копии');
    await store.putFile(name,safeRelative(file),target);
  }
  await store.putFile(name,'manifest.json',path.join(backupDir,'manifest.json'));
  await store.completeFolder(name);
  const completed=(await store.listComplete()).filter(item=>weekly.test(item)).sort().reverse();
  const cutoff=now.getTime()-30*24*60*60*1000;
  for(const old of completed.slice(4)) {
    const match=weekly.exec(old)!;
    if(Date.parse(`${match[1]}T00:00:00Z`)<cutoff) await store.removeFolder(old);
  }
  return name;
}

export async function uploadWeeklyIfDue(store:CloudBackupStore,backupDir:string,now=new Date()) {
  await store.ensureRoot();
  const latest=(await store.listComplete()).filter(name=>weekly.test(name)).sort().reverse()[0];
  if(latest && now.getTime()-Date.parse(`${weekly.exec(latest)![1]}T00:00:00Z`)<7*24*60*60*1000) return {uploaded:false};
  const name=await uploadWeeklyBackup(store,backupDir,now);
  return {uploaded:true,name};
}

export async function restoreWeeklyBackup(store:CloudBackupStore,folder:string,stagingDir:string,destination:string) {
  if(!weekly.test(folder) || fs.existsSync(stagingDir) || fs.existsSync(destination)) throw new Error('Для восстановления нужны новые безопасные каталоги.');
  if(!(await store.listComplete()).includes(folder)) throw new Error('Облачная копия не завершена или не найдена.');
  fs.mkdirSync(stagingDir,{recursive:true,mode:0o700});
  await store.getFile(folder,'manifest.json',path.join(stagingDir,'manifest.json'));
  const manifest=JSON.parse(fs.readFileSync(path.join(stagingDir,'manifest.json'),'utf8')) as {files?:Record<string,string>};
  if(!manifest.files || !manifest.files['database.sqlite']) throw new Error('Некорректное содержимое копии.');
  for(const name of Object.keys(manifest.files)) {
    const target=path.resolve(stagingDir,name);
    if(!target.startsWith(path.resolve(stagingDir)+path.sep) || name.split(/[\\/]/).some(part=>part==='..' || !part)) throw new Error('Небезопасный путь в копии.');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    await store.getFile(folder,name,target);
  }
  fs.mkdirSync(path.join(stagingDir,'uploads'),{recursive:true,mode:0o700});
  verifyBackup(stagingDir);
  restoreBackup(stagingDir,destination);
}

export function createYandexBackupStore(token:string,request:typeof fetch=fetch):CloudBackupStore {
  if(!token.trim()) throw new Error('Яндекс Диск не подключён.');
  const api='https://cloud-api.yandex.net/v1/disk/resources';
  const auth={Authorization:`OAuth ${token}`};
  const url=(remote:string,extra='')=>`${api}?path=${encodeURIComponent(remote)}${extra}`;
  async function apiCall(remote:string,init:RequestInit={},extra='') {
    const response=await request(url(remote,extra),{...init,headers:{...auth,...init.headers}});
    if(!response.ok) throw new Error(`Яндекс Диск: ошибка ${response.status}`);
    return response;
  }
  async function makeFolder(remote:string,existsOk=false) {
    const response=await request(url(remote),{method:'PUT',headers:auth});
    if(!response.ok && !(existsOk && response.status===409)) throw new Error(`Яндекс Диск: ошибка ${response.status}`);
  }
  const pathFor=(folder:string,file='')=>{
    if(!weekly.test(folder) || file.split('/').some(part=>!part || part==='.' || part==='..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
      if(!weekly.test(folder) || file) throw new Error('Некорректное имя облачной копии');
    }
    return `${root}/${folder}${file?'/'+file:''}`;
  };
  return {
    ensureRoot:()=>makeFolder(root,true),
    createFolder:(name)=>makeFolder(pathFor(name)),
    async putFile(folder,name,file) {
      const parts=name.split('/');
      for(let index=1;index<parts.length;index++) await makeFolder(pathFor(folder,parts.slice(0,index).join('/')),true);
      const linkResponse=await request(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(pathFor(folder,name))}&overwrite=false`,{headers:auth});
      if(!linkResponse.ok) throw new Error(`Яндекс Диск: ошибка ${linkResponse.status}`);
      const link=await linkResponse.json() as {href?:string};
      if(!link.href || new URL(link.href).protocol!=='https:') throw new Error('Яндекс Диск не предоставил защищённую ссылку загрузки.');
      const upload=await request(link.href,{method:'PUT',body:fs.createReadStream(file) as unknown as BodyInit,duplex:'half'} as RequestInit);
      if(!upload.ok) throw new Error(`Яндекс Диск: ошибка загрузки ${upload.status}`);
    },
    async completeFolder(folder) {
      const marker=pathFor(folder,'.pv-ready');
      const response=await request(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(marker)}&overwrite=false`,{headers:auth});
      if(!response.ok) throw new Error(`Яндекс Диск: ошибка ${response.status}`);
      const link=await response.json() as {href?:string};
      if(!link.href || new URL(link.href).protocol!=='https:') throw new Error('Нет защищённой ссылки загрузки.');
      const uploaded=await request(link.href,{method:'PUT',body:'complete'});
      if(!uploaded.ok) throw new Error(`Яндекс Диск: ошибка загрузки ${uploaded.status}`);
    },
    async listComplete() {
      const response=await apiCall(root,{},'&limit=1000');
      const listing=await response.json() as {_embedded?:{items?:Array<{name:string;type:string}>}};
      const names=(listing._embedded?.items||[]).filter(item=>item.type==='dir' && weekly.test(item.name)).map(item=>item.name);
      const result:string[]=[];
      for(const name of names) {
        const check=await request(url(pathFor(name,'.pv-ready')),{headers:auth});
        if(check.ok) result.push(name); else if(check.status!==404) throw new Error(`Яндекс Диск: ошибка ${check.status}`);
      }
      return result;
    },
    async removeFolder(name) {await apiCall(pathFor(name),{method:'DELETE'},'&permanently=true');},
    async getFile(folder,name,target) {
      const response=await request(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(pathFor(folder,name))}`,{headers:auth});
      if(!response.ok) throw new Error(`Яндекс Диск: ошибка ${response.status}`);
      const link=await response.json() as {href?:string};
      if(!link.href || new URL(link.href).protocol!=='https:') throw new Error('Нет защищённой ссылки скачивания.');
      const download=await request(link.href);
      if(!download.ok || !download.body) throw new Error(`Яндекс Диск: ошибка скачивания ${download.status}`);
      await pipeline(Readable.fromWeb(download.body as any),fs.createWriteStream(target,{flags:'wx',mode:0o600}));
    },
  };
}
