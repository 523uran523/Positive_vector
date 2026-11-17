import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../server/db.ts';
import { createBackup, restoreBackup, verifyBackup } from '../server/services/backup.ts';
import { cleanDeletedFiles, scheduleFileDeletion } from '../server/services/fileCleanup.ts';

test('WAL backup restores database and attachment checksums, file cleanup survives retry',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-backup-test-'));
  const dbPath=path.join(root,'source.sqlite'),uploads=path.join(root,'uploads');
  fs.mkdirSync(uploads);const db=openDatabase(dbPath);runMigrations(db);
  try {
    const filename='00000000-0000-0000-0000-000000000001.txt';
    fs.writeFileSync(path.join(uploads,filename),'recover me');
    db.prepare("INSERT INTO attachments(id,entity_type,entity_id,kind,original_name,stored_name,mime_type,size_bytes,created_at) VALUES ('a','order','unused','document','a.txt',?,'text/plain',10,?)").run(filename,new Date().toISOString());
    const backup=path.join(root,'snapshot');
    await createBackup(dbPath,uploads,backup);verifyBackup(backup);
    assert.equal(fs.existsSync(path.join(uploads,'.backup-lock')),false);
    const restored=path.join(root,'restored');restoreBackup(backup,restored);
    const clone=openDatabase(path.join(restored,'pozitiv_vektor.sqlite'));
    try {assert.equal(clone.prepare('SELECT COUNT(*) AS n FROM attachments').get()?.n,1);}finally{clone.close();}
    assert.equal(fs.readFileSync(path.join(restored,'uploads',filename),'utf8'),'recover me');
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
