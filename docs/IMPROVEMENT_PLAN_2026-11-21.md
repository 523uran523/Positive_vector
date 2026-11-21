# План доработок CRM «Позитив Вектор»

**Дата:** 21.11.2026
**Основание:** 7 замечаний по работе CRM + очистка БД перед запуском.
**Статус:** план одного релиза. Ничего не откладывается «на потом»: схема, данные, UI и инфраструктура доводятся до конечного состояния.
**Рабочие каталоги:** `src/`, `server/`, `public/`, `server/migrations/`, `tests/`. Каталоги `server_backup/`, `dist_backup/` считать архивом и не редактировать.

---

## 0. Краткое резюме

| № | Замечание | Приоритет | Сложность | Ключевые файлы |
|---|---|---|---|---|
| 0 | Чистая БД: оставить 4 учётки (3 админа + 1 монтажник), удалить бизнес-данные и legacy-схему | P0 | средняя | `server/migrations/017_final_cleanup.sql`, `server/scripts/resetData.ts`, `uploads/` |
| 1 | Несколько фото и видео, загрузка после завершения, убрать «вечный ребут» на iPhone | P0 | высокая | `server/routes/orders.ts`, `src/views/OrderModals.tsx`, `src/lib/apiTransport.ts`, `vite.config.ts` |
| 2 | Push-уведомления по задачам и чатам в Chrome и Safari | P1 | средняя | `server/security.ts`, `server/routes/chat.ts`, новый `server/services/push.ts`, `public/chat-push.js` |
| 3 | «Бухгалтерия» → «Документы», разделы «Акты» и «Чертежи», полное переименование внутри | P1 | низкая | `src/views/DocumentsView.tsx`, `src/components/AppShell.tsx`, `server/routes/documents.ts` |
| 4 | Ответ на сообщение, Enter/Shift+Enter, превью фото и видео, видео в чате | P1 | средняя | `src/views/ChatView.tsx`, `server/routes/chat.ts`, миграция БД |
| 5 | Сайт открывается только под VPN, из РФ по Wi-Fi не работает | P0 | инфраструктурная | VPS, Caddy, Tailscale/WireGuard, DNS |
| 6 | Документы больше 12 МБ, без лимита | P0 | средняя | `server/routes/documents.ts`, `server/routes/chat.ts`, `server/routes/orders.ts`, `server/app.ts` |
| 7 | Убрать способы перевода и счета, оставить суммы; долг сотрудника из заказов и смен; сводные таблицы | P2 | средняя | `server/routes/salaries.ts`, `src/views/EmployeesView.tsx`, `src/views/FinanceView.tsx`, `src/views/OrderModals.tsx` |

**Порядок:** подготовка и чистая схема → № 1 + № 6 → № 4 → № 3 → № 2 → № 7 → № 5 (VPN и сервер — последними).

Причина: сначала приводим код и схему к конечному виду на пустых данных, затем наполняем CRM; VPN трогаем в самом конце, когда приложение уже готово. Push реализуется и проверяется локально/по LAN, финальная проверка push на iPhone — после этапа 5.

**Общие правила внедрения**

1. Перед любыми изменениями — согласованный бэкап БД (`VACUUM INTO`) и архива `uploads/`.
2. Бизнес-данные считаются одноразовыми. Сохраняются ровно 4 учётные записи и конфигурация; всё остальное удаляется.
3. Никаких временных алиасов, «старых эндпоинтов на один релиз» и «колонка останется в БД»: старые имена и таблицы удаляются в этом же релизе.
4. Миграции `013`–`017` применяются один раз; `017_final_cleanup.sql` удаляет legacy-схему.
5. Все новые эндпоинты — с `requireAuth`/`requireAdmin` и проверкой доступа к объекту, как в существующих роутерах.
6. Новые файлы загрузок — только через `skipOfflineQueue`/прямой XHR. Большие бинарные файлы нельзя класть в IndexedDB и офлайн-очередь.
7. После изменений: `npm run lint`, `npm test`, `npm run build`, проверка на копии БД.

---

## Подготовка. Чистая БД: 4 учётки и финальная схема

### P.1. Решение

В БД сейчас есть только 4 нужные учётные записи: 3 администратора и 1 монтажник. Заказы, клиенты, чат, склад, финансы, документы, уведомления и аудит — тестовые/одноразовые. Поэтому не переносим их в новую схему, а делаем чистый запуск:

- **Сохраняются:** 4 пользователя, их `password_hash`, роль, права, ставка, `must_change_password`; таблица `settings`; подключение Яндекс.Диска (`yandex_connection`).
- **Удаляются:** все бизнес-строки во всех остальных таблицах, все сессии, все файлы в `uploads/`.
- **Удаляется из схемы:** `chat_push_subscriptions`, `material_legacy_issued`, `users.chat_history_after`, `payment_method` в `salary_payouts`/`client_payments`/`expenses`, таблица `accounting_documents` (переименовывается в `documents`), старое ограничение `attachments.kind` (добавляется `video`).
- **Пароли не меняются.** Скрипт не пересоздаёт пользователей и не трогает `password_hash`, поэтому доступ гарантированно сохраняется. Сессии удаляются — после релиза все входят заново.
- **Записи `yandex_connection`** сохраняются; если `connected_by` указывал на удалённого пользователя, поле обнуляется.

### P.2. Что сохраняется

| Таблица | Что оставляем | Почему |
|---|---|---|
| `users` | ровно 4 строки: 3 `role='admin'`, 1 `role='employee'` | доступ людей |
| `user_permissions` | строки только этих 4 пользователей; `accounting.access` → `documents.access` | права монтажника и доступ к документам |
| `settings` | все строки | название компании, ставки, теги, категории, SMTP |
| `yandex_connection` | строка, если есть | резервное копирование на Диск |
| `schema_migrations` | все строки | история миграций |

Всё остальное — данные, а не конфигурация.

### P.3. Что удаляется

| Группа | Таблицы |
|---|---|
| Заказы и клиенты | `orders`, `order_assignees`, `order_visits`, `visit_assignees`, `visit_reports`, `order_cancel_reviews`, `companies`, `contacts` |
| Вложения | `attachments` (строки), файлы в `uploads/` |
| Склад | `materials`, `tools`, `tool_instances`, `order_planned_resources`, `warehouse_operations`, `material_batches`, `material_batch_allocations` |
| Смены и зарплаты | `workshop_shifts`, `salary_accruals`, `salary_payouts` |
| Финансы | `client_payments`, `expenses` |
| Чат | `chat_messages`, `chat_files`, `chat_avatars`, `chat_reads`, `chat_room_members`, `chat_rooms` (кроме заново созданного `general`) |
| Задачи | `quick_tasks`, `quick_task_assignees`, `quick_task_events` |
| Служебное | `sessions`, `login_attempts`, `notifications`, `audit_log`, `mutation_receipts`, `file_deletions`, `push_subscriptions` |
| Документы | `documents` (строки), файлы `uploads/documents/` |
| Legacy-схема | `chat_push_subscriptions`, `material_legacy_issued`, `users.chat_history_after`, `payment_method` (3 таблицы) |

Скрипт очистки делает это динамически: удаляет все таблицы, кроме белого списка `users`, `user_permissions`, `settings`, `yandex_connection`, `schema_migrations`. Поэтому новая таблица, забытая в списке, всё равно будет очищена.

### P.4. Миграция `server/migrations/017_final_cleanup.sql`

Файл применяется после `013`–`016`. На этом этапе `chat_push_subscriptions` ещё существует, потому что `013` копирует из неё подписки; `017` удаляет её.

```sql
-- 017_final_cleanup.sql
-- Удаление legacy-схемы. Код этого релиза уже не использует старые имена.

-- 1. Документы: accounting_documents → documents.
-- Колонка category добавлена в 014_document_categories.sql.
ALTER TABLE accounting_documents RENAME TO documents;
DROP INDEX IF EXISTS accounting_documents_created;
CREATE INDEX IF NOT EXISTS documents_created ON documents(created_at);
CREATE INDEX IF NOT EXISTS documents_category_created ON documents(category, created_at);

-- 2. Право accounting.access → documents.access.
INSERT OR IGNORE INTO user_permissions(user_id, permission_key, granted)
SELECT user_id, 'documents.access', granted
FROM user_permissions
WHERE permission_key = 'accounting.access';
DELETE FROM user_permissions WHERE permission_key = 'accounting.access';

-- 3. Общий чат: история хранится в chat_room_members, как у остальных комнат.
INSERT OR IGNORE INTO chat_room_members(room_id, user_id, history_after)
SELECT 'general', id, chat_history_after FROM users;
ALTER TABLE users DROP COLUMN chat_history_after;

-- 4. Вложения: разрешаем kind='video'.
-- Пересборка таблицы, потому что CHECK нельзя изменить через ALTER.
CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'visit', 'report', 'tool')),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video', 'document')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO attachments_new
  (id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at)
SELECT
  id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at
FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- 5. Способы перевода и счета больше не хранятся.
ALTER TABLE salary_payouts DROP COLUMN payment_method;
ALTER TABLE client_payments DROP COLUMN payment_method;
ALTER TABLE expenses DROP COLUMN payment_method;

-- 6. Legacy-таблицы, которые больше не нужны.
DROP TABLE IF EXISTS chat_push_subscriptions;
DROP TABLE IF EXISTS material_legacy_issued;
```

Проверка после применения:

```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name IN ('accounting_documents', 'chat_push_subscriptions', 'material_legacy_issued');
-- пусто

SELECT name FROM pragma_table_info('users') WHERE name='chat_history_after';
-- пусто

SELECT name FROM pragma_table_info('salary_payouts') WHERE name='payment_method';
-- пусто
```

### P.5. Скрипт `server/scripts/resetData.ts`

Скрипт не пересоздаёт пользователей: он удаляет всех, кроме белого списка, поэтому `password_hash` и доступ остаются нетронутыми. Сначала `--list`, потом dry-run, потом `--yes`.

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db.ts';

type UserRow = {
  id: string;
  login: string;
  role: 'admin' | 'employee';
  full_name: string;
  is_active: number;
  dismissed_at: string | null;
};

const args = new Set(process.argv.slice(2));
const listOnly = args.has('--list');
const confirmed = args.has('--yes');
const purgeUploads = args.has('--purge-uploads');

const dbPath = path.resolve(process.env.DB_PATH || './data/positive_vector.db');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const db = openDatabase(dbPath);

const allUsers = db
  .prepare(
    `SELECT id, login, role, full_name, is_active, dismissed_at
     FROM users ORDER BY role, login`
  )
  .all() as UserRow[];

if (listOnly) {
  console.log(`БД: ${dbPath}`);
  for (const user of allUsers) {
    console.log(
      `${user.login}\t${user.role}\t${user.full_name}\t${user.is_active ? 'active' : 'inactive'}`
    );
  }
  db.close();
  process.exit(0);
}

