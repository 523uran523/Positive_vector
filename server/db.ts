import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function openDatabase(dbPath?: string): DatabaseSync {
  const raw = dbPath || process.env.DB_PATH || './data/pozitiv_vektor.sqlite';
  const isMemory = raw === ':memory:';
  const resolved = isMemory ? ':memory:' : path.resolve(raw);
  if (!isMemory) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys = ON;');
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function runMigrations(db: DatabaseSync): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.resolve(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedStmt = db.prepare('SELECT version FROM schema_migrations');
  const applied = new Set(
    (appliedStmt.all() as Array<{ version: string }>).map((row) => row.version)
  );

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString()
      );
      db.exec('COMMIT;');
      newlyApplied.push(file);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  seedDefaultSettings(db);
  return newlyApplied;
}

function seedDefaultSettings(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const defaults: Array<[string, unknown]> = [
    ['company_name', 'Позитив Вектор'],
    ['default_shift_rate_kopecks', 300000],
    ['order_tags', ['Баннер', 'Вывеска', 'Декорации', 'Металлоконструкция', 'Срочно', 'Ночной монтаж']],
    [
      'expense_categories',
      [
        { key: 'materials', label: 'Материалы' },
        { key: 'fuel', label: 'Бензин' },
        { key: 'rent', label: 'Аренда' },
        { key: 'salaries', label: 'Зарплаты' },
        { key: 'other', label: 'Другие расходы' },
      ],
    ],
    ['units', ['шт', 'м', 'м²', 'л', 'кг', 'рулон', 'уп']],
    ['material_categories', ['Баннерная ткань', 'Брус и пиломатериалы', 'Краска и химия', 'Крепёж и саморезы', 'Металл и профиль', 'Электрика', 'Прочее']],
    ['default_theme', 'light'],
    ['email_notifications', { enabled: false, smtpHost: '', fromAddress: '' }],
  ];

  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of defaults) {
    stmt.run(k, JSON.stringify(v), now);
  }
}

const transactionDepth = new WeakMap<DatabaseSync, number>();
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = transactionDepth.get(db) || 0;
  const savepoint = `pv_tx_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE;');
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK;');
    } catch {
      // Ignore rollback error if not in tx
    }
    throw err;
  } finally {
    transactionDepth.set(db, depth);
  }
}
