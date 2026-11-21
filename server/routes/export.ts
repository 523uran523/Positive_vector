import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import { requireAdmin } from '../middleware.ts';

function toRub(kopecks: number | null | undefined): number {
  return Number(((Number(kopecks || 0)) / 100).toFixed(2));
}

function toQty(milli: number | null | undefined): number {
  return Number(((Number(milli || 0)) / 1000).toFixed(3));
}

function inPeriod(dateIso: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!dateIso) return false;
  const d = String(dateIso).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function addSheet(wb: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>): void {
  const safeName = name.slice(0, 31);
  const ws = rows.length > 0 ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['Нет данных за выбранный период']]);
  XLSX.utils.book_append_sheet(wb, ws, safeName);
}

function sendWorkbook(res: express.Response, wb: XLSX.WorkBook, filenameBase: string): void {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const asciiName = `${filenameBase}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"`);
  res.send(buf);
}

export function createExportRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/database.xlsx', requireAdmin, (req, res) => {
    const from = req.query.from ? String(req.query.from) : '';
    const to = req.query.to ? String(req.query.to) : '';
    const wb = XLSX.utils.book_new();

    const orders = (
      db
        .prepare(
          `SELECT o.*, comp.name as company_name, c.full_name as contact_name
           FROM orders o
           LEFT JOIN companies comp ON comp.id = o.company_id
           LEFT JOIN contacts c ON c.id = o.client_contact_id
           ORDER BY o.created_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((o) => inPeriod(String(o.scheduled_at || o.created_at), from, to))
      .map((o) => ({
        'Номер': o.order_number,
        'Название': o.title,
        'Статус': o.status,
        'Дата и время': o.scheduled_at || 'Не запланирован',
        'Компания': o.company_name || '',
        'Контакт клиента': o.contact_name || '',
        'Контакт на объекте': o.site_contact_name,
        'Телефон на объекте': o.site_contact_phone,
        'Адрес': o.address,
        'Сумма заказа, ₽': toRub(Number(o.price_kopecks)),
        'Переоценка себестоимости, ₽':
          o.cost_override_kopecks !== null && o.cost_override_kopecks !== undefined
            ? toRub(Number(o.cost_override_kopecks))
            : '',
        'Создан': o.created_at,
      }));
    addSheet(wb, 'Заказы', orders);

    const visits = (
      db
        .prepare(
          `SELECT ov.*, o.order_number, u.full_name as completed_by_name
           FROM order_visits ov
           JOIN orders o ON o.id = ov.order_id
           LEFT JOIN users u ON u.id = ov.completed_by
           ORDER BY ov.scheduled_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((v) => inPeriod(String(v.scheduled_at), from, to))
      .map((v) => ({
        'Заказ': v.order_number,
        'Этап / Выезд': v.title,
        'Дата': v.scheduled_at,
        'Статус': v.status,
        'Факт начало': v.actual_start_at || '',
        'Факт конец': v.actual_end_at || '',
        'Завершил': v.completed_by_name || '',
      }));
    addSheet(wb, 'Выезды', visits);

    const companies = (
      db.prepare('SELECT * FROM companies ORDER BY name ASC').all() as Array<Record<string, unknown>>
    ).map((c) => ({
      'Название': c.name,
      'ИНН': c.inn,
      'Телефон': c.phone,
      'Email': c.email,
      'Адрес': c.address,
      'Реквизиты': c.requisites,
      'Заметки': c.notes,
    }));
    addSheet(wb, 'Компании', companies);

    const contacts = (
      db
        .prepare(
          `SELECT c.*, comp.name as company_name
           FROM contacts c LEFT JOIN companies comp ON comp.id = c.company_id
           ORDER BY c.full_name ASC`
        )
        .all() as Array<Record<string, unknown>>
    ).map((c) => ({
      'ФИО': c.full_name,
      'Компания': c.company_name || '',
      'Должность': c.position,
      'Телефон': c.phone,
      'Email': c.email,
      'Заметки': c.notes,
    }));
    addSheet(wb, 'Контакты', contacts);

    // Strictly exclude password_hash, sessions, tokens
    const users = (
      db
        .prepare(
          `SELECT id, login, role, full_name, phone, position, shift_rate_kopecks, is_active, created_at
           FROM users ORDER BY full_name ASC`
        )
        .all() as Array<Record<string, unknown>>
    ).map((u) => ({
      'ФИО': u.full_name,
      'Логин': u.login,
      'Роль': u.role === 'admin' ? 'Администратор' : 'Сотрудник',
      'Должность': u.position,
      'Телефон': u.phone,
      'Ставка за смену, ₽': toRub(Number(u.shift_rate_kopecks)),
      'Активен': u.is_active === 1 ? 'Да' : 'Заблокирован',
      'Создан': u.created_at,
    }));
    addSheet(wb, 'Сотрудники', users);

    const shifts = (
      db
        .prepare(
          `SELECT ws.*, u.full_name as employee_name
           FROM workshop_shifts ws JOIN users u ON u.id = ws.user_id
           ORDER BY ws.started_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((s) => inPeriod(String(s.started_at), from, to))
      .map((s) => ({
        'Сотрудник': s.employee_name,
        'Начало': s.started_at,
        'Завершение': s.ended_at || '',
        'Статус': s.status === 'active' ? 'Активна' : 'Завершена',
        'Ставка (снимок), ₽': toRub(Number(s.rate_snapshot_kopecks)),
        'Выполненная работа': s.work_done,
      }));
    addSheet(wb, 'Смены в цеху', shifts);

    const accruals = (
      db
        .prepare(
          `SELECT sa.*, u.full_name as employee_name
           FROM salary_accruals sa JOIN users u ON u.id = sa.user_id
           ORDER BY sa.created_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((a) => inPeriod(String(a.created_at), from, to))
      .map((a) => ({
        'Дата': String(a.created_at).slice(0, 10),
        'Сотрудник': a.employee_name,
        'Тип': a.source_type,
        'Сумма, ₽': toRub(Number(a.amount_kopecks)),
        'Описание': a.description,
      }));
    addSheet(wb, 'Начисления ЗП', accruals);

    const payouts = (
      db
        .prepare(
          `SELECT sp.*, u.full_name as employee_name
           FROM salary_payouts sp JOIN users u ON u.id = sp.user_id
           ORDER BY sp.paid_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((p) => inPeriod(String(p.paid_at), from, to))
      .map((p) => ({
        'Дата выплаты': p.paid_at,
        'Сотрудник': p.employee_name,
        'Сумма, ₽': toRub(Number(p.amount_kopecks)),
        'Комментарий': p.comment,
      }));
    addSheet(wb, 'Выплаты ЗП', payouts);

    const payments = (
      db
        .prepare(
          `SELECT cp.*, o.order_number, comp.name as company_name
           FROM client_payments cp
           LEFT JOIN orders o ON o.id = cp.order_id
           LEFT JOIN companies comp ON comp.id = cp.company_id
           ORDER BY cp.paid_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((p) => inPeriod(String(p.paid_at), from, to))
      .map((p) => ({
        'Дата': p.paid_at,
        'Заказ': p.order_number || '',
        'Компания': p.company_name || '',
        'Тип': p.payment_type,
        'Сумма, ₽': toRub(Number(p.amount_kopecks)),
        'Комментарий': p.comment,
      }));
    addSheet(wb, 'Платежи клиентов', payments);

    const expenses = (
      db
        .prepare(
          `SELECT e.*, o.order_number
           FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
           ORDER BY e.expense_date DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((e) => inPeriod(String(e.expense_date), from, to))
      .map((e) => ({
        'Дата': e.expense_date,
        'Категория': e.category,
        'Сумма, ₽': toRub(Number(e.amount_kopecks)),
        'Заказ': e.order_number || '',
        'Описание': e.description,
      }));
    addSheet(wb, 'Расходы', expenses);

    const materials = (
      db.prepare('SELECT * FROM materials ORDER BY category ASC, name ASC').all() as Array<Record<string, unknown>>
    ).map((m) => ({
      'Название': m.name,
      'Категория': m.category,
      'Ед. изм.': m.unit,
      'Остаток': toQty(Number(m.quantity_milli)),
      'Цена закупки, ₽': toRub(Number(m.purchase_price_kopecks)),
      'Мин. порог': toQty(Number(m.min_threshold_milli)),
    }));
    addSheet(wb, 'Материалы', materials);

    const tools = (
      db.prepare('SELECT * FROM tools ORDER BY name ASC').all() as Array<Record<string, unknown>>
    ).map((t) => ({
      'Название': t.name,
      'Учёт': t.tracking_mode === 'individual' ? 'По номерам' : 'Количественный',
      'Всего': t.total_qty,
      'На складе': t.available_qty,
      'Примечания': t.notes,
    }));
    addSheet(wb, 'Инструменты', tools);

    const ops = (
      db
        .prepare(
          `SELECT wo.*, m.name as material_name, t.name as tool_name, ti.serial_number as tool_serial,
                  u.full_name as employee_name, o.order_number
           FROM warehouse_operations wo
           LEFT JOIN materials m ON m.id = wo.material_id
           LEFT JOIN tools t ON t.id = wo.tool_id
           LEFT JOIN tool_instances ti ON ti.id = wo.tool_instance_id
           LEFT JOIN users u ON u.id = wo.user_id
           LEFT JOIN orders o ON o.id = wo.order_id
           ORDER BY wo.created_at DESC`
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((op) => inPeriod(String(op.created_at), from, to))
      .map((op) => ({
        'Дата': String(op.created_at).slice(0, 19).replace('T', ' '),
        'Тип объекта': op.item_type === 'material' ? 'Материал' : 'Инструмент',
        'Наименование': op.material_name || op.tool_name || '',
        'Серийный №': op.tool_serial || '',
        'Операция': op.op_type,
        'Количество': toQty(Number(op.qty_milli)),
        'Цена за ед., ₽': toRub(Number(op.unit_cost_kopecks)),
        'Заказ': op.order_number || '',
        'Сотрудник': op.employee_name || '',
        'Примечание': op.note,
      }));
    addSheet(wb, 'Операции склада', ops);

    const dateLabel = new Date().toISOString().slice(0, 10);
    sendWorkbook(res, wb, `pozitiv-vektor-full-${dateLabel}`);
  });

  router.get('/:section.xlsx', requireAdmin, (req, res) => {
    const section = String(req.params.section);
    const from = req.query.from ? String(req.query.from) : '';
    const to = req.query.to ? String(req.query.to) : '';
    const wb = XLSX.utils.book_new();
    const dateLabel = new Date().toISOString().slice(0, 10);

    if (section === 'orders') {
      const rows = (
        db
          .prepare(
            `SELECT o.*, comp.name as company_name
             FROM orders o LEFT JOIN companies comp ON comp.id = o.company_id
             ORDER BY o.created_at DESC`
          )
          .all() as Array<Record<string, unknown>>
      )
        .filter((o) => inPeriod(String(o.scheduled_at || o.created_at), from, to))
        .map((o) => ({
          'Номер': o.order_number,
          'Название': o.title,
          'Статус': o.status,
          'Дата': o.scheduled_at || 'Не запланирован',
          'Компания': o.company_name || '',
          'Адрес': o.address,
          'Сумма, ₽': toRub(Number(o.price_kopecks)),
        }));
      addSheet(wb, 'Заказы', rows);
      sendWorkbook(res, wb, `pozitiv-orders-${dateLabel}`);
      return;
    }

    if (section === 'clients') {
      const companies = (db.prepare('SELECT * FROM companies ORDER BY name ASC').all() as Array<Record<string, unknown>>).map(
        (c) => ({
          'Компания': c.name,
          'ИНН': c.inn,
          'Телефон': c.phone,
          'Email': c.email,
          'Адрес': c.address,
          'Реквизиты': c.requisites,
        })
      );
      const contacts = (
        db
          .prepare(
            `SELECT c.*, comp.name as company_name FROM contacts c LEFT JOIN companies comp ON comp.id = c.company_id`
          )
          .all() as Array<Record<string, unknown>>
      ).map((c) => ({
        'ФИО': c.full_name,
        'Компания': c.company_name || '',
        'Телефон': c.phone,
        'Должность': c.position,
      }));
      addSheet(wb, 'Компании', companies);
      addSheet(wb, 'Контакты', contacts);
      sendWorkbook(res, wb, `pozitiv-clients-${dateLabel}`);
      return;
    }

    if (section === 'warehouse') {
      const materials = (db.prepare('SELECT * FROM materials ORDER BY name ASC').all() as Array<Record<string, unknown>>).map(
        (m) => ({
          'Материал': m.name,
          'Категория': m.category,
          'Ед.': m.unit,
          'Остаток': toQty(Number(m.quantity_milli)),
          'Цена закупки, ₽': toRub(Number(m.purchase_price_kopecks)),
        })
      );
      const tools = (db.prepare('SELECT * FROM tools ORDER BY name ASC').all() as Array<Record<string, unknown>>).map((t) => ({
        'Инструмент': t.name,
        'Режим': t.tracking_mode === 'individual' ? 'Серийный' : 'Количественный',
        'Всего': t.total_qty,
        'Свободно': t.available_qty,
      }));
      addSheet(wb, 'Материалы', materials);
      addSheet(wb, 'Инструменты', tools);
      sendWorkbook(res, wb, `pozitiv-warehouse-${dateLabel}`);
      return;
    }

    if (section === 'salaries') {
      const accruals = (
        db
          .prepare(
            `SELECT sa.*, u.full_name as employee_name FROM salary_accruals sa JOIN users u ON u.id = sa.user_id ORDER BY sa.created_at DESC`
          )
          .all() as Array<Record<string, unknown>>
      )
        .filter((a) => inPeriod(String(a.created_at), from, to))
        .map((a) => ({
          'Дата': String(a.created_at).slice(0, 10),
          'Сотрудник': a.employee_name,
          'Источник': a.source_type,
          'Сумма, ₽': toRub(Number(a.amount_kopecks)),
          'Описание': a.description,
        }));
      const payouts = (
        db
          .prepare(
            `SELECT sp.*, u.full_name as employee_name FROM salary_payouts sp JOIN users u ON u.id = sp.user_id ORDER BY sp.paid_at DESC`
          )
          .all() as Array<Record<string, unknown>>
      )
        .filter((p) => inPeriod(String(p.paid_at), from, to))
        .map((p) => ({
          'Дата': p.paid_at,
          'Сотрудник': p.employee_name,
          'Сумма, ₽': toRub(Number(p.amount_kopecks)),
          'Комментарий': p.comment,
        }));
      addSheet(wb, 'Начисления', accruals);
      addSheet(wb, 'Выплаты', payouts);
      sendWorkbook(res, wb, `pozitiv-salaries-${dateLabel}`);
      return;
    }

    if (section === 'finance') {
      const payments = (
        db
          .prepare(
            `SELECT cp.*, o.order_number, comp.name as company_name
             FROM client_payments cp
             LEFT JOIN orders o ON o.id = cp.order_id
             LEFT JOIN companies comp ON comp.id = cp.company_id
             ORDER BY cp.paid_at DESC`
          )
          .all() as Array<Record<string, unknown>>
      )
        .filter((p) => inPeriod(String(p.paid_at), from, to))
        .map((p) => ({
          'Дата': p.paid_at,
          'Заказ': p.order_number || '',
          'Компания': p.company_name || '',
          'Сумма, ₽': toRub(Number(p.amount_kopecks)),
          'Тип': p.payment_type,
          'Комментарий': p.comment,
        }));
      const expenses = (
        db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC').all() as Array<Record<string, unknown>>
      )
        .filter((e) => inPeriod(String(e.expense_date), from, to))
        .map((e) => ({
          'Дата': e.expense_date,
          'Категория': e.category,
          'Сумма, ₽': toRub(Number(e.amount_kopecks)),
          'Описание': e.description,
        }));
      addSheet(wb, 'Платежи клиентов', payments);
      addSheet(wb, 'Расходы', expenses);
      sendWorkbook(res, wb, `pozitiv-finance-${dateLabel}`);
      return;
    }

    res.status(404).json({ error: 'Неизвестный раздел экспорта.' });
  });

  return router;
}
