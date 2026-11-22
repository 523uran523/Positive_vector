import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

const sha=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function createBackup(dbPath:string,uploadDir:string,destination:string) {
  if(fs.existsSync(destination)) throw new Error('Backup destination already exists');
  fs.mkdirSync(uploadDir,{recursive:true});
  const lock=path.join(uploadDir,'.backup-lock');
  const handle=fs.openSync(lock,'wx',0o600);
  let source:DatabaseSync|undefined;
  try {
    fs.mkdirSync(destination,{recursive:true,mode:0o700});
    source=new DatabaseSync(path.resolve(dbPath),{readOnly:true});
    const database=path.join(destination,'database.sqlite');
    await backup(source,database);
    const snapshot=new DatabaseSync(database,{readOnly:true});
    try {
      if(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') throw new Error('Backup integrity failed');
      const files:Record<string,string>={'database.sqlite':sha(database)};
      fs.mkdirSync(path.join(destination,'uploads'),{mode:0o700});
      for(const row of snapshot.prepare('SELECT DISTINCT stored_name FROM attachments').all()) {
        const name=String(row.stored_name);
        if(path.basename(name)!==name) throw new Error('Unsafe attachment name');
        const target=path.join(destination,'uploads',name);
        fs.copyFileSync(path.join(uploadDir,name),target);
        files[`uploads/${name}`]=sha(target);
      }
      if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_files'").get()) {
        const chatFiles = snapshot.prepare('SELECT DISTINCT stored_name FROM chat_files').all();
        if (chatFiles.length) fs.mkdirSync(path.join(destination, 'uploads', 'chat'), { mode: 0o700 });
        for (const row of chatFiles) {
          const name = String(row.stored_name);
          if (!/^[0-9a-f-]{36}$/.test(name)) throw new Error('Unsafe chat file name');
          const target = path.join(destination, 'uploads', 'chat', name);
          fs.copyFileSync(path.join(uploadDir, 'chat', name), target);
          files[`uploads/chat/${name}`] = sha(target);
        }
      }
      const documentTable = snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get()
        ? 'documents'
        : 'accounting_documents';
      if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(documentTable)) {
        const documents=snapshot.prepare(`SELECT DISTINCT stored_name FROM ${documentTable}`).all();
        if(documents.length) fs.mkdirSync(path.join(destination,'uploads','documents'),{mode:0o700});
        for(const row of documents) {
          const name=String(row.stored_name);
          if(!/^[0-9a-f-]{36}$/.test(name)) throw new Error('Unsafe document file name');
          const primarySource = path.join(uploadDir,'documents',name);
          const legacySource = path.join(uploadDir,'accounting',name);
          const sourceFile = fs.existsSync(primarySource) ? primarySource : legacySource;
          const target=path.join(destination,'uploads','documents',name);
          fs.copyFileSync(sourceFile,target);
          files[`uploads/documents/${name}`]=sha(target);
        }
      }
      fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files},null,2),{mode:0o600});
      fs.chmodSync(database,0o600);
    } finally {snapshot.close();}
  } finally {source?.close();fs.closeSync(handle);fs.unlinkSync(lock);}
}
export function verifyBackup(folder:string) {
  const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8')) as {files:Record<string,string>};
  for(const [name,hash] of Object.entries(manifest.files)) {
    const full=path.resolve(folder,name);
    if(!full.startsWith(path.resolve(folder)+path.sep) || sha(full)!==hash) throw new Error('Backup checksum failed');
  }
  if(!manifest.files['database.sqlite']) throw new Error('Missing database');
  const db=new DatabaseSync(path.join(folder,'database.sqlite'),{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup database check failed');
  } finally {db.close();}
}
export function restoreBackup(folder:string,destination:string) {
  verifyBackup(folder);
  if(fs.existsSync(destination)) throw new Error('Restore destination must be a new directory');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  fs.copyFileSync(path.join(folder,'database.sqlite'),path.join(destination,'pozitiv_vektor.sqlite'));
  fs.cpSync(path.join(folder,'uploads'),path.join(destination,'uploads'),{recursive:true});
}
