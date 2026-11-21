import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../server/db.ts';

test('document migration preserves files, categories and revoked access', () => {
  const db = openDatabase(':memory:');
  try {
    const dir = path.resolve('server/migrations');
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.sql') && name < '017').sort()) {
      db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES('a','admin','hash','admin','Admin','2026','2026')").run();
    db.prepare("INSERT INTO user_permissions(user_id,permission_key,granted) VALUES('a','accounting.access',0)").run();
    db.prepare("INSERT INTO accounting_documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at,category) VALUES('d','file','12345678-1234-4234-8234-123456789abc',1,'a','2026','drawings')").run();
    db.exec(fs.readFileSync(path.join(dir, '017_documents.sql'), 'utf8'));
    assert.equal(db.prepare("SELECT category FROM documents WHERE id='d'").get()?.category, 'drawings');
    assert.equal(db.prepare("SELECT granted FROM user_permissions WHERE user_id='a' AND permission_key='documents.access'").get()?.granted, 0);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounting_documents'").get(), undefined);
  } finally {
    db.close();
  }
});
