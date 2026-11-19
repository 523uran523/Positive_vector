import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase,runMigrations } from '../server/db.ts';
import { runDailyBackup } from '../server/services/backupScheduler.ts';
import { uploadWeeklyIfDue,restoreWeeklyBackup,type CloudBackupStore } from '../server/services/yandexBackup.ts';

test('daily copies keep seven verified generations; cloud schedule is test-only until connected',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-scheduled-'));
  const uploads=path.join(root,'uploads'),dbPath=path.join(root,'source.sqlite'),backups=path.join(root,'backups');
  fs.mkdirSync(uploads);const db=openDatabase(dbPath);runMigrations(db);
  try {
    for(let day=1;day<=9;day++) await runDailyBackup(dbPath,uploads,backups,new Date(2026,0,day,12));
    const dirs=fs.readdirSync(backups);assert.equal(dirs.length,7);
    assert.ok(dirs.some(n=>n.startsWith('pv-daily-2026-01-09')));
    assert.ok(!dirs.some(n=>n.startsWith('pv-daily-2026-01-01')));
    assert.equal((await runDailyBackup(dbPath,uploads,backups,new Date(2026,0,9,18))).created,false);
    const source=path.join(backups,dirs.sort().reverse()[0]);
    const complete:string[]=[], files:string[]=[], removed:string[]=[],remote=new Map<string,Buffer>();
    let current='';
    const store:CloudBackupStore={
      async ensureRoot(){},async createFolder(name){current=name;},async putFile(folder,name,file){files.push(name);remote.set(`${folder}/${name}`,fs.readFileSync(file));},
      async completeFolder(name){complete.push(name);},async listComplete(){return [...complete];},async removeFolder(name){removed.push(name);complete.splice(complete.indexOf(name),1);},async getFile(folder,name,target){fs.writeFileSync(target,remote.get(`${folder}/${name}`)!,{flag:'wx'});},
    };
    const first=await uploadWeeklyIfDue(store,source,new Date('2026-01-09T12:00:00Z'));
    assert.equal(first.uploaded,true);assert.equal(files.at(-1),'manifest.json');assert.equal(complete[0],current);
    const restored=path.join(root,'restored'),staging=path.join(root,'staging');
    await restoreWeeklyBackup(store,complete[0],staging,restored);
    const restoredDb=openDatabase(path.join(restored,'pozitiv_vektor.sqlite'));try {assert.ok(restoredDb.prepare('SELECT COUNT(*) AS n FROM settings').get());} finally {restoredDb.close();}
    assert.equal((await uploadWeeklyIfDue(store,source,new Date('2026-01-10T12:00:00Z'))).uploaded,false);
    for(let i=1;i<=6;i++) await uploadWeeklyIfDue(store,source,new Date(Date.UTC(2026,0,9+i*7,12)));
    assert.ok(removed.length>0);assert.ok(complete.length>=4);
  } finally {
    db.close();const resolved=path.resolve(root);
    assert.ok(path.dirname(resolved)===path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('pv-scheduled-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