const keepLogins = (process.env.KEEP_LOGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (keepLogins.length !== 4) {
  throw new Error('KEEP_LOGINS должен содержать ровно 4 логина через запятую.');
}
if (new Set(keepLogins.map((login) => login.toLowerCase())).size !== 4) {
  throw new Error('В KEEP_LOGINS есть повторяющиеся логины.');
}

const placeholders = keepLogins.map(() => '?').join(',');
const keep = db
  .prepare(
    `SELECT id, login, role, full_name, is_active, dismissed_at
     FROM users WHERE login IN (${placeholders})`
  )
  .all(...keepLogins) as UserRow[];

if (keep.length !== 4) {
  const found = new Set(keep.map((user) => user.login.toLowerCase()));
  const missing = keepLogins.filter((login) => !found.has(login.toLowerCase()));
  throw new Error(
    `Не найдены учётки: ${missing.join(', ')}. Есть: ${allUsers.map((user) => user.login).join(', ')}`
  );
}

const admins = keep.filter((user) => user.role === 'admin');
const employees = keep.filter((user) => user.role === 'employee');
if (admins.length !== 3 || employees.length !== 1) {
  throw new Error(
    `Ожидалось 3 админа и 1 монтажник, найдено ${admins.length} и ${employees.length}.`
  );
}

const keepIds = keep.map((user) => user.id);
const idPlaceholders = keepIds.map(() => '?').join(',');

const keepTables = new Set([
  'users',
  'user_permissions',
  'settings',
  'yandex_connection',
  'schema_migrations',
]);
const tables = (
  db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>
).map((row) => row.name);
const clearTables = tables.filter((name) => !keepTables.has(name));

const count = (table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);

console.log(`БД: ${dbPath}`);
console.log('Сохраняем:', keep.map((user) => `${user.login} (${user.role})`).join(', '));
console.log('Таблиц к очистке:', clearTables.length);

if (!confirmed) {
  for (const table of clearTables) {
    const rows = count(table);
    if (rows > 0) console.log(`  ${table}: ${rows}`);
  }
  console.log('DRY RUN. Для выполнения добавьте --yes.');
  db.close();
  process.exit(0);
}

// 1. Согласованный бэкап до любых изменений.
const backupDir = path.resolve('backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `pre-reset-${stamp}.db`);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log('Бэкап БД:', backupPath);

// 2. Очистка. FK выключаем, чтобы не зависеть от порядка таблиц.
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN IMMEDIATE;');
try {
  for (const table of clearTables) {
    db.exec(`DELETE FROM "${table}";`);
  }
  db.prepare(`DELETE FROM users WHERE id NOT IN (${idPlaceholders})`).run(...keepIds);
  db.prepare(`DELETE FROM user_permissions WHERE user_id NOT IN (${idPlaceholders})`).run(...keepIds);
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('chat_messages', 'material_batches');");

  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO chat_rooms(id, name, created_at, archived_at) VALUES ('general', 'Общий чат', ?, NULL)"
  ).run(now);
  const addMember = db.prepare(
    "INSERT OR IGNORE INTO chat_room_members(room_id, user_id, history_after) VALUES ('general', ?, 0)"
  );
  for (const id of keepIds) addMember.run(id);

  if (tables.includes('yandex_connection')) {
    db.prepare(
      `UPDATE yandex_connection
       SET connected_by = NULL
       WHERE connected_by IS NOT NULL AND connected_by NOT IN (${idPlaceholders})`
    ).run(...keepIds);
  }

  db.exec('COMMIT;');
} catch (error) {
  db.exec('ROLLBACK;');
  throw error;
} finally {
  db.exec('PRAGMA foreign_keys = ON;');
}

// 3. Файлы. Удаляем только после успешной очистки БД.
if (purgeUploads) {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Каталог uploads очищен:', uploadDir);
}

// 4. Сжатие и проверка.
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.exec('VACUUM;');
const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
if (integrity.integrity_check !== 'ok') throw new Error('integrity_check не прошёл.');
const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
if (fkErrors.length) throw new Error(`foreign_key_check: ${fkErrors.length} ошибок.`);

console.log('Готово.');
console.log('Пользователей:', count('users'));
console.log(
  'Админов:',
  (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get() as { n: number }).n
);
console.log(
  'Монтажников:',
  (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='employee'").get() as { n: number }).n
);
db.close();
```

`package.json`:

```json
{
  "scripts": {
    "reset:data": "tsx server/scripts/resetData.ts"
  }
}
```

### P.6. Порядок выполнения на сервере

Сервер: `likve@100.75.40.93`, проект `C:\PositiveVector`. CRM должна быть остановлена: скрипт делает `VACUUM` и удаляет файлы.

**Шаг 1. Заморозить работу и остановить CRM**

Предупредить сотрудников, что после релиза нужно войти заново. Остановить процесс тем же способом, которым он запущен (служба, планировщик или консоль). Проверить, что порт 4173 не отвечает:

```powershell
curl.exe -I http://localhost:4173/api/health --max-time 3
```

**Шаг 2. Бэкап БД и файлов**

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force C:\PositiveVector\backups | Out-Null
Copy-Item C:\PositiveVector\data\positive_vector.db* "C:\PositiveVector\backups\db-$stamp" -Force
Compress-Archive -Path C:\PositiveVector\uploads -DestinationPath "C:\PositiveVector\backups\uploads-$stamp.zip" -Force
```

`positive_vector.db*` копирует `.db`, `.db-wal` и `.db-shm`, если они есть. Это важно для WAL-режима.

**Шаг 3. Выложить новый код и применить миграции**

```powershell
ssh likve@100.75.40.93 "git -C C:\PositiveVector pull --ff-only"
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector ci"
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector run build"
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector run migrate"
```

`npm run migrate` применит `013`–`017`. Если миграция упадёт, БД останется на предыдущей версии: каждая миграция выполняется в транзакции.

**Шаг 4. Посмотреть реальные логины**

```powershell
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector run reset:data -- --list"
```

Ожидается 4 строки. Записать логины трёх админов и одного монтажника.

**Шаг 5. Прописать белый список**

В `C:\PositiveVector\.env` добавить строку (логины — из шага 4):

```dotenv
KEEP_LOGINS=director,admin2,admin3,master
```

**Шаг 6. Dry-run**

```powershell
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector run reset:data"
```

Скрипт напечатает, кого сохраняет, сколько таблиц очистит и сколько строк в каждой. Ничего не меняет. Если список или роли неверные — остановиться и исправить `KEEP_LOGINS`.

**Шаг 7. Выполнить очистку**

```powershell
ssh likve@100.75.40.93 "npm --prefix C:\PositiveVector run reset:data -- --yes --purge-uploads"
```

Скрипт:

1. делает `backups\pre-reset-<timestamp>.db` через `VACUUM INTO`;
2. удаляет все таблицы, кроме белого списка;
3. удаляет всех пользователей, кроме четырёх;
4. пересоздаёт `general` и добавляет в него четырёх;
5. очищает `uploads/`;
6. делает `VACUUM`, `integrity_check`, `foreign_key_check`.

**Шаг 8. Убрать `KEEP_LOGINS` из `.env`**

Строка нужна только на время очистки. После успешного выполнения удалить её, чтобы случайный повторный запуск не прошёл валидацию.

**Шаг 9. Запустить CRM и проверить**

```powershell
curl.exe -I http://localhost:4173/api/health --max-time 10
```

Затем открыть сайт и войти:

- `director` / `Admin123456!` — обязательно;
- три остальные учётки — их паролями (пароли не менялись).

Старые сессии удалены, поэтому все устройства попросят вход.

**Шаг 10. Обновить PWA у сотрудников**

После релиза приложение покажет баннер «Доступно обновление». Нажать «Обновить». Если у кого-то открыта старая вкладка, она может получить 404 на `/api/accounting` — это ожидаемо, нужно закрыть и открыть приложение. Старые эндпоинты намеренно не поддерживаются.

### P.7. Приёмка по очистке БД

- [ ] `npm run reset:data -- --list` показывает ровно 4 учётки.
- [ ] Dry-run не изменил БД и показал сохраняемых пользователей.
- [ ] После `--yes` в `users` 4 строки: 3 `admin`, 1 `employee`.
- [ ] `director` входит с прежним паролем; остальные три — со своими.
- [ ] В `users` нет `chat_history_after`; в трёх финансовых таблицах нет `payment_method`.
- [ ] Нет таблиц `accounting_documents`, `chat_push_subscriptions`, `material_legacy_issued`.
- [ ] `documents` существует, `category` заполнена `acts` по умолчанию.
- [ ] В `chat_rooms` только `general`, в `chat_room_members` четыре участника.
- [ ] Все бизнес-таблицы пусты, кроме `settings` и `yandex_connection`.
- [ ] `uploads/` пуст, файлы удалены.
- [ ] `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check` пуст.
- [ ] Бэкап `backups\pre-reset-*.db` создан и открывается.
- [ ] После входа создаётся новый заказ, загружается фото, отправляется сообщение в чат.

---

## 1. Замечание 1 — несколько фото и видео в заказе, загрузка после завершения

### 1.1. Что происходит сейчас

- В `src/views/OrderModals.tsx` загрузка вызывается из `handleFileUpload` (около строк 1370–1402). Берётся только первый файл: `e.target.files?.[0]`.
- Input в блоке «Файлы» (строки 2860–2879) имеет `accept="image/*"` и не имеет `multiple`. В форме выезда (строки 2389–2398) — то же самое.
- Запрос идёт через `apiRequest` без `skipOfflineQueue`, поэтому файл попадает в офлайн-очередь IndexedDB (`src/lib/apiTransport.ts`, `queueable()` и ветка `mutation`). На iPhone Safari большие `File` в IndexedDB и последующая синхронизация могут зависать, повторяться и создавать ощущение «вечного ребута».
- Серверный лимит 12 МБ и белый список MIME без видео: `server/routes/orders.ts:15–24`, `:43`.
- В выдаче вложения (`GET /api/orders/attachments/:id`) используется `fs.createReadStream(...).pipe(res)` без поддержки `Range`. Для видео это плохо: Safari не может перематывать и иногда не начинает воспроизведение.
- После завершения заказа кнопка загрузки в блоке «Файлы» остаётся, но из-за одиночного input и офлайн-очереди пользователь видит только одно добавленное фото.

### 1.2. Целевое поведение

1. Можно выбрать несколько фото и видео сразу (`multiple`), либо добавлять по одному сколько угодно раз.
2. Загрузка идёт последовательно, с прогрессом по каждому файлу; ошибка одного файла не блокирует остальные.
3. Максимум 3 попытки на файл. Если все три неудачны — файл не уходит в офлайн-очередь, а показывается кнопка «Повторить». Повторная попытка — снова прямой upload.
4. Файлы любого разумного размера (см. раздел 2) и видео MP4/MOV/WebM.
5. После завершения заказа и после завершения монтажа в блоке «Файлы» можно добавлять фото и видео к заказу и к выезду.
6. Видео воспроизводится в карточке, фото открывается в просмотрщике; для видео работает перемотка.
7. На iPhone нет бесконечной синхронизации: бинарные файлы не попадают в `pv_offline_db`.

### 1.3. Сервер: `server/routes/orders.ts`

#### 1.3.1. Расширить MIME и убрать 12 МБ

```ts
// server/routes/orders.ts, вместо ALLOWED_MIME (строки 15–24)
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
]);

function uploadSizeLimit(): { fileSize?: number } {
  // 0 или пусто = без прикладного лимита. Лимит диска контролируется на прокси/сервере.
  const bytes = Number(process.env.MAX_UPLOAD_BYTES || 0);
  return Number.isFinite(bytes) && bytes > 0 ? { fileSize: bytes } : {};
}
```

```ts
// server/routes/orders.ts, createMulterUpload()
return multer({
  storage,
  limits: { files: 1, ...uploadSizeLimit() },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Недопустимый формат файла: ${file.mimetype}`));
  },
});
```

`files: 1` оставляем: UI загружает файлы по одному, но список файлов — любой длины. Это надёжнее для iPhone, чем один multipart с десятком видео.

#### 1.3.2. Видео в выдаче и поддержка Range

Заменить в `GET /api/orders/attachments/:attachmentId` (около строк 1235–1237):

```ts
res.setHeader('Content-Type', att.mime_type);
res.setHeader(
  'Content-Disposition',
  `inline; filename*=UTF-8''${encodeURIComponent(att.original_name)}`
);
res.setHeader('Accept-Ranges', 'bytes');
res.sendFile(fullPath); // Express sendFile сам отдаёт Range для видео
```

`res.sendFile` требует абсолютный путь — `fullPath` уже абсолютный.

#### 1.3.3. `kind` для видео

Схема `attachments.kind` допускает только `photo` и `document` (`server/migrations/001_init.sql:167`). Не меняем схему: видео храним с `kind='photo'`, а тип определяем по `mime_type`. В ответе и UI ориентироваться на `mime_type.startsWith('video/')`.

В обработчике загрузки (строки 1134–1187) можно явно вернуть признак:

```ts
const kind = req.body.kind === 'document' ? 'document' : 'photo';
// ...
res.status(201).json({
  attachment: {
    id: attachmentId,
    kind,
    original_name: req.file.originalname,
    mime_type: req.file.mimetype,
    size_bytes: req.file.size,
    created_at: now,
  },
});
```

#### 1.3.4. Таймауты для больших файлов

В `server.ts` после `app.listen(...)`:

```ts
// Большие видео на медленном мобильном интернете не должны обрываться таймаутом Node.
server.requestTimeout = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 0);
server.headersTimeout = 60_000;
server.timeout = 0;
```

Если на сервере стоит reverse proxy, его таймауты и `client_max_body_size`/`request_body` тоже должны быть без лимита (см. раздел 7).

### 1.4. Клиент: прямой upload с тремя попытками

#### 1.4.1. Новый файл `src/lib/upload.ts`

```ts
import { getCsrfToken } from './apiTransport';

export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

type UploadOptions = {
  attempts?: number;
  timeoutMs?: number;
  onProgress?: (percent: number) => void;
};

export async function uploadWithRetry<T>(
  url: string,
  file: File,
  fields: Record<string, string>,
  options: UploadOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await uploadOnce<T>(url, file, fields, options);
    } catch (error) {
      lastError = error;
      const status = error instanceof UploadError ? error.status : 0;
      const retryable = !status || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      options.onProgress?.(0);
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new UploadError('Не удалось загрузить файл.');
}

