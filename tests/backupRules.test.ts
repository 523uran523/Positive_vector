import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../server/db.ts';
import { createBackup, restoreBackup, verifyBackup } from '../server/services/backup.ts';
import { runDailyBackup } from '../server/services/backupScheduler.ts';
import { cleanDeletedFiles, scheduleFileDeletion } from '../server/services/fileCleanup.ts';

test('WAL backup restores database and attachment checksums, file cleanup survives retry',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-backup-test-'));
  const dbPath=path.join(root,'source.sqlite'),uploads=path.join(root,'uploads');
  fs.mkdirSync(uploads);const db=openDatabase(dbPath);runMigrations(db);
  try {
    const filename='00000000-0000-0000-0000-000000000001.txt';
    fs.writeFileSync(path.join(uploads,filename),'recover me');
    db.prepare("INSERT INTO attachments(id,entity_type,entity_id,kind,original_name,stored_name,mime_type,size_bytes,created_at) VALUES ('a','order','unused','document','a.txt',?,'text/plain',10,?)").run(filename,new Date().toISOString());
    const chatName='00000000-0000-0000-0000-000000000002';
    fs.mkdirSync(path.join(uploads,'chat')); fs.writeFileSync(path.join(uploads,'chat',chatName),'chat attachment');
    const now=new Date().toISOString();
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('chat-user','chatuser','hash','employee','Chat user',?,?)").run(now,now);
    db.prepare("INSERT INTO chat_files(id,stored_name,original_name,mime_type,size_bytes,owner_id,kind,created_at) VALUES ('chat-file',?,'voice.webm','audio/webm',15,'chat-user','message',?)").run(chatName,now);
    const docName='12345678-1234-4234-8234-123456789abc';
    fs.mkdirSync(path.join(uploads,'documents'));
    fs.writeFileSync(path.join(uploads,'documents',docName),'primary document');
    db.prepare("INSERT INTO documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at) VALUES ('doc','invoice.txt',?,16,'chat-user',?)").run(docName,now);
    const legacyDocName='22345678-1234-4234-8234-123456789abc';
    fs.mkdirSync(path.join(uploads,'accounting'));
    fs.writeFileSync(path.join(uploads,'accounting',legacyDocName),'legacy document');
    db.prepare("INSERT INTO documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at) VALUES ('doc-legacy','legacy.txt',?,15,'chat-user',?)").run(legacyDocName,now);
    const backup=path.join(root,'snapshot');
    await createBackup(dbPath,uploads,backup);verifyBackup(backup);
    assert.equal(fs.existsSync(path.join(uploads,'.backup-lock')),false);
    const restored=path.join(root,'restored');restoreBackup(backup,restored);
    const clone=openDatabase(path.join(restored,'pozitiv_vektor.sqlite'));
    try {assert.equal(clone.prepare('SELECT COUNT(*) AS n FROM attachments').get()?.n,1);}finally{clone.close();}
    assert.equal(fs.readFileSync(path.join(restored,'uploads',filename),'utf8'),'recover me');
    assert.equal(fs.readFileSync(path.join(restored,'uploads','chat',chatName),'utf8'),'chat attachment');
    assert.equal(fs.readFileSync(path.join(restored,'uploads','documents',docName),'utf8'),'primary document');
    assert.equal(fs.readFileSync(path.join(restored,'uploads','documents',legacyDocName),'utf8'),'legacy document');
    assert.throws(()=>restoreBackup(backup,restored));
    fs.writeFileSync(path.join(backup,'uploads',filename),'tampered');assert.throws(()=>verifyBackup(backup));
    scheduleFileDeletion(db,filename);cleanDeletedFiles(db,uploads);
    assert.equal(fs.existsSync(path.join(uploads,filename)),true,'live reference must block cleanup');
    db.prepare('DELETE FROM attachments').run();
    fs.writeFileSync(path.join(uploads,'.backup-lock'),'');cleanDeletedFiles(db,uploads);
    assert.equal(fs.existsSync(path.join(uploads,filename)),true,'backup lock blocks cleanup');
    fs.unlinkSync(path.join(uploads,'.backup-lock'));cleanDeletedFiles(db,uploads);
    assert.equal(fs.existsSync(path.join(uploads,filename)),false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_deletions').get()?.n,0);
    assert.throws(()=>scheduleFileDeletion(db,'../outside'));
  } finally {
    db.close();
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(root).startsWith('pv-backup-test-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('daily backup keeps only the three most recent copies and skips repeats for the same day',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-backup-retention-'));
  const dbPath=path.join(root,'source.sqlite'),uploads=path.join(root,'uploads'),backups=path.join(root,'backups');
  fs.mkdirSync(uploads);const db=openDatabase(dbPath);runMigrations(db);db.close();
  try {
    for(let day=1;day<=5;day+=1){
      const now=new Date(Date.UTC(2026,0,day,2,0));
      assert.equal((await runDailyBackup(dbPath,uploads,backups,now)).created,true);
    }
    const kept=fs.readdirSync(backups).sort();
    assert.equal(kept.length,3);
    assert.ok(kept.every(name=>/^pv-daily-2026-01-0[345]-[0-9a-f]{8}$/.test(name)),kept.join(','));
    const again=await runDailyBackup(dbPath,uploads,backups,new Date(Date.UTC(2026,0,5,2,0)));
    assert.equal(again.created,false);
    assert.equal(fs.readdirSync(backups).length,3);
  } finally {
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(root).startsWith('pv-backup-retention-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
