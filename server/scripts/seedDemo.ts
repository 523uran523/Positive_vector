import 'dotenv/config';
import crypto from 'node:crypto';
import { openDatabase, runMigrations, withTransaction } from '../db.ts';
import { ALL_PERMISSIONS, generateRandomPassword, hashPassword, writeAuditLog } from '../security.ts';

const db = openDatabase();
runMigrations(db);

const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
if (userCount > 0 && !process.argv.includes('--force')) {
  console.log('В базе уже есть пользователи. Используйте --force только на пустой тестовой базе.');
  db.close();
  process.exit(0);
}

const adminPass = generateRandomPassword(12);
const empPass = generateRandomPassword(10);
const now = new Date().toISOString();
const today = now.slice(0, 10);
const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

withTransaction(db, () => {
  const adminId = crypto.randomUUID();
  const empId = crypto.randomUUID();

  db.prepare(
    `INSERT INTO users (id, login, password_hash, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, created_at, updated_at)
     VALUES (?, 'director', ?, 'admin', 'Соколов Артём Сергеевич', '+7 912 555-01-10', 'Руководитель производства', 400000, 1, 1, ?, ?)`
  ).run(adminId, hashPassword(adminPass), now, now);

  db.prepare(
    `INSERT INTO users (id, login, password_hash, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, created_at, updated_at)
     VALUES (?, 'montazh1', ?, 'employee', 'Волков Денис Павлович', '+7 912 555-01-44', 'Старший монтажник', 320000, 1, 1, ?, ?)`
  ).run(empId, hashPassword(empPass), now, now);

  const permStmt = db.prepare('INSERT INTO user_permissions (user_id, permission_key, granted) VALUES (?, ?, ?)');
  const empAllowed = new Set(['orders.edit_assigned', 'warehouse.take', 'clients.view_all']);
  for (const p of ALL_PERMISSIONS) {
    permStmt.run(adminId, p, 1);
    permStmt.run(empId, p, empAllowed.has(p) ? 1 : 0);
  }

  // Companies & contacts
  const comp1 = crypto.randomUUID();
  const comp2 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO companies (id, name, inn, requisites, address, phone, email, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    comp1,
    'ТЦ «Галерея Город»',
    '7708123456',
    'р/с 40702810400000012345 в ПАО Сбербанк',
    'ул. Ленина, 48',
    '+7 495 220-11-22',
    'marketing@galereya-gorod.ru',
    'Постоянный заказчик фасадных баннеров и сезонных декораций',
    now
  );
  db.prepare(
    `INSERT INTO companies (id, name, inn, requisites, address, phone, email, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    comp2,
    'Сеть кофеен «Бодрость»',
    '7714987654',
    'ИП Захарова О.В.',
    'пр-т Мира, 15',
    '+7 495 811-30-90',
    'zakaz@bodrost.coffee',
    'Световые вывески и интерьерные стенды',
    now
  );

  const ct1 = crypto.randomUUID();
  const ct2 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO contacts (id, company_id, full_name, phone, email, position, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ct1, comp1, 'Мельникова Ирина Олеговна', '+7 916 333-20-10', 'melnikova@galereya-gorod.ru', 'Маркетинг-директор', 'Пропуск на разгрузку со двора', now);
  db.prepare(
    `INSERT INTO contacts (id, company_id, full_name, phone, email, position, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ct2, comp2, 'Захарова Ольга Викторовна', '+7 926 700-45-12', 'zaharova@bodrost.coffee', 'Управляющая', '', now);

  // Materials
  const matBanner = crypto.randomUUID();
  const matBrus = crypto.randomUUID();
  const matScrews = crypto.randomUUID();
  db.prepare(
    `INSERT INTO materials (id, name, category, unit, quantity_milli, purchase_price_kopecks, min_threshold_milli, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(matBanner, 'Баннерная ткань Frontlit 440 г', 'Баннерная ткань', 'м²', 120000, 38000, 25000, now);
  db.prepare(
    `INSERT INTO materials (id, name, category, unit, quantity_milli, purchase_price_kopecks, min_threshold_milli, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(matBrus, 'Брус сухой 50×50 мм', 'Брус и пиломатериалы', 'м', 85000, 14000, 20000, now);
  db.prepare(
    `INSERT INTO materials (id, name, category, unit, quantity_milli, purchase_price_kopecks, min_threshold_milli, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(matScrews, 'Люверсы 10 мм + стяжки', 'Крепёж и саморезы', 'уп', 18000, 45000, 5000, now);

  // Tools
  const toolPerforator = crypto.randomUUID();
  const toolLadder = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tools (id, name, color, icon_emoji, tracking_mode, total_qty, available_qty, notes, created_at)
     VALUES (?, 'Перфоратор Bosch GBH', '#0071E3', '🔨', 'individual', 2, 1, 'С буром 8/10 мм в кейсе', ?)`
  ).run(toolPerforator, now);
  db.prepare(
    `INSERT INTO tools (id, name, color, icon_emoji, tracking_mode, total_qty, available_qty, notes, created_at)
     VALUES (?, 'Стремянка 3-секционная', '#FF9F0A', '🪜', 'quantity', 4, 4, 'Алюминиевая 6 м', ?)`
  ).run(toolLadder, now);

  const inst1 = crypto.randomUUID();
  const inst2 = crypto.randomUUID();
  db.prepare(`INSERT INTO tool_instances (id, tool_id, serial_number, status) VALUES (?, ?, 'ПЕРФ-001', 'issued')`).run(inst1, toolPerforator);
  db.prepare(`INSERT INTO tool_instances (id, tool_id, serial_number, status) VALUES (?, ?, 'ПЕРФ-002', 'available')`).run(inst2, toolPerforator);

  // Order 1: Multi-day active order
  const ord1 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO orders (id, order_number, title, status, priority, scheduled_at, company_id, client_contact_id, site_contact_name, site_contact_phone, address, description, price_kopecks, tags_json, comments, created_by, created_at, updated_at)
     VALUES (?, 'ПВ-2601', 'Фасадный баннер 6×3 м + каркас', 'in_progress', 'high', ?, ?, ?, 'Охрана ТЦ (КПП-2)', '+7 916 333-20-99', 'ул. Ленина, 48 (центральный вход)', 'Сборка бруса и натяжка баннера по периметру.', 6800000, ?, 'Монтаж с 09:00 до 18:00', ?, ?, ?)`
  ).run(ord1, `${today}T09:30`, comp1, ct1, JSON.stringify(['Баннер', 'Срочно']), adminId, now, now);

  db.prepare('INSERT INTO order_assignees (order_id, user_id) VALUES (?, ?)').run(ord1, empId);

  const v1 = crypto.randomUUID();
  const v2 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO order_visits (id, order_id, title, scheduled_at, description, status, created_at)
     VALUES (?, ?, 'День 1: Сборка каркаса', ?, 'Завезти брус и закрепить раму', 'completed', ?)`
  ).run(v1, ord1, `${yesterday}T10:00`, now);
  db.prepare(
    `INSERT INTO order_visits (id, order_id, title, scheduled_at, description, status, created_at)
     VALUES (?, ?, 'День 2: Натяжка баннера', ?, 'Натяжка баннерной ткани и финальное фото', 'planned', ?)`
  ).run(v2, ord1, `${today}T09:30`, now);

  db.prepare(
    `INSERT INTO visit_assignees (id, visit_id, user_id, is_lead, wage_kopecks, wage_assigned_at, wage_assigned_by)
     VALUES (?, ?, ?, 1, 450000, ?, ?)`
  ).run(crypto.randomUUID(), v1, empId, now, adminId);
  db.prepare(
    `INSERT INTO visit_assignees (id, visit_id, user_id, is_lead, wage_kopecks)
     VALUES (?, ?, ?, 1, NULL)`
  ).run(crypto.randomUUID(), v2, empId);

  db.prepare('UPDATE tool_instances SET holder_user_id = ?, current_order_id = ?, issued_at = ? WHERE id = ?').run(
    empId,
    ord1,
    now,
    inst1
  );

  // Order 2: Unplanned backlog order
  const ord2 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO orders (id, order_number, title, status, priority, scheduled_at, company_id, client_contact_id, address, description, price_kopecks, tags_json, created_by, created_at, updated_at)
     VALUES (?, 'ПВ-2602', 'Световая вывеска «Бодрость» (черновик)', 'new', 'normal', NULL, ?, ?, 'пр-т Мира, 15', 'Согласование макета и точной даты выезда.', 4200000, ?, ?, ?, ?)`
  ).run(ord2, comp2, ct2, JSON.stringify(['Вывеска']), adminId, now, now);

  // Order 3: Scheduled tomorrow
  const ord3 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO orders (id, order_number, title, status, priority, scheduled_at, company_id, client_contact_id, address, description, price_kopecks, tags_json, created_by, created_at, updated_at)
     VALUES (?, 'ПВ-2603', 'Интерьерная фотозона для выставки', 'new', 'normal', ?, ?, ?, 'ул. Ленина, 48, 2 этаж', 'Монтаж декоративной стенки после закрытия ТЦ.', 5400000, ?, ?, ?, ?)`
  ).run(ord3, `${tomorrow}T21:00`, comp1, ct1, JSON.stringify(['Декорации', 'Ночной монтаж']), adminId, now, now);
  db.prepare('INSERT INTO order_assignees (order_id, user_id) VALUES (?, ?)').run(ord3, empId);
  const v3 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO order_visits (id, order_id, title, scheduled_at, description, status, created_at)
     VALUES (?, ?, 'Ночной монтаж фотозоны', ?, 'Сборка конструкции и подсветки', 'planned', ?)`
  ).run(v3, ord3, `${tomorrow}T21:00`, now);
  db.prepare(`INSERT INTO visit_assignees (id, visit_id, user_id, is_lead, wage_kopecks) VALUES (?, ?, ?, 1, NULL)`).run(
    crypto.randomUUID(),
    v3,
    empId
  );

  // Completed workshop shift + salary accruals + partial payout + client payment + expense
  const shiftId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO workshop_shifts (id, user_id, started_at, ended_at, work_done, status, rate_snapshot_kopecks, created_at)
     VALUES (?, ?, ?, ?, 'Сварка и покраска рамы под фасадный баннер 6×3 м, проклейка карманов.', 'completed', 320000, ?)`
  ).run(shiftId, empId, `${yesterday}T09:00:00.000Z`, `${yesterday}T17:30:00.000Z`, now);

  db.prepare(
    `INSERT INTO salary_accruals (id, user_id, source_type, source_id, amount_kopecks, description, created_by, created_at)
     VALUES (?, ?, 'shift', ?, 320000, ?, ?, ?)`
  ).run(crypto.randomUUID(), empId, shiftId, `Смена в цеху (${yesterday})`, adminId, now);

  db.prepare(
    `INSERT INTO salary_accruals (id, user_id, source_type, source_id, amount_kopecks, description, created_by, created_at)
     VALUES (?, ?, 'visit', ?, 450000, 'Монтаж ПВ-2601 · День 1: Сборка каркаса', ?, ?)`
  ).run(crypto.randomUUID(), empId, v1, adminId, now);

  db.prepare(
    `INSERT INTO salary_payouts (id, user_id, amount_kopecks, paid_at, comment, created_by, created_at)
     VALUES (?, ?, 300000, ?, 'Аванс за смену и выезд', ?, ?)`
  ).run(crypto.randomUUID(), empId, today, adminId, now);

  db.prepare(
    `INSERT INTO client_payments (id, order_id, company_id, contact_id, amount_kopecks, payment_type, paid_at, comment, created_by, created_at)
     VALUES (?, ?, ?, ?, 3500000, 'advance', ?, 'Предоплата 50% по счёту', ?, ?)`
  ).run(crypto.randomUUID(), ord1, comp1, ct1, yesterday, adminId, now);

  db.prepare(
    `INSERT INTO expenses (id, category, amount_kopecks, expense_date, description, order_id, created_by, created_at)
     VALUES (?, 'fuel', 240000, ?, 'Доставка бруса на объект ТЦ Галерея', ?, ?, ?)`
  ).run(crypto.randomUUID(), yesterday, ord1, adminId, now);

  writeAuditLog(db, adminId, 'system', 'seed', 'demo_seed_applied', {});
});

console.log('\n=== Демо-данные «Позитив Вектор» загружены ===');
console.log(`Администратор -> Логин: director   | Временный пароль: ${adminPass}`);
console.log(`Сотрудник     -> Логин: montazh1   | Временный пароль: ${empPass}`);
console.log('Пароли сгенерированы случайно — сохраните их прямо сейчас.\n');

db.close();
