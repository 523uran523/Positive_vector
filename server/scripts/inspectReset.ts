import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Read-only inventory for the planned reset. Supply an explicit snapshot path.
const [databasePath, ...logins] = process.argv.slice(2);
if (!databasePath || logins.length !== 4 || new Set(logins.map(login => login.toLowerCase())).size !== 4) {
  throw new Error('Укажите путь к копии БД и ровно четыре разных логина.');
}

const db = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
try {
  const users = db.prepare(`SELECT id, login, role, is_active, dismissed_at
    FROM users WHERE login IN (?, ?, ?, ?) COLLATE NOCASE`).all(...logins) as Array<{
      id: string; login: string; role: string; is_active: number; dismissed_at: string | null;
    }>;
  if (users.length !== 4 || users.filter(user => user.role === 'admin').length !== 3 ||
      users.filter(user => user.role === 'employee').length !== 1 ||
      users.some(user => user.is_active !== 1 || user.dismissed_at !== null)) {
    throw new Error('Проверьте выбранные учётки: нужны три действующих администратора и один действующий сотрудник.');
  }
  const preserved = new Set(['users', 'user_permissions', 'settings', 'yandex_connection', 'schema_migrations']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>;
  console.log('Учётные записи для сохранения:', users.map(user => `${user.login} (${user.role})`).join(', '));
  for (const {name} of tables) {
    if (preserved.has(name)) continue;
    const safeName = name.replace(/"/g, '""');
    const count = db.prepare(`SELECT COUNT(*) AS count FROM "${safeName}"`).get() as {count: number};
    console.log(`${name}: ${count.count}`);
  }
  console.log('Проверка выполнена без изменения базы и файлов.');
} finally {
  db.close();
}