function uploadOnce<T>(
  url: string,
  file: File,
  fields: Record<string, string>,
  options: UploadOptions
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.timeout = options.timeoutMs ?? 10 * 60_000;

    const token = getCsrfToken();
    if (token) xhr.setRequestHeader('X-CSRF-Token', token);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ответ может быть пустым
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new UploadError(data?.error || `Ошибка загрузки (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new UploadError('Сеть недоступна. Файл не загружен.'));
    xhr.ontimeout = () => reject(new UploadError('Сервер не принял файл вовремя.'));
    xhr.onabort = () => reject(new UploadError('Загрузка отменена.'));

    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    xhr.send(form);
  });
}
```

В `src/lib/apiTransport.ts` добавить экспорт:

```ts
export function getCsrfToken(): string | null {
  return csrf;
}
```

#### 1.4.2. Изменения в `src/views/OrderModals.tsx`

Добавить состояния рядом с другими состояниями модалки:

```tsx
type UploadItem = { name: string; progress: number; error?: string };
type FailedUpload = { file: File; kind: 'photo' | 'document'; visitId?: string; error: string };

const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
```

Заменить `handleFileUpload` на загрузку массива:

```tsx
const uploadFiles = async (
  files: File[],
  kind: 'photo' | 'document',
  visitId?: string
) => {
  if (!files.length) return;
  setBusy(true);
  setError('');
  setOfflineNotice('');
  setUploadItems(files.map((file) => ({ name: file.name, progress: 0 })));

  let uploaded = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    try {
      await uploadWithRetry(
        `/api/orders/${order.id}/attachments`,
        file,
        { kind, ...(visitId ? { visitId } : {}) },
        {
          attempts: 3,
          onProgress: (progress) =>
            setUploadItems((items) =>
              items.map((item, i) => (i === index ? { ...item, progress } : item))
            ),
        }
      );
      uploaded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка загрузки';
      setUploadItems((items) =>
        items.map((item, i) => (i === index ? { ...item, error: message } : item))
      );
      setFailedUploads((prev) => [...prev, { file, kind, visitId, error: message }]);
    }
  }

  setBusy(false);
  if (uploaded > 0) await reloadOrder();
};

const handleFilesUpload = (
  e: React.ChangeEvent<HTMLInputElement>,
  kind: 'photo' | 'document',
  visitId?: string
) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // позволяет выбрать тот же файл повторно
  void uploadFiles(files, kind, visitId);
};
```

Добавить импорт:

```tsx
import { uploadWithRetry } from '../lib/upload';
```

Input в блоке «Файлы» (строки 2860–2879):

```tsx
<label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]">
  <ImageIcon className="h-4 w-4" />
  <span>Добавить фото или видео</span>
  <input
    type="file"
    multiple
    accept="image/*,video/*"
    className="hidden"
    onChange={(e) => handleFilesUpload(e, 'photo')}
  />
</label>
<label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-black/[0.1] px-4 py-2.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]">
  <FileText className="h-4 w-4" />
  <span>Прикрепить документ</span>
  <input
    type="file"
    multiple
    accept=".pdf,.doc,.docx,.xls,.xlsx,.txt"
    className="hidden"
    onChange={(e) => handleFilesUpload(e, 'document')}
  />
</label>
```

Input в форме выезда (строки 2389–2398):

```tsx
<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-black/[0.1] px-3 py-1.5 text-xs font-medium hover:bg-black/[0.03] dark:border-white/[0.1]">
  <Upload className="h-3.5 w-3.5" />
  <span>Фото и видео к выезду</span>
  <input
    type="file"
    multiple
    accept="image/*,video/*"
    className="hidden"
    onChange={(e) => handleFilesUpload(e, 'photo', v.id)}
  />
</label>
```

Очередь загрузки и кнопка повтора — сразу под кнопками:

```tsx
{uploadItems.length > 0 && (
  <div className="space-y-1.5 rounded-xl border border-black/[0.06] p-3 text-xs dark:border-white/[0.08]">
    {uploadItems.map((item, index) => (
      <div key={`${item.name}-${index}`} className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">{item.name}</span>
          <span className={item.error ? 'text-red-600' : 'text-zinc-500'}>
            {item.error ? 'Ошибка' : item.progress >= 100 ? 'Готово' : `${item.progress}%`}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded bg-black/[0.08] dark:bg-white/[0.1]">
          <div
            className={`h-full transition-all ${item.error ? 'bg-red-500' : 'bg-[#0071E3]'}`}
            style={{ width: `${item.progress}%` }}
          />
        </div>
        {item.error && <div className="text-red-600">{item.error}</div>}
      </div>
    ))}
  </div>
)}

{failedUploads.length > 0 && (
  <button
    type="button"
    disabled={busy}
    onClick={() => {
      const pending = failedUploads;
      setFailedUploads([]);
      void uploadFiles(pending.map((item) => item.file), pending[0]?.kind || 'photo', pending[0]?.visitId);
    }}
    className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-800 dark:text-amber-300"
  >
    Повторить неудачные ({failedUploads.length})
  </button>
)}
```

Важно: `uploadWithRetry` не вызывает `apiRequest`, поэтому файл не попадает в `pv_offline_db`. Это и есть главное исправление «вечного ребута» на iPhone.

#### 1.4.3. Превью видео в списке вложений

В `order.attachments.map` (строки 2888–2925) заменить условие:

```tsx
{att.mime_type.startsWith('image/') ? (
  <img
    src={`/api/orders/attachments/${att.id}`}
    alt={att.original_name}
    referrerPolicy="no-referrer"
    className="h-32 w-full object-cover"
  />
) : att.mime_type.startsWith('video/') ? (
  <video
    src={`/api/orders/attachments/${att.id}`}
    controls
    preload="metadata"
    playsInline
    className="h-32 w-full bg-black object-contain"
  />
) : (
  <div className="flex h-32 items-center justify-center text-zinc-400">
    <FileText className="h-10 w-10" />
  </div>
)}
```

Для фото лучше добавить простой просмотрщик: клик по `<img>` открывает модалку с `<img className="max-h-[80vh]">`. Для видео `controls` уже даёт просмотр и перемотку.

#### 1.4.4. Загрузка после завершения заказа и монтажа

Серверный `POST /api/orders/:orderId/attachments` не проверяет статус заказа — он проверяет только доступ (`isUserAssignedToOrder`/`orders.view_all`). Поэтому после завершения заказа загрузка уже разрешена. Нужно только:

1. Не скрывать блок «Файлы» при `status === 'completed'`.
2. Не скрывать кнопку загрузки при завершённом выезде: она находится в форме отчёта, а форма может сворачиваться. Добавить такую же кнопку в блоке «Файлы» с выбором выезда:

```tsx
<select
  value={uploadVisitId}
  onChange={(e) => setUploadVisitId(e.target.value)}
  className="rounded-xl border border-black/[0.1] px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
>
  <option value="">К заказу (без выезда)</option>
  {order.visits.map((visit) => (
    <option key={visit.id} value={visit.id}>
      {visit.title}
    </option>
  ))}
</select>
```

И передавать `uploadVisitId || undefined` в `handleFilesUpload`. Это позволяет прикреплять итоги монтажа к конкретному выезду даже после его завершения.

#### 1.4.5. iPhone/Safari: почему был «ребут» и что ещё поменять

Причины:

- `apiRequest` для multipart сохраняет `File` в IndexedDB до отправки. На iOS Safari крупные `File` в IndexedDB могут теряться/зависать, а `syncOfflineQueue` при первой ошибке делает `break` и повторяет очередь снова и снова.
- `vite-plugin-pwa` в режиме `autoUpdate` может перезагрузить страницу в момент обновления service worker, в том числе во время загрузки.
- Safari приостанавливает вкладку/загрузку при блокировке экрана.

Меры:

1. Битые/большие файлы — только прямой XHR, без очереди (уже описано).
2. Перевести PWA в режим `prompt` и показывать баннер «Доступно обновление»:
   ```ts
   // vite.config.ts
   VitePWA({
     registerType: 'prompt',
     // ...
   })
   ```
   ```ts
   // src/main.tsx
   const updateSW = registerSW({
     immediate: true,
     onNeedRefresh() {
       window.dispatchEvent(new Event('pv:update-available'));
     },
   });
   window.addEventListener('pv:update-accepted', () => void updateSW(true));
   ```
   Баннер в `AppShell` не должен перезагружать страницу, пока идёт загрузка. Достаточно кнопки «Обновить позже».
3. Пока идёт загрузка, по возможности использовать Screen Wake Lock:
   ```ts
   let wakeLock: WakeLockSentinel | null = null;
   async function keepScreenAwake() {
     try {
       wakeLock = await navigator.wakeLock?.request('screen') ?? null;
     } catch {
       // Safari может не поддержать — не критично
     }
   }
   async function releaseScreen() {
     await wakeLock?.release();
     wakeLock = null;
   }
   ```
   Вызывать до `uploadFiles` и в `finally` — `releaseScreen()`.
4. Прямой upload — финальная схема этого релиза, без chunked/resumable. Для видео до ~1 ГБ одного `multipart/form-data` достаточно, если у сервера отключён таймаут (`server.requestTimeout = 0`). При обрыве файл отправляется заново, максимум 3 попытки; это предсказуемее, чем хранить полусобранные чанки на iPhone. Chunked не внедряем и не оставляем «на потом».

### 1.5. Приёмка по замечанию 1

- [ ] С iPhone Safari/PWA выбрать 10 фото и 2 видео сразу; все файлы загрузились.
- [ ] Добавить видео 100–300 МБ; нет ошибки 12 МБ, есть прогресс.
- [ ] Ошибиться сетью на одном файле: остальные загрузились, у failed есть «Повторить».
- [ ] Закрыть и снова открыть заказ: новые файлы на месте.
- [ ] Завершить заказ и выезд, затем добавить фото к заказу и к выезду.
- [ ] Видео воспроизводится, перематывается; на iPhone не открывается пустой чёрный экран.
- [ ] В IndexedDB (`pv_offline_db`) нет записей с `File` для этих загрузок.
- [ ] Во время загрузки не происходит внезапного reload из-за service worker.

---

## 2. Замечание 6 — документы больше 12 МБ, без лимита

### 2.1. Где сейчас лимит

- `server/routes/orders.ts:43` — `fileSize: 12 * 1024 * 1024`.
- `server/routes/chat.ts:13` — `memoryStorage`, `fileSize: 12 * 1024 * 1024`.
- `server/routes/accounting.ts` в текущем коде: `memoryStorage`, `fileSize: 12 * 1024 * 1024`. После переименования этот файл станет `server/routes/documents.ts`, там лимит и `memoryStorage` тоже убираются.
- `server/app.ts:113–117` — текст ошибки «превышает лимит 12 МБ».
- `express.json({ limit: '2mb' })` в `server/app.ts:66` к multipart не относится, менять не нужно.

### 2.2. Единая политика

1. Прикладной лимит 12 МБ убрать везде.
2. Вместо него — необязательный `MAX_UPLOAD_BYTES` (0 = без лимита). Это страховка от случайной загрузки терабайта, а не бизнес-ограничение.
3. `memoryStorage` для файлов заменить на `diskStorage`. Держать в памяти 500 МБ видео нельзя.
4. На reverse proxy отключить ограничение тела запроса.
5. Проверять свободное место перед записью; при нехватке — `507 Insufficient Storage` и понятный текст.

### 2.3. `server/routes/documents.ts`: diskStorage + категории

В старом `server/routes/accounting.ts` файл принимается в память и потом пишется через `fs.writeFileSync` (строки 31–43). В новом `server/routes/documents.ts` нужно сразу использовать `diskStorage`:

```ts
// documents.ts, после функции folder()
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, folder());
      } catch (error) {
        cb(error as Error, '');
      }
    },
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { files: 1, ...(Number(process.env.MAX_UPLOAD_BYTES || 0) > 0
    ? { fileSize: Number(process.env.MAX_UPLOAD_BYTES) }
    : {}) },
});
```

В `POST /`:

```ts
router.post('/', upload.single('file'), (req: AuthedRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Выберите файл.' });
    return;
  }

  const id = crypto.randomUUID();
  const stored = req.file.filename; // уже лежит в folder()
  const name = safeName(req.file.originalname);
  const now = new Date().toISOString();

  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO accounting_documents
           (id, original_name, stored_name, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, name, stored, req.file!.size, req.authUser!.id, now);
      writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_uploaded', {});
    });
  } catch (error) {
    fs.rmSync(req.file.path, { force: true });
    throw error;
  }

  res.status(201).json({
    document: { id, original_name: name, size_bytes: req.file.size, created_at: now },
  });
});
```

Если запись в БД не удалась, файл удаляется по `req.file.path`. Если ответ ушёл с ошибкой после multer, нужен общий cleanup — см. обработчик ошибок в `server/app.ts`; для accounting можно добавить `res.once('finish', ...)`, как в orders.

### 2.4. `server/routes/chat.ts`: diskStorage

Чат сейчас использует `memoryStorage` (строка 13) и `req.file.buffer`. Для видео это неприемлемо. Нужны два загрузчика:

```ts
const tempDir = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'chat-tmp');
fs.mkdirSync(tempDir, { recursive: true });

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tempDir),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { files: 1, ...(Number(process.env.MAX_UPLOAD_BYTES || 0) > 0
    ? { fileSize: Number(process.env.MAX_UPLOAD_BYTES) }
    : {}) },
});

// Аватар остаётся в памяти: 5 МБ, нужна проверка сигнатуры.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
```

В маршрутах: `router.post('/messages', chatUpload.single('file'), ...)`, `router.post('/avatar', avatarUpload.single('file'), ...)`.

Проверка сигнатуры видео:

```ts
function videoValid(type: string, b: Buffer): boolean {
  if (type === 'video/webm') {
    return b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (['video/mp4', 'video/quicktime', 'video/x-m4v'].includes(type)) {
    return b.subarray(4, 8).toString() === 'ftyp';
  }
  return false;
}

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(16);
  fs.readSync(fd, buffer, 0, 16, 0);
  fs.closeSync(fd);
  return buffer;
}
```

В `POST /messages`:

```ts
router.post('/messages', chatUpload.single('file'), async (req: AuthedRequest, res) => {
  // ...
  const cleanup = () => {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
  };
  res.once('finish', () => {
    if (res.statusCode >= 400) cleanup();
  });

  if (req.file) {
    const type = baseType(req.file.mimetype);
    const head = readHead(req.file.path);
    if (
      !allowed.has(type) ||
      (type.startsWith('image/') && !imageValid(type, head)) ||
      (type.startsWith('video/') && !videoValid(type, head))
    ) {
      res.status(400).json({ error: 'Формат файла не поддерживается.' });
      return;
    }
  }

  // ...
  let fileId: string | null = null;
  let stored = '';
  if (req.file) {
    fileId = crypto.randomUUID();
    stored = crypto.randomUUID();
    fs.renameSync(req.file.path, path.join(folder(), stored));
  }
  // ...
});
```

Дубликат по `clientMessageId` сравнивать не буфером, а потоковым хешем:

```ts
async function fileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
```

В выдаче файла (`GET /files/:id`) добавить видео в inline:

```ts
const inline =
  file.mime_type.startsWith('image/') ||
  file.mime_type.startsWith('audio/') ||
  file.mime_type.startsWith('video/');
res.setHeader('Content-Type', inline ? file.mime_type : 'application/octet-stream');
res.setHeader(
  'Content-Disposition',
  `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`
);
res.sendFile(path.join(folder(), file.stored_name));
```

### 2.5. `server/app.ts`: текст ошибки

```ts
if (err instanceof multer.MulterError) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const limitMb = Math.round(Number(process.env.MAX_UPLOAD_BYTES || 0) / 1024 / 1024);
    res.status(400).json({
      error: limitMb > 0
        ? `Размер файла превышает лимит ${limitMb} МБ.`
        : 'Размер файла превышает допустимый лимит.',
    });
    return;
  }
  // ...
}
```

### 2.6. Приёмка по замечанию 6

- [ ] PDF/DOCX на 30, 100, 300 МБ загружается в «Документы».
- [ ] Видео 100+ МБ загружается в чат и в заказ.
- [ ] Скачанный файл совпадает по SHA-256 с исходным.
- [ ] При нехватке места сервер отвечает 507 и не оставляет битый файл.
- [ ] `MAX_UPLOAD_BYTES` можно задать в `.env`, не меняя код.

## 3. Замечание 4 — ответ на сообщение, Enter/Shift+Enter, превью фото и видео

### 3.1. Что происходит сейчас

- `src/views/ChatView.tsx:6` — тип `Message` не содержит ссылку на сообщение-родитель.
- `ChatView.tsx:116–132` — отправка только по `form onSubmit`; Enter в textarea вставляет перенос строки.
- `ChatView.tsx:164–171` — для фото и видео выводится только ссылка `<a>`; аудио — `<audio>`. Видео в чат загрузить нельзя: в `server/routes/chat.ts:12` нет видео MIME, в input нет `accept`.
- `server/routes/chat.ts:125–167` — в `chat_messages` нет `reply_to_id`.
- `server/routes/chat.ts:13` — `memoryStorage` и 12 МБ, см. раздел 2.

### 3.2. Миграция `server/migrations/015_chat_reply.sql`

```sql
ALTER TABLE chat_messages ADD COLUMN reply_to_id TEXT
  REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_reply
  ON chat_messages(reply_to_id);
```

SQLite допускает `ADD COLUMN` с `REFERENCES` и `DEFAULT NULL`. Старые сообщения получают `NULL`.

### 3.3. Сервер: `server/routes/chat.ts`

#### 3.3.1. Видео в белом списке

```ts
const allowed = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
]);
```

Проверку сигнатуры видео и diskStorage взять из раздела 2.4.

#### 3.3.2. Приём `replyToId`

В `POST /messages` до вставки:

```ts
const replyToId = req.body.replyToId ? String(req.body.replyToId) : null;

if (replyToId) {
  if (!/^[0-9a-f-]{36}$/i.test(replyToId)) {
    res.status(400).json({ error: 'Некорректное сообщение для ответа.' });
    return;
  }
  const parent = db
    .prepare('SELECT id, room_id, deleted_at FROM chat_messages WHERE id = ?')
    .get(replyToId) as { id: string; room_id: string; deleted_at: string | null } | undefined;
  if (!parent || parent.room_id !== roomId || parent.deleted_at) {
    res.status(400).json({ error: 'Сообщение для ответа не найдено в этом чате.' });
    return;
  }
}
```

Вставка:

```ts
db.prepare(
  `INSERT INTO chat_messages
     (id, author_id, body, file_id, reply_to_id, created_at, room_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(id, user.id, body, fileId, replyToId, now, roomId);
```

При повторной отправке (`clientMessageId`) сравнение должны учитывать и `reply_to_id`:

```ts
const previous = db.prepare(
  'SELECT author_id, room_id, body, file_id, reply_to_id FROM chat_messages WHERE id = ?'
).get(clientId) as
  | { author_id: string; room_id: string; body: string; file_id: string | null; reply_to_id: string | null }
  | undefined;
// ...
if (
  previous.author_id !== user.id ||
  previous.room_id !== roomId ||
  previous.body !== body ||
  previous.reply_to_id !== replyToId ||
  !sameFile
) {
  res.status(409).json({ error: 'Повторная отправка отличается от исходного сообщения.' });
  return;
}
```

#### 3.3.3. Отдача reply-полей в `GET /messages`

```ts
const messages = db.prepare(`
  SELECT
    m.seq, m.id, m.author_id, u.full_name AS author_name,
    m.body, m.file_id, f.original_name, f.mime_type, f.size_bytes,
    m.reply_to_id,
    rm.body AS reply_body,
    rm.deleted_at AS reply_deleted_at,
    ru.full_name AS reply_author_name,
    rf.original_name AS reply_original_name,
    rf.mime_type AS reply_mime_type,
    m.created_at, m.edited_at
  FROM chat_messages m
  JOIN users u ON u.id = m.author_id
  LEFT JOIN chat_files f ON f.id = m.file_id
  LEFT JOIN chat_messages rm ON rm.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = rm.author_id
  LEFT JOIN chat_files rf ON rf.id = rm.file_id
  WHERE m.room_id = ? AND m.seq > ? AND m.seq < ? AND m.deleted_at IS NULL
  ORDER BY m.seq DESC
  LIMIT 100
`).all(roomId, after, before).reverse();
```

`DELETE /messages/:id` не удаляет физически, поэтому `reply_deleted_at` появится автоматически.

### 3.4. Клиент: `src/views/ChatView.tsx`

#### 3.4.1. Тип сообщения

```tsx
type Message = {
  seq: number;
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  file_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  created_at: string;
  edited_at: string | null;
  reply_to_id: string | null;
  reply_body: string | null;
  reply_deleted_at: string | null;
  reply_author_name: string | null;
  reply_original_name: string | null;
  reply_mime_type: string | null;
};
```

#### 3.4.2. Состояние ответа и отправка

```tsx
const [replyTo, setReplyTo] = useState<Message | null>(null);

const send = async (e: React.FormEvent) => {
  e.preventDefault();
  if (busy || (!body.trim() && !file && !attachedOrder)) return;
  setBusy(true);
  setError('');
  try {
    if (editing) {
      await apiRequest(`/api/chat/messages/${editing}`, {
        method: 'PATCH', body: { body }, skipOfflineQueue: true,
      });
    } else {
      const fullBody = attachedOrder
        ? `${body.trim()}${body.trim() ? '\n' : ''}[[order:${attachedOrder.id}]]`
        : body;

      const pendingKey = `${fullBody}|${replyTo?.id || ''}`;
      if (
        !pendingMessage.current ||
        pendingMessage.current.key !== pendingKey ||
        pendingMessage.current.file !== file
      ) {
        pendingMessage.current = { id: crypto.randomUUID(), key: pendingKey, body: fullBody, file };
      }

      const data = new FormData();
      data.set('body', fullBody);
      data.set('roomId', room.id);
      data.set('clientMessageId', pendingMessage.current.id);
      if (replyTo) data.set('replyToId', replyTo.id);
      if (file) data.set('file', file);

      await apiRequest('/api/chat/messages', {
        method: 'POST', formData: data, skipOfflineQueue: true,
      });
      pendingMessage.current = null;
      onClearOrder();
    }
    setBody('');
    setFile(null);
    setEditing(null);
    setReplyTo(null);
    try {
      await load();
      end.current?.scrollIntoView({ behavior: 'smooth' });
    } catch {
      setError('Сообщение отправлено, но не удалось обновить чат.');
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Ошибка отправки');
  } finally {
    setBusy(false);
  }
};
```

Изменить тип ref:

```tsx
const pendingMessage = useRef<{ id: string; key: string; body: string; file: File | null } | null>(null);
```

#### 3.4.3. Enter отправляет, Shift+Enter — перенос

```tsx
const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.nativeEvent.isComposing) return; // русская/китайская раскладка
  e.preventDefault();
  if (!busy) e.currentTarget.form?.requestSubmit();
};
```

На textarea:

```tsx
<textarea
  aria-label="Сообщение"
  value={body}
  onChange={(e) => setBody(e.target.value)}
  onKeyDown={handleComposerKeyDown}
  rows={2}
  maxLength={5000}
  placeholder="Напишите сообщение"
  className="min-w-0 flex-1 resize-y rounded-xl bg-zinc-100 p-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:bg-[#0B0C10]"
/>
```

На мобильных аппаратная клавиатура тоже отправит по Enter. Если это нежелательно, условие можно дополнить `window.matchMedia('(pointer: fine)').matches`, но по требованию «на ПК Enter отправляет» достаточно текущего варианта.

#### 3.4.4. Кнопка «Ответить» и цитата

Добавить в импорт `Reply` из `lucide-react`. В блоке сообщения, рядом с редактированием/удалением:

```tsx
<button
  type="button"
  aria-label="Ответить на сообщение"
  onClick={() => {
    setReplyTo(m);
    setEditing(null);
  }}
>
  <Reply size={13} />
</button>
```

Перед текстом сообщения:

```tsx
{m.reply_to_id && (
  <button
    type="button"
    onClick={() => {
      const node = document.getElementById(`chat-message-${m.reply_to_id}`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }}
    className="mb-1.5 block w-full border-l-2 border-[#0071E3] pl-2 text-left text-xs text-zinc-500"
  >
    <span className="font-semibold text-[#0071E3] dark:text-[#71b5ff]">
      {m.reply_author_name || 'Сообщение'}
    </span>
    <span className="mt-0.5 block truncate">
      {m.reply_deleted_at
        ? 'Сообщение удалено'
        : m.reply_body || m.reply_original_name || 'Вложение'}
    </span>
  </button>
)}
```

Каждому сообщению добавить `id={`chat-message-${m.id}`}`.

В форме, над textarea:

```tsx
{replyTo && !editing && (
  <div className="flex w-full items-start justify-between gap-2 rounded-xl bg-black/[0.04] px-3 py-2 text-xs dark:bg-white/[0.06]">
    <div className="min-w-0 border-l-2 border-[#0071E3] pl-2">
      <div className="font-semibold text-[#0071E3] dark:text-[#71b5ff]">
        Ответ: {replyTo.author_name}
      </div>
      <div className="truncate text-zinc-500">
        {replyTo.body || replyTo.original_name || 'Вложение'}
      </div>
    </div>
    <button type="button" onClick={() => setReplyTo(null)} className="text-zinc-400">
      <X size={14} />
    </button>
  </div>
)}
```

#### 3.4.5. Превью фото и видео вместо ссылок

```tsx
{m.file_id && (
  m.mime_type?.startsWith('image/') ? (
    <button
      type="button"
      onClick={() => setPreview({ url: `/api/chat/files/${m.file_id}`, type: 'image', name: m.original_name || 'Фото' })}
      className="mt-1 block"
    >
      <img
        src={`/api/chat/files/${m.file_id}`}
        alt={m.original_name || 'Фото'}
        loading="lazy"
        className="max-h-72 max-w-full rounded-xl object-contain"
      />
    </button>
  ) : m.mime_type?.startsWith('video/') ? (
    <video
      src={`/api/chat/files/${m.file_id}`}
      controls
      preload="metadata"
      playsInline
      className="mt-1 max-h-72 max-w-full rounded-xl bg-black"
    />
  ) : m.mime_type?.startsWith('audio/') ? (
    <audio controls preload="metadata" src={`/api/chat/files/${m.file_id}`} className="max-w-full" />
  ) : (
    <a
      className="mt-1 block break-all text-[#0071E3] underline dark:text-[#71b5ff]"
      href={`/api/chat/files/${m.file_id}`}
      target="_blank"
      rel="noreferrer"
    >
      {m.original_name}
    </a>
  )
)}
```

Просмотрщик:

```tsx
const [preview, setPreview] = useState<{ url: string; type: 'image' | 'video'; name: string } | null>(null);
```

```tsx
{preview && (
  <div
    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
    onClick={() => setPreview(null)}
  >
    <div className="max-h-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
      {preview.type === 'image' ? (
        <img src={preview.url} alt={preview.name} className="max-h-[85vh] max-w-full object-contain" />
      ) : (
        <video src={preview.url} controls autoPlay className="max-h-[85vh] max-w-full" />
      )}
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-white">
        <span className="truncate">{preview.name}</span>
        <button type="button" onClick={() => setPreview(null)} className="rounded-lg border border-white/30 px-3 py-1.5">
          Закрыть
        </button>
      </div>
    </div>
  </div>
)}
```

#### 3.4.6. Input файла: видео

```tsx
<label className="cursor-pointer rounded-xl p-2" title="Прикрепить фото, видео или файл">
  <Paperclip size={20} />
  <input
    type="file"
    className="hidden"
    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
    onChange={(e) => setFile(e.target.files?.[0] || null)}
  />
</label>
```

Для одного сообщения — один файл (схема `chat_messages.file_id`). Если нужно несколько вложений в одном сообщении, это отдельная миграция `chat_message_files`; в текущем объёме не требуется.

### 3.5. Приёмка по замечанию 4

- [ ] Ответ на сообщение отображается цитатой с автором и текстом.
- [ ] Клик по цитате прокручивает к исходному сообщению.
- [ ] Если исходное сообщение удалено, цитата показывает «Сообщение удалено».
- [ ] На ПК Enter отправляет, Shift+Enter переносит строку; в русской раскладке нет ложных отправок.
- [ ] Фото показывается картинкой, видео — плеером, аудио — плеером.
- [ ] Видео MP4/MOV загружается в чат и воспроизводится в Chrome и Safari.
- [ ] Reply и видео работают после перезагрузки страницы.

## 4. Замечание 3 — «Бухгалтерия» → «Документы», разделы «Акты» и «Чертежи»

### 4.1. Что происходит сейчас

- В навигации `src/components/AppShell.tsx:81` пункт называется «Бухгалтерия».
- `src/views/AccountingView.tsx` — один список документов без категорий; заголовок «Документы бухгалтерии».
- `server/routes/accounting.ts:22` — ошибка «Доступ к бухгалтерии отключён».
- Кнопки вкладок/разделов в `AccountingView` нет, поэтому нет и активного состояния.
- В `server/migrations/007_accounting_documents.sql` нет колонки категории.

### 4.2. Миграция `server/migrations/014_document_categories.sql`

`014` работает со старым именем таблицы: она применяется до `017`, который переименует `accounting_documents` в `documents`.

```sql
ALTER TABLE accounting_documents
  ADD COLUMN category TEXT NOT NULL DEFAULT 'acts';

CREATE INDEX IF NOT EXISTS idx_documents_category
  ON accounting_documents(category, created_at);
```

Старые документы автоматически попадут в «Акты». Ограничение `CHECK` не добавляем: валидация — в API. После `017` индекс продолжает работать уже с таблицей `documents`.

### 4.3. Сервер: `server/routes/documents.ts`

`server/routes/accounting.ts` удаляется, вместо него создаётся `documents.ts`:

```ts
// server/app.ts
import { createDocumentsRouter } from './routes/documents.ts';
app.use('/api/documents', createDocumentsRouter(db));
```

```ts
// server/routes/documents.ts
export function createDocumentsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  router.use(requireAdmin);
  router.use((req: AuthedRequest, res, next) => {
    if (!req.authUser!.documentsAccess) {
      res.status(403).json({ error: 'Доступ к документам отключён.' });
      return;
    }
    next();
  });
  // ...
  return router;
}
```

Папка хранения переименовывается в `uploads/documents`:

```ts
function folder() {
  const dir = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'documents');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
```

#### 4.3.1. Категория в списке

```ts
router.get('/', (req, res) => {
  const q = typeof req.query.q === 'string'
    ? req.query.q.trim().toLocaleLowerCase('ru-RU')
    : '';
  const category = req.query.category === 'drawings'
    ? 'drawings'
    : req.query.category === 'acts'
      ? 'acts'
      : null;
  const ascending = req.query.sort === 'oldest';

  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];
  const rows = db.prepare(`
    SELECT id, original_name, size_bytes, category, created_at
    FROM documents
    ${where}
    ORDER BY created_at ${ascending ? 'ASC' : 'DESC'}, id ${ascending ? 'ASC' : 'DESC'}
  `).all(...params) as Array<{
    id: string;
    original_name: string;
    size_bytes: number;
    category: string;
    created_at: string;
  }>;

  const counts = db.prepare(`
    SELECT category, COUNT(*) AS n
    FROM documents
    GROUP BY category
  `).all() as Array<{ category: string; n: number }>;

  res.json({
    documents: q
      ? rows.filter((row) => row.original_name.toLocaleLowerCase('ru-RU').includes(q))
      : rows,
    counts: {
      acts: counts.find((row) => row.category === 'acts')?.n || 0,
      drawings: counts.find((row) => row.category === 'drawings')?.n || 0,
    },
  });
});
```

#### 4.3.2. Категория и загрузка без лимита 12 МБ

`multer` — `diskStorage` из раздела 2.3, папка `folder()`, без `fileSize` (только опциональный `MAX_UPLOAD_BYTES`).

```ts
const category = req.body.category === 'drawings' ? 'drawings' : 'acts';

db.prepare(`
  INSERT INTO documents
    (id, original_name, stored_name, size_bytes, category, uploaded_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(id, name, req.file.filename, req.file.size, category, req.authUser!.id, now);

res.status(201).json({
  document: {
    id,
    original_name: name,
    size_bytes: req.file.size,
    category,
    created_at: now,
  },
});
```

#### 4.3.3. Перемещение и удаление

```ts
router.patch('/:id', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const category = req.body.category === 'drawings' ? 'drawings' : 'acts';
  const result = db.prepare(
    'UPDATE documents SET category = ? WHERE id = ?'
  ).run(category, id);
  if (!result.changes) {
    res.status(404).json({ error: 'Документ не найден.' });
    return;
  }
  writeAuditLog(db, req.authUser!.id, 'document', id, 'document_moved', { category });
  res.json({ ok: true, category });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const row = db.prepare(
    'SELECT stored_name FROM documents WHERE id = ?'
  ).get(id) as { stored_name: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Документ не найден.' });
    return;
  }
  if (!/^[0-9a-f-]{36}$/.test(row.stored_name)) {
    res.status(500).json({ error: 'Некорректное имя файла.' });
    return;
  }
  withTransaction(db, () => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    writeAuditLog(db, req.authUser!.id, 'document', id, 'document_deleted', {});
  });
  fs.rmSync(path.join(folder(), row.stored_name), { force: true });
  res.json({ ok: true });
});
```

#### 4.3.4. Резервное копирование

`server/services/backup.ts` тоже переходит на `documents` и `uploads/documents`:

```ts
if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get()) {
  const documents = snapshot.prepare('SELECT DISTINCT stored_name FROM documents').all();
  if (documents.length) fs.mkdirSync(path.join(destination, 'uploads', 'documents'), { mode: 0o700 });
  for (const row of documents) {
    const name = String(row.stored_name);
    if (!/^[0-9a-f-]{36}$/.test(name)) throw new Error('Unsafe document file name');
    const target = path.join(destination, 'uploads', 'documents', name);
    fs.copyFileSync(path.join(uploadDir, 'documents', name), target);
    files[`uploads/documents/${name}`] = sha(target);
  }
}
```

#### 4.3.5. Текст ошибки

```ts
res.status(403).json({ error: 'Доступ к документам отключён.' });
```

### 4.4. Клиент: `src/views/DocumentsView.tsx` (бывший `AccountingView.tsx`)

Полностью переписать компонент. Ключевые части:

```tsx
type Category = 'acts' | 'drawings';

const TABS: Array<{ id: Category; label: string }> = [
  { id: 'acts', label: 'Акты' },
  { id: 'drawings', label: 'Чертежи' },
];

export function DocumentsView() {
  const [category, setCategory] = useState<Category>('acts');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [counts, setCounts] = useState<Record<Category, number>>({ acts: 0, drawings: 0 });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ q: query, sort, category });
      const result = await apiRequest<{
        documents: DocumentItem[];
        counts: Record<Category, number>;
      }>(`/api/documents?${params}`, { useCache: false });
      setDocuments(result.documents);
      setCounts(result.counts);
      setError('');
    } catch (err) {
      setDocuments([]);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить документы.');
    }
  }, [query, sort, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const data = new FormData();
      data.append('file', file);
      data.append('category', category);
      await apiRequest('/api/documents', {
        method: 'POST', formData: data, skipOfflineQueue: true,
      });
      setFile(null);
      setInputKey((key) => key + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold">Документы</h2>
        <p className="text-sm text-zinc-500">
          Акты и чертежи: загрузка, поиск, сортировка и скачивание. Размер файла не ограничен.
        </p>
      </div>

      <div role="tablist" aria-label="Разделы документов" className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const active = category === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setCategory(tab.id)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                active
                  ? 'bg-[#0071E3] text-white shadow-sm dark:bg-[#2997FF] dark:text-[#0B0C10]'
                  : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-[#282b32] dark:text-zinc-200'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-white/20' : 'bg-black/10 dark:bg-white/10'}`}>
                {counts[tab.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
        <input
          key={inputKey}
          type="file"
          aria-label={`Выбрать файл в раздел ${category === 'acts' ? 'Акты' : 'Чертежи'}`}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="text-sm"
        />
        {file && <span className="max-w-xs truncate text-xs text-zinc-500">{file.name}</span>}
        <button
          type="button"
          disabled={!file || busy}
          onClick={() => void upload()}
          className="rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
        >
          {busy ? 'Загрузка…' : `Загрузить в «${category === 'acts' ? 'Акты' : 'Чертежи'}»`}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по названию"
          aria-label="Поиск по названию"
          className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Сортировка по дате"
          className="rounded-xl border border-zinc-400 bg-white px-3 py-2 dark:bg-[#0B0C10]"
        >
          <option value="newest">Сначала новые</option>
          <option value="oldest">Сначала старые</option>
        </select>
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <ul className="divide-y divide-zinc-300 dark:divide-zinc-700">
        {documents.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="break-all font-medium">{doc.original_name}</div>
              <div className="text-xs text-zinc-500">
                {formatDateTimeRu(doc.created_at)} · {formatBytes(doc.size_bytes)}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`/api/documents/${encodeURIComponent(doc.id)}/download`}
                className="text-sm font-semibold text-[#0071E3]"
              >
                Скачать
              </a>
              <button
                type="button"
                onClick={() => {
                  const next: Category = category === 'acts' ? 'drawings' : 'acts';
                  void apiRequest(`/api/documents/${doc.id}`, {
                    method: 'PATCH', body: { category: next },
                  }).then(load).catch((err) => setError(err.message));
                }}
                className="text-xs text-zinc-500 hover:text-[#0071E3]"
              >
                В {category === 'acts' ? 'чертежи' : 'акты'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(doc.id)}
                className="text-xs text-red-600"
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 dark:bg-[#15171C]">
            <p className="text-sm font-semibold">Удалить документ?</p>
            <p className="mt-1 text-xs text-zinc-500">Файл будет удалён с сервера без возможности восстановления.</p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="flex-1 rounded-xl border border-black/[0.1] py-2 text-sm dark:border-white/[0.1]"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = confirmDelete;
                  setConfirmDelete(null);
                  void apiRequest(`/api/documents/${id}`, { method: 'DELETE' })
                    .then(load)
                    .catch((err) => setError(err.message));
                }}
                className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
```

`formatBytes` добавить в `src/lib/api.ts`:

```ts
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
```

### 4.5. Полное переименование `accounting` → `documents`

В этом релизе переименовывается всё, включая внутренние ключи. Старых имён в коде не остаётся.

**Навигация и вкладка**

`src/components/AppShell.tsx:32` — в union добавить `'documents'` вместо `'accounting'`:

```tsx
| 'documents'
```

`src/components/AppShell.tsx:81`:

```tsx
...(user.documentsAccess
  ? [{ id: 'documents' as const, label: 'Документы', icon: FileText }]
  : []),
```

`src/App.tsx`:

```tsx
import { DocumentsView } from './views/DocumentsView';
// ...
{activeTab === 'documents' && isAdmin && user.documentsAccess && <DocumentsView />}
```

`src/types/crm.ts:17`:

```ts
documentsAccess: boolean;
```

**Права**

`server/security.ts`:

```ts
documentsAccess: boolean;
// ...
documentsAccess:
  row.role === 'admin' &&
  permRows.find((p) => p.permission_key === 'documents.access')?.granted !== 0,
```

`server/routes/users.ts`:

```ts
const documentsAccess = req.body.documentsAccess;
if (documentsAccess !== undefined && typeof documentsAccess !== 'boolean') {
  res.status(400).json({ error: 'Некорректное значение доступа к документам.' });
  return;
}
// ...
if (typeof documentsAccess === 'boolean' && nextRole === 'admin') {
  db.prepare(
    `INSERT INTO user_permissions (user_id, permission_key, granted)
     VALUES (?, 'documents.access', ?)
     ON CONFLICT(user_id, permission_key) DO UPDATE SET granted = excluded.granted`
  ).run(targetId, documentsAccess ? 1 : 0);
}
```

`src/views/EmployeesView.tsx:591`:

```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={fDocumentsAccess}
    onChange={(e) => setFDocumentsAccess(e.target.checked)}
  />
  Доступ к документам
</label>
```

**Файлы и маршруты**

| Было | Стало |
|---|---|
| `server/routes/accounting.ts` | `server/routes/documents.ts` |
| `createAccountingRouter` | `createDocumentsRouter` |
| `/api/accounting` | `/api/documents` |
| `src/views/AccountingView.tsx` | `src/views/DocumentsView.tsx` |
| `upload/accounting/` | `upload/documents/` |
| `accounting_documents` (код) | `documents` |
| `accounting.access` | `documents.access` |
| `accountingAccess` | `documentsAccess` |

`server/routes/accounting.ts` и `src/views/AccountingView.tsx` удаляются, а не остаются как обёртки.

**Тесты**

- `tests/accountingRules.test.ts` → `tests/documentsRules.test.ts`; все `/api/accounting` → `/api/documents`, `accountingAccess` → `documentsAccess`, `accounting_documents` → `documents`.
- `tests/backupRules.test.ts`: таблица `documents`, папка `uploads/documents`, строка в `files` — `uploads/documents/<uuid>`.
- `tests/chatRules.test.ts`: `chat_push_subscriptions` → `push_subscriptions`; из вставки `salary_payouts` убрать `payment_method`.

Проверка, что старых имён не осталось:

```powershell
rg -n "accounting|Accounting" src server tests public `
  --glob "!server/migrations/007_accounting_documents.sql" `
  --glob "!server/migrations/014_document_categories.sql" `
  --glob "!server/migrations/017_final_cleanup.sql"
```

Ожидается пустой вывод. В миграциях `007`, `014`, `017` старые имена остаются намеренно: это история применения схемы.

### 4.6. Приёмка по замечанию 3

- [ ] В меню и заголовке написано «Документы», слова «Бухгалтерия» в UI нет.
- [ ] Есть две вкладки: «Акты» и «Чертежи», у каждой — счётчик.
- [ ] Активная вкладка визуально выделена (синяя), `aria-selected` корректен.
- [ ] В каждом разделе работают загрузка, поиск, сортировка, скачивание, перемещение и удаление.
- [ ] После миграции нет таблицы `accounting_documents`; есть `documents`.
- [ ] В коде нет `accountingAccess`/`accounting.access` (кроме истории миграций).
- [ ] Пользователь без `documentsAccess` не видит раздел и получает 403 от API.
- [ ] Резервная копия включает `uploads/documents/`.

## 5. Замечание 2 — push-уведомления по задачам и чатам в Chrome и Safari

### 5.1. Что уже есть и чего не хватает

Есть:

- VAPID-ключи в `.env`: `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`.
- Таблица `chat_push_subscriptions` (`server/migrations/003_chat.sql:30–35`).
- Эндпоинты `/api/chat/push-key` и `/api/chat/push-subscription` (`server/routes/chat.ts:206–213`).
- Отправка push при новом сообщении в чат (`chat.ts:99–105`).
- Service worker `public/chat-push.js`, подключённый через `vite.config.ts:51`.

Не хватает:

1. Push привязан только к чату. `notifyUser` (`server/security.ts:161–183`) создаёт только in-app уведомление; задачи, заказы, зарплата push не отправляют.
2. Подписка хранится в `chat_push_subscriptions` и жёстко привязана к `sessions.id`; после истечения сессии push перестаёт приходить, даже если устройство осталось подписано.
3. Кнопка «Включить уведомления» есть только внутри чата, а не в настройках.
4. `public/chat-push.js` не умеет открывать задачу/заказ, не использует `tag` и не фокусирует уже открытое окно.
5. Проверка endpoint в `chat.ts:210` излишне ограничивает хосты. Safari/iOS может отдавать endpoint, не входящий в два перечисленных хоста.

### 5.2. Миграция `server/migrations/013_push_subscriptions.sql`

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  subscription_json TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

INSERT OR IGNORE INTO push_subscriptions
  (endpoint, user_id, session_id, subscription_json, created_at, updated_at)
SELECT endpoint, user_id, session_id, subscription_json,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM chat_push_subscriptions;
```

Старую таблицу не удаляем: она останется как архив и для отката. После проверки можно удалить отдельной миграцией.

### 5.3. Новый сервис `server/services/push.ts`

```ts
import * as webpush from 'web-push';
import type { DatabaseSync } from 'node:sqlite';

const pub = process.env.WEB_PUSH_PUBLIC_KEY || '';
const priv = process.env.WEB_PUSH_PRIVATE_KEY || '';

if (pub && priv) {
  webpush.setVapidDetails(
    process.env.WEB_PUSH_SUBJECT || 'mailto:admin@example.com',
    pub,
    priv
  );
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

export function pushConfigured(): boolean {
  return Boolean(pub && priv);
}

export function pushPublicKey(): string | null {
  return pub || null;
}

export async function sendPushToUser(
  db: DatabaseSync,
  userId: string,
  payload: PushPayload
): Promise<void> {
  if (!pushConfigured()) return;

  const rows = db.prepare(
    `SELECT endpoint, subscription_json
     FROM push_subscriptions
     WHERE user_id = ?`
  ).all(userId) as Array<{ endpoint: string; subscription_json: string }>;

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          JSON.parse(row.subscription_json),
          JSON.stringify(payload),
          { TTL: 60 * 60 }
        );
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
        }
      }
    })
  );
}

