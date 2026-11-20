import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBackup, restoreBackup, verifyBackup } from '../services/backup.ts';
const [mode='create',folder,target]=process.argv.slice(2);
if(mode==='create') {
  const destination=folder || path.resolve(process.env.BACKUP_DIR || './data/backups',`${new Date().toISOString().replaceAll(':','-')}-${crypto.randomUUID().slice(0,8)}`);
  await createBackup(process.env.DB_PATH || './data/pozitiv_vektor.sqlite',process.env.UPLOAD_DIR || './data/uploads',destination);
  verifyBackup(destination);
  console.log('Backup verified:',destination);
} else if(mode==='verify' && folder) {
  verifyBackup(folder);console.log('Backup verified.');
} else if(mode==='restore' && folder && target) {
  restoreBackup(folder,target);console.log('Restored into new directory:',target);
} else throw new Error('Usage: backup.ts create [folder] | verify <folder> | restore <folder> <new-directory>');
