import 'dotenv/config';
import crypto from 'node:crypto';
import { openDatabase, runMigrations, withTransaction } from '../db.ts';
import { ALL_PERMISSIONS, generateRandomPassword, hashPassword, writeAuditLog } from '../security.ts';

const db = openDatabase();
runMigrations(db);

const loginArg = process.argv[2] || 'admin';
const fullNameArg = process.argv[3] || 'Администратор';
const tempPassword = generateRandomPassword(12);
const now = new Date().toISOString();

withTransaction(db, () => {
  const existing = db
    .prepare('SELECT id, login FROM users WHERE login = ? COLLATE NOCASE')
    .get(loginArg) as { id: string; login: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, must_change_password = 1, updated_at = ? WHERE id = ?`
    ).run(hashPassword(tempPassword), now, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    writeAuditLog(db, null, 'user', existing.id, 'cli_admin_password_reset', { login: existing.login });
    console.log('\n=== Сброс пароля администратора ===');
    console.log(`Логин:            ${existing.login}`);
    console.log(`Временный пароль: ${tempPassword}`);
    console.log('Пароль необходимо сменить после входа в настройках.\n');
    return;
  }

  const userId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, login, password_hash, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', ?, '', 'Руководитель', 350000, 1, 1, ?, ?)`
  ).run(userId, loginArg, hashPassword(tempPassword), fullNameArg, now, now);

  const permStmt = db.prepare('INSERT INTO user_permissions (user_id, permission_key, granted) VALUES (?, ?, 1)');
  for (const perm of ALL_PERMISSIONS) {
    permStmt.run(userId, perm);
  }
  writeAuditLog(db, null, 'user', userId, 'cli_admin_created', { login: loginArg });

  console.log('\n=== Создан администратор ===');
  console.log(`Логин:            ${loginArg}`);
  console.log(`Временный пароль: ${tempPassword}`);
  console.log('Сохраните пароль сейчас — повторно он не отображается.\n');
});

db.close();