export async function sendPushToRoom(
  db: DatabaseSync,
  roomId: string,
  authorId: string,
  payload: PushPayload
): Promise<void> {
  if (!pushConfigured()) return;

  const rows = db.prepare(
    `SELECT DISTINCT p.user_id
     FROM push_subscriptions p
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id != ?
       AND u.is_active = 1
       AND (? = 'general' OR EXISTS (
         SELECT 1 FROM chat_room_members m
         WHERE m.room_id = ? AND m.user_id = p.user_id
       ))`
  ).all(authorId, roomId, roomId) as Array<{ user_id: string }>;

  await Promise.allSettled(
    rows.map((row) => sendPushToUser(db, row.user_id, payload))
  );
}

export function notifyPush(
  db: DatabaseSync,
  userId: string,
  payload: PushPayload
): void {
  if (!pushConfigured()) return;
  // setImmediate — чтобы не отправлять push внутри незакоммиченной транзакции.
  setImmediate(() => {
    void sendPushToUser(db, userId, payload).catch((error) => {
      console.error('[push] send failed', error instanceof Error ? error.message : error);
    });
  });
}
```

### 5.4. `server/security.ts`: push для всех in-app уведомлений

В начало:

```ts
import { notifyPush } from './services/push.ts';
```

В конец `notifyUser`:

```ts
function pushUrl(entityType?: string, entityId?: string): string {
  if (entityType === 'quick_task' && entityId) return `/?task=${encodeURIComponent(entityId)}`;
  if (entityType === 'order' && entityId) return `/?order=${encodeURIComponent(entityId)}`;
  if (entityType === 'salary') return '/?tab=salary';
  return '/';
}

