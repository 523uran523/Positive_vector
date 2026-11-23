import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { withTransaction } from '../db.ts';
import { createBackup, verifyBackup } from '../services/backup.ts';

export interface ResetDataOptions {
  dbPath: string;
  uploadDir: string;
  backupDir: string;
  keepLogins: string[];
  confirmReset: boolean;
}

export interface ResetDataResult {
  backupPath: string;
  keptUsers: Array<{ id: string; login: string; role: string }>;
  removedUsers: number;
  removedFiles: number;
}

const PRESERVED_TABLES = new Set([
  'users',
  'user_permissions',
  'settings',
  'yandex_connection',
  'schema_migrations',
]);

// Deletion order respects SQLite foreign key constraints when deleting rows from operational tables.
const CLEAR_ORDER = [
  'visit_work_times',
  'visit_reports',
  'visit_assignees',
  'order_cancel_reviews',
  'order_planned_resources',
  'order_assignees',
  'warehouse_operations',
  'material_batches',
  'client_payments',
  'expenses',
  'salary_accruals',
  'salary_payouts',
  'shift_edit_requests',
  'workshop_shifts',
  'attachments',
  'order_visits',
  'orders',
  'client_contacts',
  'companies',
  'materials',
  'tools',
  'documents',
  'accounting_documents',
  'quick_task_events',
  'quick_task_assignees',
  'quick_tasks',
  'chat_reads',
  'chat_avatars',
  'chat_message_files',
  'chat_messages',
  'chat_files',
  'chat_room_members',
  'push_subscriptions',
  'chat_push_subscriptions',
  'notifications',
  'audit_log',
  'sessions',
  'login_attempts',
  'mutation_receipts',
  'file_deletions',
];

function cleanOperationalUploadFiles(uploadDir: string): number {
  const root = path.resolve(uploadDir);
  if (!fs.existsSync(root)) return 0;
  let removed = 0;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) {
      if (entry.name === '.backup-lock') continue;
      fs.rmSync(full, { force: true });
      removed++;
    } else if (entry.isDirectory() && ['chat', 'documents', 'accounting'].includes(entry.name)) {
      for (const child of fs.readdirSync(full)) {
        fs.rmSync(path.join(full, child), { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

export async function resetOperationalData(options: ResetDataOptions): Promise<ResetDataResult> {
  if (!options.confirmReset) {
    throw new Error('Для выполнения очистки необходимо явно передать --confirm-reset.');
  }
  const dbPath = path.resolve(options.dbPath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Файл базы данных не найден: ${dbPath}`);
  }
  const normalizedLogins = [...new Set(options.keepLogins.map((l) => l.trim()).filter(Boolean))];
  if (normalizedLogins.length === 0) {
    throw new Error('Укажите хотя бы один логин администратора для сохранения.');
  }

  const probe = new DatabaseSync(dbPath, { readOnly: true });
  let keptUsers: Array<{ id: string; login: string; role: string; is_active: number; dismissed_at: string | null }> = [];
  try {
    const placeholders = normalizedLogins.map(() => '?').join(', ');
    keptUsers = probe
      .prepare(
        `SELECT id, login, role, is_active, dismissed_at
         FROM users
         WHERE login IN (${placeholders}) COLLATE NOCASE`
      )
      .all(...normalizedLogins) as typeof keptUsers;
    if (keptUsers.length !== normalizedLogins.length) {
      throw new Error('Не все указанные логины найдены в базе данных.');
    }
    if (keptUsers.some((u) => u.is_active !== 1 || u.dismissed_at !== null)) {
      throw new Error('Все сохраняемые учётные записи должны быть активными и не уволенными.');
    }
    if (!keptUsers.some((u) => u.role === 'admin')) {
      throw new Error('Среди сохраняемых учётных записей должен быть минимум один активный администратор.');
    }
  } finally {
    probe.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.resolve(options.backupDir), `pre-reset-${stamp}`);
  await createBackup(dbPath, path.resolve(options.uploadDir), backupPath);
  verifyBackup(backupPath);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  let removedUsers = 0;
  try {
    const existingTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
    );

    const keptIds = keptUsers.map((u) => u.id);
    const idPlaceholders = keptIds.map(() => '?').join(', ');

    withTransaction(db, () => {
      for (const table of CLEAR_ORDER) {
        if (!existingTables.has(table) || PRESERVED_TABLES.has(table)) continue;
        const safe = table.replace(/"/g, '""');
        db.exec(`DELETE FROM "${safe}"`);
      }

      if (existingTables.has('chat_rooms')) {
        db.exec("DELETE FROM chat_rooms WHERE id != 'general'");
        db.exec("UPDATE chat_rooms SET created_by = NULL WHERE id = 'general' AND created_by IS NOT NULL");
      }

      // Clear any remaining non-preserved tables dynamically if new tables were added later.
      for (const table of existingTables) {
        if (PRESERVED_TABLES.has(table) || CLEAR_ORDER.includes(table) || table === 'chat_rooms') continue;
        const safe = table.replace(/"/g, '""');
        db.exec(`DELETE FROM "${safe}"`);
      }

      if (existingTables.has('yandex_connection')) {
        db.prepare(
          `UPDATE yandex_connection SET connected_by = NULL
           WHERE connected_by IS NOT NULL AND connected_by NOT IN (${idPlaceholders})`
        ).run(...keptIds);
      }

      db.prepare(`DELETE FROM user_permissions WHERE user_id NOT IN (${idPlaceholders})`).run(...keptIds);
      const delUsers = db.prepare(`DELETE FROM users WHERE id NOT IN (${idPlaceholders})`).run(...keptIds);
      removedUsers = Number(delUsers.changes || 0);

      db.prepare('UPDATE users SET chat_history_after = 0').run();
      if (existingTables.has('sqlite_sequence')) {
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('chat_messages', 'chat_messages_legacy')");
      }

      const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
      if (fkErrors.length > 0) {
        throw new Error(`Нарушена ссылочная целостность после очистки: ${JSON.stringify(fkErrors)}`);
      }
    });

    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new Error('Проверка целостности базы данных после очистки не пройдена.');
    }
  } finally {
    db.close();
  }

  const removedFiles = cleanOperationalUploadFiles(options.uploadDir);
  return {
    backupPath,
    keptUsers: keptUsers.map(({ id, login, role }) => ({ id, login, role })),
    removedUsers,
    removedFiles,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const confirmReset = args.includes('--confirm-reset');
  const positional = args.filter((arg) => arg !== '--confirm-reset');
  const [dbPath, uploadDir, backupDir, ...keepLogins] = positional;

  if (!dbPath || !uploadDir || !backupDir || keepLogins.length === 0) {
    console.error(
      'Использование: tsx server/scripts/resetData.ts <dbPath> <uploadDir> <backupDir> --confirm-reset <login1> [login2 ...]'
    );
    process.exit(1);
  }

  resetOperationalData({ dbPath, uploadDir, backupDir, keepLogins, confirmReset })
    .then((res) => {
      console.log('Очистка операционных данных завершена.');
      console.log(`Резервная копия до очистки: ${res.backupPath}`);
      console.log(`Сохранены пользователи: ${res.keptUsers.map((u) => `${u.login} (${u.role})`).join(', ')}`);
      console.log(`Удалено пользователей: ${res.removedUsers}, файлов: ${res.removedFiles}`);
    })
    .catch((err) => {
      console.error('Ошибка очистки:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
