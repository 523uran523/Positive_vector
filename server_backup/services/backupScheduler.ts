import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, verifyBackup } from './backup.ts';
import { uploadWeeklyIfDue, type CloudBackupStore } from './yandexBackup.ts';

const managed=/^pv-daily-(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}$/;
const day=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export interface BackupStatus {lastSuccess:string|null;lastError:string|null;cloud:'not_connected'|'connected';lastCloudSuccess:string|null}

export async function runDailyBackup(dbPath:string,uploadDir:string,backupDir:string,now=new Date()) {
  const root=path.resolve(backupDir);fs.mkdirSync(root,{recursive:true,mode:0o700});
  const existing=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory() && !entry.isSymbolicLink() && managed.test(entry.name) && fs.existsSync(path.join(root,entry.name,'.pv-complete'))).sort((a,b)=>b.name.localeCompare(a.name));
  if(existing.some(entry=>entry.name.startsWith(`pv-daily-${day(now)}-`))) return {created:false};
  const name=`pv-daily-${day(now)}-${crypto.randomBytes(4).toString('hex')}`;
  const destination=path.join(root,name);
  await createBackup(dbPath,uploadDir,destination);
  verifyBackup(destination);
  fs.writeFileSync(path.join(destination,'.pv-complete'),'positive-vector-backup-v1\n',{mode:0o600,flag:'wx'});
  // Remove only completed backups created by this scheduler, after a new verified copy exists.
  const completed=[name,...existing.map(entry=>entry.name)].sort().reverse();
  for(const oldName of completed.slice(7)) {
    if(!managed.test(oldName)) continue;
    const target=path.resolve(root,oldName);
    if(path.dirname(target)!==root || fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe backup retention target');
    fs.rmSync(target,{recursive:true,force:false});
  }
  return {created:true,name};
}

export function startBackupScheduler(dbPath:string,uploadDir:string,backupDir:string,onError?:(message:string)=>void,cloud?:()=>Promise<CloudBackupStore|null>) {
  if(dbPath===':memory:') return ()=>{};
  let running=false;
  const tick=async()=>{
    if(running) return;running=true;
    try {
      await runDailyBackup(dbPath,uploadDir,backupDir);
      const connectedCloud=cloud ? await cloud() : null;
      if(connectedCloud) {
        const latest=fs.readdirSync(backupDir,{withFileTypes:true}).filter(entry=>entry.isDirectory() && !entry.isSymbolicLink() && managed.test(entry.name) && fs.existsSync(path.join(backupDir,entry.name,'.pv-complete'))).map(entry=>entry.name).sort().reverse()[0];
        if(latest) await uploadWeeklyIfDue(connectedCloud,path.join(backupDir,latest));
      }
    }
    catch(err){onError?.(err instanceof Error?err.message:'Неизвестная ошибка резервного копирования');}
    finally {running=false;}
  };
  void tick();
  const timer=setInterval(()=>void tick(),60*60*1000);timer.unref();
  return ()=>clearInterval(timer);
}