export function notifyUser(
  db: DatabaseSync,
  userId: string,
  type: string,
  title: string,
  body: string,
  linkEntityType?: string,
  linkEntityId?: string
): void {
  db.prepare(
    `INSERT INTO notifications
       (id, user_id, type, title, body, link_entity_type, link_entity_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    crypto.randomUUID(), userId, type, title, body,
    linkEntityType || null, linkEntityId || null, new Date().toISOString()
  );

  notifyPush(db, userId, {
    title,
    body: body.slice(0, 180),
    url: pushUrl(linkEntityType, linkEntityId),
    tag: `${type}:${linkEntityId || ''}`,
  });
}
```

Это автоматически покрывает:

- `quickTasks.ts` — назначение задачи, завершение, переназначение;
- `orders.ts` — уведомления по заказам и выездам;
- `salaries.ts` — начисления и выплаты;
- `shifts.ts` — закрытие смены;
- `backup` — ошибки резервного копирования (если нужно).

### 5.5. Новый роутер `server/routes/push.ts`

```ts
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { pushConfigured, pushPublicKey } from '../services/push.ts';

export function createPushRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/key', (_req, res) => {
    res.json({ publicKey: pushConfigured() ? pushPublicKey() : null });
  });

  router.post('/subscription', (req: AuthedRequest, res) => {
    const sub = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    try {
      const url = new URL(String(sub.endpoint || ''));
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !sub.keys?.p256dh ||
        !sub.keys?.auth
      ) {
        throw new Error();
      }
    } catch {
      res.status(400).json({ error: 'Некорректная подписка на уведомления.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO push_subscriptions
         (endpoint, user_id, session_id, subscription_json, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         session_id = excluded.session_id,
         subscription_json = excluded.subscription_json,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`
    ).run(
      String(sub.endpoint),
      req.authUser!.id,
      req.sessionId || null,
      JSON.stringify(sub),
      req.get('user-agent') || '',
      now,
      now
    );

    res.json({ ok: true });
  });

  router.delete('/subscription', (req: AuthedRequest, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) {
      db.prepare(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'
      ).run(endpoint, req.authUser!.id);
    }
    res.json({ ok: true });
  });

  return router;
}
```

Подключить в `server/app.ts`:

```ts
import { createPushRouter } from './routes/push.ts';
// ...
app.use('/api/push', createPushRouter(db));
```

Старые `/api/chat/push-key` и `/api/chat/push-subscription` оставить как алиасы на один релиз, чтобы не ломать уже установленные PWA. Внутри них вызывать ту же логику или перенаправлять на новый сервис. После обновления всех устройств — удалить.

### 5.6. `server/routes/chat.ts`: использовать общий сервис

Удалить `import * as webpush`, `webpush.setVapidDetails`, локальный `broadcast` с `webpush.sendNotification`. Заменить:

```ts
import { pushPublicKey, sendPushToRoom } from '../services/push.ts';

router.get('/push-key', (_req, res) => res.json({ publicKey: pushPublicKey() }));

