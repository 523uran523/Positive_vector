import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export function scheduleFileDeletion(db:DatabaseSync,storedName:string) {
  if(path.basename(storedName)!==storedName) throw new Error('Unsafe stored file name');
  db.prepare('INSERT OR IGNORE INTO file_deletions(stored_name,created_at) VALUES (?,?)').run(storedName,new Date().toISOString());
}
export function cleanDeletedFiles(db:DatabaseSync,uploadDir:string) {
  const root=path.resolve(uploadDir);
  if(!fs.existsSync(root)) return;
  if(fs.existsSync(path.join(root,'.backup-lock'))) return;
  // A crash after multer writes but before commit can leave an unreferenced file.
  for(const file of fs.readdirSync(root)) {
    if(!/^[0-9a-f-]{36}(\.[a-zA-Z0-9.]{1,11})?$/.test(file)) continue;
    const full=path.join(root,file);
    if(fs.statSync(full).mtimeMs<Date.now()-24*3600_000 && !db.prepare('SELECT 1 FROM attachments WHERE stored_name=?').get(file)) scheduleFileDeletion(db,file);
  }
  for(const row of db.prepare('SELECT stored_name FROM file_deletions LIMIT 100').all()) {
    if(fs.existsSync(path.join(root,'.backup-lock'))) break;
    const name=String(row.stored_name);
    if(path.basename(name)!==name) continue;
    if(db.prepare('SELECT 1 FROM attachments WHERE stored_name=?').get(name)) continue;
    try {
      fs.rmSync(path.join(root,name),{force:true});
      db.prepare('DELETE FROM file_deletions WHERE stored_name=?').run(name);
    } catch(error) {
      db.prepare('UPDATE file_deletions SET last_error=? WHERE stored_name=?').run(error instanceof Error ? error.message : 'cleanup failed',name);
    }
  }
}