// в POST /messages:
void sendPushToRoom(db, roomId, user.id, {
  title: user.fullName,
  body: body.slice(0, 180) || (req.file?.mimetype.startsWith('video/') ? 'Видео' : 'Вложение'),
  url: `/?chat=${encodeURIComponent(roomId)}`,
  tag: `chat:${roomId}`,
});
```

Эндпоинт `/api/chat/push-subscription` можно оставить, но он должен писать в `push_subscriptions`, а не в `chat_push_subscriptions`. Проще: во фронтенде перейти на `/api/push/*`, а старый эндпоинт оставить только на время переходного периода.

### 5.7. Service worker `public/chat-push.js`

```js
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    // push без JSON
  }

  const url = data.url || (data.roomId ? `/?chat=${encodeURIComponent(data.roomId)}` : '/');

  event.waitUntil(
    self.registration.showNotification(data.title || 'Позитив Вектор', {
      body: data.body || 'Новое уведомление',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      await existing.navigate(target);
      return;
    }
    await clients.openWindow(target);
  })());
});
```

`tag` не даёт дублировать одинаковые уведомления; для чата tag — `chat:<roomId>`, для задачи — `quick_task:<id>`.

### 5.8. Клиент: `src/lib/push.ts`

```ts
import { apiRequest } from './api';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export async function enablePushNotifications(): Promise<string> {
  if (!window.isSecureContext) {
    throw new Error('Push работает только по HTTPS. Откройте сайт по https://.');
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error(
      'На этом устройстве push недоступен. На iPhone добавьте приложение на экран «Домой» и откройте его оттуда.'
    );
  }
  if (Notification.permission === 'denied') {
    throw new Error('Уведомления запрещены в настройках браузера. Разрешите их для сайта вручную.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Разрешение на уведомления не выдано.');
  }

  const { publicKey } = await apiRequest<{ publicKey: string | null }>(
    '/api/push/key', { useCache: false }
  );
  if (!publicKey) throw new Error('Push не настроен на сервере: нет VAPID-ключей.');

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await apiRequest('/api/push/subscription', {
    method: 'POST',
    body: subscription.toJSON(),
    skipOfflineQueue: true,
  });

  return 'Уведомления на этом устройстве включены.';
}
```

Кнопка в `src/views/SettingsView.tsx` (рядом с темой/PWA):

```tsx
const [pushMessage, setPushMessage] = useState('');
// ...
<button
  type="button"
  onClick={() => {
    void enablePushNotifications()
      .then(setPushMessage)
      .catch((error) => setPushMessage(error instanceof Error ? error.message : 'Ошибка push'));
  }}
  className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.08] px-3.5 py-2 text-xs font-semibold dark:border-white/[0.1]"
>
  Включить push-уведомления
</button>
{pushMessage && <p className="mt-2 text-xs text-zinc-500">{pushMessage}</p>}
```

В `ChatView.tsx` удалить локальную реализацию `enablePush` и вызывать `enablePushNotifications()` — чтобы не было двух разных подписок.

### 5.9. Deep links для задач и заказов

Сейчас `App.tsx` понимает только `?chat=`. Добавить обработку `?task=` и `?order=`:

```tsx
const deepLinkHandled = useRef(false);

useEffect(() => {
  if (!user || deepLinkHandled.current) return;
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get('task');
  const orderId = params.get('order');

  if (taskId) {
    deepLinkHandled.current = true;
    setActiveTab('calendar');
    setOpenQuickTaskId(taskId);
  } else if (orderId) {
    deepLinkHandled.current = true;
    void handleOpenOrderById(orderId);
  }
}, [user, orders.length]);
```

`handleOpenOrderById` уже есть в `App.tsx` (около строк 205–220).

### 5.10. Chrome, Safari, iPhone: что важно

- **Chrome (Windows/macOS/Android):** работает при HTTPS, разрешении на уведомления и включённых уведомлениях Windows/macOS для браузера. Endpoint обычно `fcm.googleapis.com`.
- **Safari macOS 16.4+:** работает для сайта, открытого в Safari, после разрешения. На более старых macOS web push нет.
- **Safari iOS 16.4+:** push работает только для PWA, добавленного на экран «Домой» (`display: standalone` уже есть в `vite.config.ts`). Открытие в обычной вкладке Safari push не даст. Разрешение запрашивается только по жесту пользователя.
- **Chrome на iOS:** использует WebKit; поведение зависит от версии iOS. Если push не появляется — использовать PWA из Safari.
- **HTTPS обязателен.** После переезда на VPS (раздел 7) это будет выполнено.
- **VAPID-ключи:** если их нет, сгенерировать:
  ```bash
  npx web-push generate-vapid-keys
  ```
  и прописать в `.env` на сервере. Публичный ключ не секрет, приватный — секрет.
- **Очистка подписок:** при 404/410 endpoint удаляется. При выходе пользователя из аккаунта желательно вызвать `DELETE /api/push/subscription` с текущим endpoint, чтобы не присылать уведомления на чужое устройство.

### 5.11. Приёмка по замечанию 2

- [ ] Chrome на Windows: назначить задачу сотруднику — приходит системное уведомление, клик открывает задачу.
- [ ] Chrome: новое сообщение в чате — приходит уведомление, клик открывает нужный чат.
- [ ] Safari macOS 16.4+: то же самое.
- [ ] iPhone 16.4+: PWA добавлено на экран «Домой», push приходит при закрытом приложении.
- [ ] Повторное включение не создаёт дубликаты подписок.
- [ ] Просроченная сессия не отключает push (подписка не привязана к `sessions.expires_at`).
- [ ] При 410 от push-сервиса подписка удаляется, ошибок в логе нет.

## 6. Замечание 7 — зарплаты и финансы без «откуда/куда», долг из заказов и смен

### 6.1. Что происходит сейчас

- В `salary_accruals` уже есть источники `visit`, `shift`, `manual` (`server/migrations/001_init.sql:197–212`). Начисления за выезд создаются в `salaries.ts:174–192`, за смену — в `shifts.ts:124–136`, ручные премии/удержания — в `salaries.ts:233–237`.
- Выплаты (`salary_payouts`) уже не привязаны к заказу: в `POST /api/salaries/payouts` нет `orderId`. Но UI выплаты содержит выбор способа («Перевод на карту», «Наличные», «Банк (р/с)»), а в финансах и оплатах заказа — такие же селекты. Это и есть «откуда/куда перевели деньги» и «счета», которые просили убрать.
- В карточке сотрудника (`EmployeesView.tsx:424–445`) показываются «Начислено / Выплачено / К выплате», но нет разбивки по заказам и сменам, нет общего долга как отдельного акцента и нет истории операций.
- `GET /api/salaries/summary` (`salaries.ts:120–139`) считает общий итог, но не отдаёт разбивку по источникам и не отдаёт нормализованный журнал операций.
- Общей сводной таблицы по всем сотрудникам и отдельной таблицы по месяцам в UI нет.

### 6.2. Целевая модель

1. **Долг сотрудника** = сумма всех начислений − сумма всех выплат.
   - начисления за выезды (заказы/монтажи);
   - начисления за смены в цеху;
   - ручные премии и удержания (могут быть отрицательными);
   - выплаты.
2. Выплата — общая, не привязана к заказу. В форме выплаты только сумма, дата и комментарий.
3. В карточке сотрудника крупно: «Общий долг» (или «Переплата», если выплатили больше).
4. Отдельная сводная таблица по всем сотрудникам: выезды, смены, корректировки, начислено, выплачено, долг.
5. Отдельный журнал операций по каждому сотруднику: дата, тип, источник, сумма, описание, заказ/выезд.
6. Общая таблица по месяцам: начислено, выплачено, изменение долга, разбивка по сотрудникам.
7. В финансах и оплатах заказа убрать выбор способа/счёта. Суммы, даты и комментарии остаются.

### 6.3. Миграция `server/migrations/016_salary_indexes.sql`

Схему не меняем, только индексы под журнал и месячные сводки:

```sql
CREATE INDEX IF NOT EXISTS idx_salary_accruals_user_created
  ON salary_accruals(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_salary_accruals_created
  ON salary_accruals(created_at);

CREATE INDEX IF NOT EXISTS idx_salary_payouts_user_paid
  ON salary_payouts(user_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_salary_payouts_paid
  ON salary_payouts(paid_at);
```

### 6.4. Сервер: `server/routes/salaries.ts`

#### 6.4.1. Расширить `GET /summary`

Сейчас `accruals` и `payouts` выбираются без привязки к заказу. Добавить join:

```ts
const accruals = db.prepare(`
  SELECT
    a.*,
    ov.order_id,
    o.order_number,
    ov.title AS visit_title
  FROM salary_accruals a
  LEFT JOIN order_visits ov
    ON a.source_type = 'visit' AND ov.id = a.source_id
  LEFT JOIN orders o ON o.id = ov.order_id
  ORDER BY a.created_at DESC
`).all() as Array<{
  id: string;
  user_id: string;
  source_type: 'visit' | 'shift' | 'manual';
  source_id: string | null;
  amount_kopecks: number;
  description: string;
  created_at: string;
  order_id: string | null;
  order_number: string | null;
  visit_title: string | null;
}>;
```

Расчёт по сотруднику:

```ts
const employeesSummary = users.map((u) => {
  const uAccruals = accruals.filter((a) => a.user_id === u.id);
  const uPayouts = payouts.filter((p) => p.user_id === u.id);

  const sumBy = (type: 'visit' | 'shift' | 'manual') =>
    uAccruals
      .filter((a) => a.source_type === type)
      .reduce((sum, a) => sum + a.amount_kopecks, 0);

  const visitAccruedKopecks = sumBy('visit');
  const shiftAccruedKopecks = sumBy('shift');
  const manualAccruedKopecks = sumBy('manual');
  const totalAccruedKopecks =
    visitAccruedKopecks + shiftAccruedKopecks + manualAccruedKopecks;
  const totalPaidKopecks = uPayouts.reduce((sum, p) => sum + p.amount_kopecks, 0);
  const remainingKopecks = totalAccruedKopecks - totalPaidKopecks;

  return {
    ...u,
    visitAccruedKopecks,
    shiftAccruedKopecks,
    manualAccruedKopecks,
    totalAccruedKopecks,
    totalPaidKopecks,
    remainingKopecks,
    overpaidKopecks: Math.max(0, -remainingKopecks),
    accruals: uAccruals,
    payouts: uPayouts,
    lastOperationAt: [...uAccruals.map((a) => a.created_at), ...uPayouts.map((p) => p.paid_at)]
      .sort()
      .at(-1) || null,
  };
});
```

`remainingKopecks` — это и есть «общий долг». Если он отрицательный, это переплата.

#### 6.4.2. Новый `GET /ledger`

```ts
router.get('/ledger', requireAdmin, (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    res.status(400).json({ error: 'Укажите сотрудника.' });
    return;
  }

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';

  const periodSql = from || to
    ? `AND (${from ? 'date(occurred_at) >= date(?)' : '1=1'})
       AND (${to ? 'date(occurred_at) <= date(?)' : '1=1'})`
    : '';
  const periodParams: string[] = [];
  if (from) periodParams.push(from);
  if (to) periodParams.push(to);

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT
        a.id,
        'accrual' AS kind,
        a.source_type AS source,
        a.amount_kopecks,
        a.description,
        a.created_at AS occurred_at,
        o.id AS order_id,
        o.order_number,
        ov.title AS visit_title
      FROM salary_accruals a
      LEFT JOIN order_visits ov
        ON a.source_type = 'visit' AND ov.id = a.source_id
      LEFT JOIN orders o ON o.id = ov.order_id
      WHERE a.user_id = ?

      UNION ALL

      SELECT
        p.id,
        'payout' AS kind,
        'payout' AS source,
        p.amount_kopecks,
        p.comment AS description,
        p.paid_at AS occurred_at,
        NULL AS order_id,
        NULL AS order_number,
        NULL AS visit_title
      FROM salary_payouts p
      WHERE p.user_id = ?
    )
    WHERE 1 = 1
      ${periodSql}
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, ...periodParams, limit, offset);

  res.json({ entries: rows, limit, offset });
});
```

Проверка дат: `from`/`to` приходят как `YYYY-MM-DD`; можно добавить ту же валидацию, что в `quickTasks.validDate`.

#### 6.4.3. Новый `GET /monthly`

```ts
router.get('/monthly', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      substr(created_at, 1, 7) AS month,
      user_id,
      'accrual' AS kind,
      source_type AS source,
      amount_kopecks
    FROM salary_accruals
    UNION ALL
    SELECT
      substr(paid_at, 1, 7) AS month,
      user_id,
      'payout' AS kind,
      'payout' AS source,
      amount_kopecks
    FROM salary_payouts
    ORDER BY month DESC
  `).all() as Array<{
    month: string;
    user_id: string;
    kind: 'accrual' | 'payout';
    source: string;
    amount_kopecks: number;
  }>;

  const names = new Map(
    (db.prepare('SELECT id, full_name FROM users').all() as Array<{ id: string; full_name: string }>)
      .map((u) => [u.id, u.full_name])
  );

  const months = new Map<string, {
    month: string;
    accruedKopecks: number;
    paidKopecks: number;
    employees: Map<string, {
      userId: string;
      fullName: string;
      visitKopecks: number;
      shiftKopecks: number;
      manualKopecks: number;
      paidKopecks: number;
    }>;
  }>();

  for (const row of rows) {
    let month = months.get(row.month);
    if (!month) {
      month = {
        month: row.month,
        accruedKopecks: 0,
        paidKopecks: 0,
        employees: new Map(),
      };
      months.set(row.month, month);
    }

    let employee = month.employees.get(row.user_id);
    if (!employee) {
      employee = {
        userId: row.user_id,
        fullName: names.get(row.user_id) || 'Сотрудник',
        visitKopecks: 0,
        shiftKopecks: 0,
        manualKopecks: 0,
        paidKopecks: 0,
      };
      month.employees.set(row.user_id, employee);
    }

    if (row.kind === 'payout') {
      employee.paidKopecks += row.amount_kopecks;
      month.paidKopecks += row.amount_kopecks;
    } else {
      if (row.source === 'visit') employee.visitKopecks += row.amount_kopecks;
      if (row.source === 'shift') employee.shiftKopecks += row.amount_kopecks;
      if (row.source === 'manual') employee.manualKopecks += row.amount_kopecks;
      month.accruedKopecks += row.amount_kopecks;
    }
  }

  res.json({
    months: [...months.values()]
      .sort((a, b) => b.month.localeCompare(a.month))
      .map((month) => ({
        month: month.month,
        accruedKopecks: month.accruedKopecks,
        paidKopecks: month.paidKopecks,
        deltaKopecks: month.accruedKopecks - month.paidKopecks,
        employees: [...month.employees.values()].sort((a, b) =>
          a.fullName.localeCompare(b.fullName, 'ru')
        ),
      })),
  });
});
```

`deltaKopecks` — изменение долга за месяц. Для точного остатка на конец месяца нужен накопительный расчёт; если он нужен, добавить `balanceKopecks` нарастающим итогом по возрастанию месяцев перед сортировкой.

#### 6.4.4. Выплаты: убрать способ из API-контракта

`POST /payouts` оставить без `orderId` (уже так). `paymentMethod` сделать необязательным и не использовать в UI:

```ts
const method = 'cash'; // историческое поле, в интерфейсе не показываем
```

Либо оставить `paymentMethod` в API для старых клиентов, но новые запросы его не передают; сервер подставит `cash`.

### 6.5. Клиент: `src/views/EmployeesView.tsx`

#### 6.5.1. Тип

```ts
interface SalaryEmployeeSummary {
  id: string;
  full_name: string;
  login: string;
  role: string;
  position: string;
  shift_rate_kopecks: number;
  is_active: number;
  visitAccruedKopecks: number;
  shiftAccruedKopecks: number;
  manualAccruedKopecks: number;
  totalAccruedKopecks: number;
  totalPaidKopecks: number;
  remainingKopecks: number;
  overpaidKopecks: number;
  lastOperationAt: string | null;
}
```

#### 6.5.2. Сводная таблица по сотрудникам

Сразу после верхней панели:

```tsx
<div className="overflow-x-auto rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
  <h3 className="mb-3 font-display text-base font-bold">Сводка по сотрудникам</h3>
  <table className="w-full min-w-[900px] text-left text-xs">
    <thead>
      <tr className="border-b border-black/[0.06] text-zinc-400 dark:border-white/[0.08]">
        <th className="py-2 pr-3 font-semibold">Сотрудник</th>
        <th className="px-3 py-2 font-semibold">Выезды</th>
        <th className="px-3 py-2 font-semibold">Смены</th>
        <th className="px-3 py-2 font-semibold">Премии / удержания</th>
        <th className="px-3 py-2 font-semibold">Начислено</th>
        <th className="px-3 py-2 font-semibold">Выплачено</th>
        <th className="px-3 py-2 font-semibold">Долг</th>
        <th className="px-3 py-2 text-right font-semibold">История</th>
      </tr>
    </thead>
    <tbody>
      {salaries.filter((s) => !s.dismissedAt).map((s) => (
        <tr key={s.id} className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]">
          <td className="py-2.5 pr-3 font-semibold">{s.full_name}</td>
          <td className="px-3 py-2.5 tabular-nums">{formatRub(s.visitAccruedKopecks)}</td>
          <td className="px-3 py-2.5 tabular-nums">{formatRub(s.shiftAccruedKopecks)}</td>
          <td className="px-3 py-2.5 tabular-nums">{formatRub(s.manualAccruedKopecks)}</td>
          <td className="px-3 py-2.5 font-semibold tabular-nums">{formatRub(s.totalAccruedKopecks)}</td>
          <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">{formatRub(s.totalPaidKopecks)}</td>
          <td className={`px-3 py-2.5 font-bold tabular-nums ${s.remainingKopecks >= 0 ? 'text-[#0071E3] dark:text-[#2997FF]' : 'text-emerald-600 dark:text-emerald-400'}`}>
            {formatRub(Math.abs(s.remainingKopecks))}
            <span className="ml-1 text-[10px] font-normal text-zinc-400">
              {s.remainingKopecks >= 0 ? 'к выплате' : 'переплата'}
            </span>
          </td>
          <td className="px-3 py-2.5 text-right">
            <button type="button" onClick={() => void openLedger(s)} className="text-[#0071E3] hover:underline">
              Операции
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

`dismissedAt` есть в `AuthUser`; если TypeScript не видит его в `SalaryEmployeeSummary`, добавить поле в интерфейс.

#### 6.5.3. Карточка сотрудника: общий долг

Заменить блок `sal && (...)` (строки 424–445) на:

```tsx
{sal && (
  <div className="mt-4 rounded-xl bg-[#F5F5F7] p-3.5 dark:bg-[#0B0C10]">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs text-zinc-400">Общий долг</div>
        <div className={`mt-0.5 text-2xl font-bold tabular-nums ${
          sal.remainingKopecks >= 0 ? 'text-[#0071E3] dark:text-[#2997FF]' : 'text-emerald-600 dark:text-emerald-400'
        }`}>
          {formatRub(Math.abs(sal.remainingKopecks))}
        </div>
        <div className="text-[11px] text-zinc-500">
          {sal.remainingKopecks >= 0 ? 'К выплате сотруднику' : 'Переплата сотруднику'}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void openLedger(u, sal)}
        className="rounded-xl border border-black/[0.08] px-3 py-1.5 text-xs font-semibold dark:border-white/[0.1]"
      >
        Все операции
      </button>
    </div>

    <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div><div className="text-zinc-400">Выезды</div><div className="font-semibold tabular-nums">{formatRub(sal.visitAccruedKopecks)}</div></div>
      <div><div className="text-zinc-400">Смены</div><div className="font-semibold tabular-nums">{formatRub(sal.shiftAccruedKopecks)}</div></div>
      <div><div className="text-zinc-400">Премии / удержания</div><div className="font-semibold tabular-nums">{formatRub(sal.manualAccruedKopecks)}</div></div>
      <div><div className="text-zinc-400">Выплачено</div><div className="font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">{formatRub(sal.totalPaidKopecks)}</div></div>
    </div>
  </div>
)}
```

#### 6.5.4. Журнал операций

Состояние и загрузка:

```tsx
type LedgerEntry = {
  id: string;
  kind: 'accrual' | 'payout';
  source: 'visit' | 'shift' | 'manual' | 'payout';
  amount_kopecks: number;
  description: string;
  occurred_at: string;
  order_id: string | null;
  order_number: string | null;
  visit_title: string | null;
};

const [ledgerUser, setLedgerUser] = useState<AuthUser | null>(null);
const [ledger, setLedger] = useState<LedgerEntry[]>([]);
const [ledgerBusy, setLedgerBusy] = useState(false);

const openLedger = async (user: AuthUser) => {
  setLedgerUser(user);
  setLedgerBusy(true);
  try {
    const result = await apiRequest<{ entries: LedgerEntry[] }>(
      `/api/salaries/ledger?userId=${encodeURIComponent(user.id)}&limit=200`,
      { useCache: false }
    );
    setLedger(result.entries);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Не удалось загрузить операции');
  } finally {
    setLedgerBusy(false);
  }
};
```

Модалка:

```tsx
{ledgerUser && (
  <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 dark:bg-[#15171C] sm:rounded-3xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-lg font-bold">Операции: {ledgerUser.fullName}</h3>
        <button type="button" onClick={() => setLedgerUser(null)} className="text-zinc-400">
          <X className="h-5 w-5" />
        </button>
      </div>
      {ledgerBusy ? (
        <p className="text-sm text-zinc-500">Загрузка…</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b text-zinc-400">
              <th className="py-2 pr-3">Дата</th>
              <th className="px-3 py-2">Тип</th>
              <th className="px-3 py-2">Описание</th>
              <th className="px-3 py-2 text-right">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.id} className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]">
                <td className="py-2.5 pr-3 tabular-nums">{formatDateTimeRu(entry.occurred_at)}</td>
                <td className="px-3 py-2.5">
                  {entry.kind === 'payout' ? 'Выплата' :
                   entry.source === 'visit' ? 'Выезд' :
                   entry.source === 'shift' ? 'Смена' : 'Корректировка'}
                </td>
                <td className="px-3 py-2.5">
                  {entry.description || '—'}
                  {entry.order_number && (
                    <button
                      type="button"
                      onClick={() => onOpenOrderById(entry.order_id!)}
                      className="ml-1 text-[#0071E3] hover:underline"
                    >
                      {entry.order_number}
                    </button>
                  )}
                </td>
                <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${
                  entry.kind === 'payout' ? 'text-emerald-600' : entry.amount_kopecks < 0 ? 'text-red-600' : ''
                }`}>
                  {entry.kind === 'payout' ? '−' : entry.amount_kopecks < 0 ? '' : '+'}
                  {formatRub(Math.abs(entry.amount_kopecks))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!ledgerBusy && ledger.length === 0 && <p className="text-sm text-zinc-500">Операций пока нет.</p>}
    </div>
  </div>
)}
```

#### 6.5.5. Форма выплаты: только сумма, дата, комментарий

Убрать `payMethod` и `<select>` (строки 661–671). Добавить дату:

```tsx
const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
```

В `handlePayoutSubmit`:

```ts
await apiRequest('/api/salaries/payouts', {
  method: 'POST',
  body: {
    userId: targetUserId,
    amountKopecks: Math.round(Number(amountRub) * 100),
    paidAt: payDate,
    comment,
    // paymentMethod не передаём: способ перевода больше не часть учёта
  },
});
```

В форме:

```tsx
{modal === 'payout' && (
  <div className="rounded-xl bg-[#F5F5F7] p-3 text-xs dark:bg-[#0B0C10]">
    <div className="text-zinc-400">Текущий долг</div>
    <div className="font-bold text-[#0071E3]">
      {formatRub(Math.max(0, salaries.find((s) => s.id === targetUserId)?.remainingKopecks || 0))}
    </div>
    <button
      type="button"
      onClick={() =>
        setAmountRub(
          String(Math.max(0, salaries.find((s) => s.id === targetUserId)?.remainingKopecks || 0) / 100)
        )
      }
      className="mt-1 text-[#0071E3] underline"
    >
      Выплатить весь долг
    </button>
  </div>
)}

<input
  type="date"
  value={payDate}
  onChange={(e) => setPayDate(e.target.value)}
  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
/>
```

`paymentMethod` в `SalaryEmployeeSummary`/`payouts` можно оставить в API, но не показывать.

#### 6.5.6. Сводка по месяцам

Отдельный блок с загрузкой `/api/salaries/monthly`:

```tsx
type MonthlyRow = {
  month: string;
  accruedKopecks: number;
  paidKopecks: number;
  deltaKopecks: number;
  employees: Array<{
    userId: string;
    fullName: string;
    visitKopecks: number;
    shiftKopecks: number;
    manualKopecks: number;
    paidKopecks: number;
  }>;
};

const [months, setMonths] = useState<MonthlyRow[]>([]);
useEffect(() => {
  void apiRequest<{ months: MonthlyRow[] }>('/api/salaries/monthly', { useCache: false })
    .then((result) => setMonths(result.months))
    .catch(() => {});
}, []);
```

```tsx
<div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
  <h3 className="mb-3 font-display text-base font-bold">Сводка по месяцам</h3>
  <div className="overflow-x-auto">
    <table className="w-full min-w-[700px] text-left text-xs">
      <thead>
        <tr className="border-b text-zinc-400">
          <th className="py-2 pr-3">Месяц</th>
          <th className="px-3 py-2">Начислено</th>
          <th className="px-3 py-2">Выплачено</th>
          <th className="px-3 py-2">Изменение долга</th>
        </tr>
      </thead>
      <tbody>
        {months.map((month) => (
          <tr key={month.month} className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.05]">
            <td className="py-2.5 pr-3 font-semibold">{month.month}</td>
            <td className="px-3 py-2.5 tabular-nums">{formatRub(month.accruedKopecks)}</td>
            <td className="px-3 py-2.5 text-emerald-600 tabular-nums dark:text-emerald-400">{formatRub(month.paidKopecks)}</td>
            <td className="px-3 py-2.5 font-semibold tabular-nums">{formatRub(month.deltaKopecks)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

При желании под каждым месяцем можно раскрывать строки по сотрудникам (`month.employees`), но это уже детализация; отдельный журнал по сотруднику закрывает требование «список действий по каждому».

### 6.6. Убрать «откуда/куда перевели деньги» и счета в UI

#### 6.6.1. `src/views/EmployeesView.tsx`

- Удалить `payMethod` state (строка 84), `setPayMethod` и `<select>` (строки 661–671).
- В `handlePayoutSubmit` не передавать `paymentMethod`.
- В форме выплаты оставить сумму, дату, комментарий.

#### 6.6.2. `src/views/FinanceView.tsx`

Удалить:

- импорт `PAYMENT_METHOD_LABELS` (строка 3);
- `payMethod`/`setPayMethod` (строки 83, 126, 137, 148);
- `expMethod`/`setExpMethod` (строки 90, 158, 169);
- селекты способа оплаты в модалке оплаты (строки 767–775) и расхода (838–847);
- вывод `PAYMENT_METHOD_LABELS[...]` в списке платежей (строка 597) и расходов (найти по `exp.payment_method`).

В запросах `paymentMethod` не передавать:

```ts
body: {
  orderId: payOrderId || null,
  amountKopecks: Math.round(Number(payAmountRub) * 100),
  paymentType: payType,
  paidAt: payDate,
  comment: payComment,
}
```

Сервер тоже перестаёт принимать и хранить способ оплаты — см. 6.6.5.

#### 6.6.3. `src/views/OrderModals.tsx`

Удалить:

- `payMethod`/`setPayMethod` (строки 726, 775, 894, 902);
- `paymentMethod: payMethod` в `handleSavePayment` (строка 966);
- селект «Безнал (р/с) / Карта / перевод / Наличные» (строки 1637–1645).

Оставить сумму, тип оплаты (аванс/доплата/полный расчёт), дату и комментарий. Это убирает «откуда/куда перевели деньги» и в карточке заказа.

#### 6.6.4. `src/views/EmployeeSalaryView.tsx`

Убрать импорт `PAYMENT_METHOD_LABELS` (строка 3) и вывод способа в истории выплат (строка 171). Оставить сумму и дату.

#### 6.6.5. Сервер: убрать `payment_method` из API, экспорта и демо-данных

**`server/routes/finance.ts`**

- В `POST /payments` и `POST /expenses` удалить чтение `req.body.paymentMethod`.
- Из `INSERT` убрать колонку `payment_method` и значение `'cash'`.

```ts
// было
db.prepare(`
  INSERT INTO client_payments
    (id, order_id, amount_kopecks, payment_type, payment_method, paid_at, comment, created_by, created_at)
  VALUES (?, ?, ?, ?, 'cash', ?, ?, ?, ?)
`).run(...);

// стало
db.prepare(`
  INSERT INTO client_payments
    (id, order_id, amount_kopecks, payment_type, paid_at, comment, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(...);
```

То же для `expenses`: без `payment_method`, `created_by` и остальных полей — без изменений.

- В `GET /payments` и `GET /expenses` убрать `payment_method` из `SELECT` и из JSON.

**`server/routes/salaries.ts`**

- В `POST /payouts` удалить `paymentMethod` из тела и из `INSERT INTO salary_payouts`.
- В `GET /payouts`, `GET /summary` и `/ledger` не выбирать `payment_method`.

**`server/routes/orders.ts:221`**

```ts
`SELECT id, amount_kopecks, payment_type, paid_at, comment, created_at
 FROM client_payments
 WHERE order_id = ?
 ORDER BY paid_at DESC, created_at DESC`
```

**`server/routes/export.ts`**

Убрать колонку «Способ» и поле `payment_method` во всех шести выборках: платежи, расходы, выплаты, зарплатный экспорт, общий экспорт, экспорт по заказу.

**`server/scripts/seedDemo.ts`**

Убрать `payment_method` из трёх `INSERT`: `client_payments`, `expenses`, `salary_payouts`.

**Клиентские типы и подписи**

- `src/lib/api.ts:84` — удалить `PAYMENT_METHOD_LABELS`.
- `src/types/crm.ts` — удалить `payment_method` из `ClientPayment`, `Expense`, `SalaryPayout` и `paymentMethod` из входных типов.

Проверка, что поле не осталось в коде:

```powershell
rg -n "payment_method|paymentMethod|PAYMENT_METHOD" src server tests public
```

Ожидается пустой вывод. В `server/migrations/017_final_cleanup.sql` эти слова есть только в `DROP COLUMN` и в комментарии — это единственное допустимое место.

### 6.7. Судьба старых значений `payment_method`

Колонка удаляется миграцией `017_final_cleanup.sql` (`ALTER TABLE ... DROP COLUMN payment_method` в `salary_payouts`, `client_payments`, `expenses`). Бизнес-данные к этому моменту всё равно очищаются скриптом `reset:data`, поэтому переносить старые значения некуда и не нужно. Если в будущем понадобится аналитика «касса/счёт», она вводится новой таблицей справочника, а не возвратом этих колонок.

### 6.8. Приёмка по замечанию 7

- [ ] В карточке сотрудника крупно виден «Общий долг»; рядом — выезды, смены, корректировки, выплачено.
- [ ] Долг = сумма начислений − сумма выплат; после новой выплаты уменьшается ровно на сумму.
- [ ] Выплата не требует выбора заказа и не создаёт привязку к заказу.
- [ ] В форме выплаты нет выбора «карта/счёт/наличные».
- [ ] В финансах и оплате заказа нет селектов способа/счёта; суммы и даты сохраняются.
- [ ] Есть общая таблица по всем сотрудникам.
- [ ] Есть журнал операций по каждому сотруднику с датами, типами и суммами.
- [ ] Есть таблица по месяцам: начислено, выплачено, изменение долга.
- [ ] Отрицательная корректировка (удержание) уменьшает долг; переплата показывается отдельно.
- [ ] Старые выплаты и начисления не потерялись после миграции.

## 7. Замечание 5 — сайт виден только под VPN, из РФ по Wi-Fi не открывается

### 7.1. Диагноз

Сейчас доступ идёт через Cloudflare Tunnel `crm-likvedator` и домен `https://crm.gulya-studio.ru`. В РФ адреса Cloudflare и туннельные endpoint'ы периодически замедляются или блокируются на уровне провайдера. Симптом «под VPN открывается, без VPN — нет» почти наверняка означает именно блокировку/фильтрацию Cloudflare, а не проблему Node.js или БД.

Проверить гипотезу можно так (с домашнего Wi-Fi без VPN):

```powershell
Resolve-DnsName crm.gulya-studio.ru
Test-NetConnection crm.gulya-studio.ru -Port 443
curl.exe -I https://crm.gulya-studio.ru --max-time 15
```

Если DNS резолвится в адреса Cloudflare (`104.x`, `172.67.x`, `188.114.x` и т.п.), а TCP/443 не устанавливается или TLS обрывается — это фильтрация Cloudflare, а не приложение.

### 7.2. Рекомендуемая схема: российский VPS + Caddy + Tailscale

```
Клиент в РФ
   │ HTTPS 443
   ▼
VPS в РФ (публичный IPv4, Ubuntu 24.04)
   │ Caddy: Let's Encrypt, reverse_proxy
   │ приватная сеть Tailscale
   ▼
Windows-сервер 100.75.40.93:4173 (Node.js CRM)
```

Почему так:

- VPS с российским IP и нормальным пирингом открывается из РФ без VPN.
- Caddy автоматически получает и продлевает Let's Encrypt-сертификат.
- Tailscale уже установлен на Windows-сервере; VPS просто добавляется в тот же tailnet. Не нужен проброс портов и белый IP у домашнего/офисного провайдера.
- 4173 не публикуется в интернет: снаружи доступен только 443 на VPS.
- HTTPS нужен для PWA, push, камеры/микрофона и безопасных cookie.

Если Tailscale на VPS недоступен или не устраивает — вариант с WireGuard описан в 7.6.

### 7.3. Пошагово

#### Шаг 1. VPS

- Ubuntu 24.04 LTS, 1 vCPU, 1 ГБ RAM, 10–20 ГБ SSD (Caddy + логи, без БД).
- Публичный IPv4. Провайдер — любой российский с нормальной репутацией IP (Timeweb, Selectel, Beget, Reg.ru и т.п.); главное — проверить, что IP не в блок-листах и что из вашей сети он открывается.
- Открыть в firewall только 22, 80, 443. 4173 наружу не открывать.

#### Шаг 2. DNS

- В DNS-панели домена `gulya-studio.ru` создать A-запись:
  ```
  crm.gulya-studio.ru.   300   IN   A   <PUBLIC_IP_VPS>
  ```
- Если домен обслуживается Cloudflare: переключить запись в режим **DNS only** (серое облако), не proxied. Иначе трафик снова пойдёт через Cloudflare, и проблема останется.
- Если Cloudflare DNS сам по себе не резолвится из РФ — перенести зону на DNS регистратора или российский DNS-провайдер. Запись A при этом не меняется.
- Старый туннель оставить как аварийный канал на отдельном имени, например `backup.gulya-studio.ru`, но сотрудникам его не выдавать.

Проверка:

```powershell
Resolve-DnsName crm.gulya-studio.ru
# Должен вернуться IP VPS, а не Cloudflare
```

#### Шаг 3. Tailscale на VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

В админке Tailscale подтвердить машину. Проверить с VPS доступность CRM:

```bash
curl -I http://100.75.40.93:4173/api/health
```

Ожидается `200 OK`. Если нет — проверить, что Windows-сервер в том же tailnet и что firewall Windows разрешает 4173 из tailnet.

#### Шаг 4. Caddy на VPS

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
crm.gulya-studio.ru {
    encode zstd gzip

    reverse_proxy 100.75.40.93:4173 {
        flush_interval -1
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }

    log {
        output file /var/log/caddy/crm.log
        format console
    }
}
```

`flush_interval -1` отключает буферизацию ответа — важно для SSE/стриминга и больших загрузок. Caddy по умолчанию не ставит жёсткий лимит на тело запроса; дополнительно ничего не ограничиваем.

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Проверка:

```bash
curl -I https://crm.gulya-studio.ru
curl -I https://crm.gulya-studio.ru/api/health
```

Сертификат должен быть валидным, `HTTP/2 200`.

#### Шаг 5. Настройки CRM на Windows-сервере

В `C:\PositiveVector\.env`:

```dotenv
PORT=4173
DB_PATH=data/positive_vector.db
UPLOAD_DIR=uploads/
HOST=0.0.0.0
TRUST_PROXY=1
COOKIE_SECURE=true
```

`COOKIE_SECURE=true` обязателен, иначе cookie не будут передаваться по HTTPS через прокси. `TRUST_PROXY=1` уже стоит по умолчанию, но лучше зафиксировать.

Перезапустить CRM (служба/процесс, которым она запущена). Проверить локально:

```powershell
curl.exe -I http://localhost:4173/api/health
```

#### Шаг 6. Firewall Windows

Если 4173 слушает `0.0.0.0`, ограничить доступ только tailnet:

```powershell
New-NetFirewallRule `
  -DisplayName "PV CRM via Tailscale" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 4173 `
  -RemoteAddress 100.64.0.0/10 `
  -Action Allow
```

Правило «разрешить всем» на 4173 лучше удалить/отключить. Проверить, что снаружи `http://<public-ip>:4173` недоступен.

#### Шаг 7. Проверка из РФ без VPN

С телефона/ноутбука в обычной сети:

1. `https://crm.gulya-studio.ru` открывается, сертификат валиден.
2. Вход `director` / пароль выполняется.
3. Загружается фото 20 МБ.
4. PWA устанавливается, push-уведомления включаются.
5. В DevTools → Network нет запросов к `cloudflare`/`trycloudflare`.

### 7.4. Если Tailscale недоступен

Вариант A: WireGuard между VPS и Windows.

VPS `/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <PRIVATE_KEY_VPS>

[Peer]
PublicKey = <PUBLIC_KEY_WINDOWS>
AllowedIPs = 10.8.0.2/32
```

Windows-клиент:

```ini
[Interface]
PrivateKey = <PRIVATE_KEY_WINDOWS>
Address = 10.8.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <PUBLIC_KEY_VPS>
Endpoint = <PUBLIC_IP_VPS>:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

Установить WireGuard for Windows, импортировать туннель, поднять. В Caddy заменить upstream на `10.8.0.2:4173`. На VPS открыть UDP 51820.

Вариант B: публичный IP/проброс порта. Если провайдер даёт статический белый IP, можно поставить Caddy на Windows и пробросить 80/443 на роутере. Но это зависит от провайдера, хуже с безопасностью и сложнее в обслуживании; VPS предпочтительнее.

### 7.5. Что будет с Cloudflare

- Cloudflare Tunnel можно оставить как резервный путь, но не как основной.
- Если DNS-зона остаётся на Cloudflare, A-запись на VPS должна быть **DNS only**.
- Не использовать `*.trycloudflare.com` для постоянной работы: эти домены часто недоступны из РФ.
- Если позже понадобится защита от DDoS, можно поставить перед VPS российский scrubbing-сервис, но не Cloudflare-proxy по умолчанию.

### 7.6. Приёмка по замечанию 5

- [ ] С домашнего Wi-Fi без VPN `https://crm.gulya-studio.ru` открывается и логин работает.
- [ ] С мобильного интернета другого оператора тоже открывается.
- [ ] Сертификат валиден, HSTS включён.
- [ ] `http://<public-ip>:4173` снаружи недоступен.
- [ ] Caddy переживает перезагрузку VPS (`systemctl is-enabled caddy`).
- [ ] Tailscale/WireGuard поднимается автоматически после перезагрузки Windows-сервера.
- [ ] Push и PWA работают по HTTPS.
- [ ] Есть резервный доступ через SSH/тunnel на случай падения VPS.

## 8. Порядок внедрения и релизы

**Правило:** VPN, VPS, Caddy и Tailscale трогаются только в самом конце, после того как весь прикладной код и схема приведены к конечному виду и проверены на копии БД.

Порядок приоритетов именно такой: сначала мелкие и средние прикладные фиксы, затем более крупные изменения БД/UI/API, и только в последнюю очередь — настройка сервера, VPS, DNS, Tailscale и VPN-доступа.

### Этап 0. Подготовка (0,5 дня)

1. Снять бэкап:
   ```powershell
   Copy-Item C:\PositiveVector\data\positive_vector.db C:\PositiveVector\backups\positive_vector_2026-11-21.db
   Compress-Archive -Path C:\PositiveVector\uploads -DestinationPath C:\PositiveVector\backups\uploads_2026-11-21.zip
   ```
2. Создать ветку `feature/improvements-2026-11`.
3. Прогнать текущие тесты: `npm run lint`, `npm test`.
4. Развернуть копию на тестовом порту (например, 4174) и копию БД, чтобы не проверять миграции на живой базе.

### Этап 1. Чистая БД и схема (P0)

- Применить миграции `013`–`017` (`npm run migrate`).
- Запустить `npm run reset:data -- --list`, проверить ровно 4 учётки.
- Прописать `KEEP_LOGINS` в `.env`, сделать dry-run, затем `--yes --purge-uploads`.
- Убрать `KEEP_LOGINS` из `.env`.
- Проверить: 4 пользователя, нет `accounting_documents`, `chat_push_subscriptions`, `material_legacy_issued`, `chat_history_after`, `payment_method`; есть `documents`, `push_subscriptions`, `chat_room_members`.

### Этап 2. Медиа и большие файлы (P0, замечания 1 и 6)

- `orders.ts`: MIME видео, лимиты, Range, `res.sendFile`, `kind`.
- `chat.ts`/`documents.ts`: diskStorage, лимиты, сигнатуры.
- `src/lib/upload.ts`, `OrderModals.tsx`.
- `vite.config.ts` → `registerType: 'prompt'`, баннер обновления.
- Тесты на iPhone и Android.

### Этап 3. Чат (P1, замечание 4)

- Миграция `015_chat_reply.sql`.
- API reply, видео, превью.
- Push через `push_subscriptions` (не `chat_push_subscriptions`).
- UI: ответ, Enter/Shift+Enter, просмотрщик.
- Тесты в Chrome/Safari.

### Этап 4. Документы (P1, замечание 3)

- Миграция `014_document_categories.sql` (применяется до `017`, работает со старым именем `accounting_documents`).
- API категорий, перемещение, удаление в `server/routes/documents.ts`.
- Новый `DocumentsView`, вкладки «Акты»/«Чертежи».
- Переименование в навигации и правах (`documentsAccess`, `documents.access`).

### Этап 5. Push (P1, замечание 2)

- Миграция `013_push_subscriptions.sql`.
- `services/push.ts`, `routes/push.ts`.
- Hook в `notifyUser`, чат через общий сервис.
- SW, клиентская кнопка, deep links.
- Тесты Chrome/Safari/iOS PWA.

### Этап 6. Зарплаты и финансы (P2, замечание 7)

- `016_salary_indexes.sql`.
- API `/summary` (разбивка), `/ledger`, `/monthly`.
- UI: сводная таблица, карточка долга, журнал, месяцы.
- Удаление способов оплаты из `EmployeesView`, `FinanceView`, `OrderModals`, `EmployeeSalaryView`.
- Сверка итогов до/после на копии БД.

### Этап 7. Доступ без VPN (P0, инфраструктура — ПОСЛЕДНИЙ)

- VPS, DNS, Tailscale/WireGuard, Caddy, `COOKIE_SECURE=true`.
- Проверка из РФ без VPN.
- Только после этого включать PWA/push на постоянной основе.

---


## 9. Тестирование

### 9.1. Автоматические проверки

```bash
npm run lint
npm test
npm run build
```

Перед релизом — `npm run test:network` и `npm run test:load`, если они не требуют внешней инфраструктуры.

### 9.2. Ручные сценарии

| Сценарий | Ожидание |
|---|---|
| iPhone, 10 фото + 2 видео | все загрузились, прогресс, нет вечного sync |
| Видео > 100 МБ, плохая сеть | 3 попытки, затем «Повторить», без зависания |
| Завершённый заказ | добавление фото/видео в «Файлы» работает |
| Чат, ответ на сообщение | цитата, переход к исходному, удаление родителя |
| Чат, Enter/Shift+Enter | отправка/перенос, нет ложных срабатываний |
| Чат, фото/видео | превью, воспроизведение, перемотка |
| Документы | «Акты»/«Чертежи», активная вкладка, загрузка > 12 МБ |
| Push Chrome | задача и чат, клик ведёт в нужный раздел |
| Push Safari macOS | то же |
| Push iPhone PWA | то же, при закрытом приложении |
| Из РФ без VPN | сайт, логин, загрузка |
| Зарплаты | долг = начисления − выплаты, журнал, месяцы |
| Финансы | нет выбора способа/счёта, суммы сохраняются |

### 9.3. Проверка данных после миграций

```sql
-- Все старые документы получили категорию
SELECT category, COUNT(*) FROM accounting_documents GROUP BY category;

-- Нет потерянных reply
SELECT COUNT(*) FROM chat_messages WHERE reply_to_id IS NOT NULL;

-- Подписки перенесены
SELECT COUNT(*) FROM push_subscriptions;

-- Суммы по сотрудникам сходятся
SELECT
  (SELECT COALESCE(SUM(amount_kopecks),0) FROM salary_accruals) AS accrued,
  (SELECT COALESCE(SUM(amount_kopecks),0) FROM salary_payouts) AS paid;
```

---

## 10. Риски и откат

| Риск | Мера |
|---|---|
| Большие файлы забивают диск | мониторинг свободного места, `MAX_UPLOAD_BYTES`, очистка старых вложений, алерт при < 10 ГБ |
| iPhone обрывает загрузку при блокировке экрана | Wake Lock, прямой upload, повтор, инструкция «не блокировать экран» |
| Caddy/VPS — единая точка отказа | второй A-запись/резервный туннель, мониторинг, SSH-доступ |
| Потеря push-подписок | миграция копирует старые, при 404/410 удаляет только битые |
| Ошибка в миграции | бэкап БД, миграции только добавляющие, тест на копии |
| Расхождение финансов | сверка `salary_accruals`/`salary_payouts` до и после, экспорт XLSX |
| Старые PWA не обновились | `registerType: 'prompt'`, баннер, инструкция закрыть/открыть приложение |
| Safari не поддерживает push | проверить iOS 16.4+, PWA на «Домой», HTTPS |

**Откат:**

1. Остановить CRM.
2. Вернуть предыдущий билд (`git checkout <previous>` + `npm ci` + `npm run build`).
3. Вернуть БД из бэкапа, если миграция уже applied и откат кода несовместим.
4. Вернуть DNS на резервный туннель, если проблема в VPS.
5. Запустить, проверить `/api/health`, логин, список заказов.

---

## Приложение A. Порядок миграций

Текущий максимум — `012_yandex_connection.sql`. Новые файлы:

| Файл | Назначение |
|---|---|
| `013_push_subscriptions.sql` | общие push-подписки + перенос из чата |
| `014_document_categories.sql` | `accounting_documents.category` |
| `015_chat_reply.sql` | `chat_messages.reply_to_id` |
| `016_salary_indexes.sql` | индексы для журнала и месячных сводок |

Миграции применяются автоматически при старте (`server/db.ts:runMigrations`). Перед первым запуском новой версии — бэкап.

---

## Приложение B. Карта изменений по файлам

### Сервер

| Файл | Что меняется |
|---|---|
| `server/routes/orders.ts` | MIME видео, лимиты, Range, `res.sendFile`, `kind` |
| `server/routes/chat.ts` | diskStorage, видео, `reply_to_id`, общий push |
| `server/routes/documents.ts` | diskStorage, категории, перемещение, удаление (бывший `accounting.ts`) |
| `server/routes/salaries.ts` | разбивка по источникам, `/ledger`, `/monthly` |
| `server/routes/finance.ts` | `payment_method` удалён из API, INSERT и SELECT |
| `server/routes/push.ts` | новый роутер подписок |
| `server/services/push.ts` | новый сервис отправки |
| `server/security.ts` | `notifyUser` → push |
| `server/app.ts` | монтаж `/api/push`, текст ошибки загрузки |
| `server.ts` | таймауты больших загрузок |

### Клиент

| Файл | Что меняется |
|---|---|
| `src/lib/upload.ts` | новый helper прямого upload |
| `src/lib/push.ts` | новый helper подписки |
| `src/lib/apiTransport.ts` | экспорт `getCsrfToken` |
| `src/views/OrderModals.tsx` | multiple, прогресс, видео, повтор, убран способ оплаты |
| `src/views/ChatView.tsx` | reply, Enter, превью, видео |
| `src/views/DocumentsView.tsx` | «Документы», вкладки, удаление, перемещение (бывший `AccountingView.tsx`) |
| `src/views/EmployeesView.tsx` | сводка, долг, журнал, месяцы, выплата |
| `src/views/FinanceView.tsx` | убрать способы оплаты |
| `src/views/EmployeeSalaryView.tsx` | убрать способ выплаты |
| `src/views/SettingsView.tsx` | кнопка push |
| `src/components/AppShell.tsx` | «Документы», баннер обновления |
| `src/App.tsx` | deep links `?task=`/`?order=` |
| `src/main.tsx` | `registerType: 'prompt'` |
| `vite.config.ts` | `registerType: 'prompt'` |
| `public/chat-push.js` | url/tag/клик/фокус |

### Инфраструктура

| Файл/место | Что меняется |
|---|---|
| `deployment/vps/Caddyfile` | новый пример конфигурации |
| `deployment/vps/README.md` | инструкция VPS + Tailscale + DNS |
| `.env` на сервере | `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `MAX_UPLOAD_BYTES=0` |
| DNS | A-запись на VPS, Cloudflare DNS only |

---

## Приложение C. Чек-лист перед выкладкой

- [ ] Бэкап БД и `uploads/`.
- [ ] Миграции проверены на копии.
- [ ] `npm run lint` без ошибок.
- [ ] `npm test` зелёный.
- [ ] `npm run build` успешен.
- [ ] Проверены вход, заказы, чат, документы, финансы.
- [ ] Проверена загрузка > 12 МБ.
- [ ] Проверен iPhone/PWA.
- [ ] Проверен push в Chrome и Safari.
- [ ] Проверен доступ из РФ без VPN.
- [ ] Есть план отката и доступ к резервному каналу.

---

## Приложение D. Что сознательно не делается в этой итерации

- Не делается несколько файлов/вложений в одном сообщении чата. Для этого нужна отдельная таблица `chat_message_files`, отдельный UI выбора нескольких файлов и отдельная логика очистки. В текущей задаче оставляем один файл на сообщение, но уже поддерживаем и фото, и видео.
- Не делается chunked/resumable upload для файлов больше 1 ГБ. Для текущей задачи используется прямой `multipart/form-data` upload с таймаутом на сервере, повтором до 3 раз и понятной ошибкой. Chunked/resumable не оставляем «на потом»: он сознательно не внедряется в этом релизе.
- Не удаляется Cloudflare Tunnel полностью. После перехода на российский VPS + Caddy он остаётся только как аварийный резервный канал и не выдаётся сотрудникам как основной адрес.
- Не меняются пароли существующих 4 учётных записей. Очистка данных сохраняет `users`, `user_permissions`, `settings` и `yandex_connection`, поэтому доступ администраторов и монтажника остаётся.
- Не переносятся старые бизнес-данные в новую схему. Заказы, клиенты, чаты, склад, финансы, документы и уведомления очищаются; CRM стартует с чистой БД и 4 рабочими учётками.
- Не выполняются настройки VPS/Caddy/Tailscale в начале плана. Инфраструктурный этап намеренно стоит последним, после всех прикладных изменений, миграций и очистки БД.

---

**Итог:** после выполнения плана CRM открывается из РФ без VPN, принимает фото/видео и большие документы, не зависает на iPhone, поддерживает ответы и превью в чате, имеет раздел «Документы» с актами и чертежами, присылает push по задачам и чатам, а зарплатный блок показывает реальный долг сотрудника и прозрачную историю операций без «счетов» и способов перевода.
