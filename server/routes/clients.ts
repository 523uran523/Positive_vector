import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission, writeAuditLog } from '../security.ts';

export function createClientsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const canViewAll =
      user.role === 'admin' ||
      hasPermission(user, 'clients.view_all') ||
      hasPermission(user, 'orders.create');

    if (!canViewAll) {
      res.status(403).json({ error: 'Нет доступа к общей клиентской базе.' });
      return;
    }

    const search = String(req.query.q || '').trim().toLowerCase();

    const companies = db
      .prepare('SELECT * FROM companies ORDER BY name ASC')
      .all() as Array<Record<string, unknown>>;
    const contacts = db
      .prepare(
        `SELECT c.*, comp.name as company_name
         FROM contacts c
         LEFT JOIN companies comp ON comp.id = c.company_id
         ORDER BY c.full_name ASC`
      )
      .all() as Array<Record<string, unknown>>;

    // Compute order history and debt totals per company and contact (admin only sees money totals; employees only order links if permitted)
    const orders = db
      .prepare(
        `SELECT id, order_number, title, status, scheduled_at, company_id, client_contact_id, price_kopecks
         FROM orders ORDER BY created_at DESC`
      )
      .all() as Array<{
      id: string;
      order_number: string;
      title: string;
      status: string;
      scheduled_at: string | null;
      company_id: string | null;
      client_contact_id: string | null;
      price_kopecks: number;
    }>;

    const paymentsByOrder = new Map<string, number>();
    const paymentRows = db
      .prepare('SELECT order_id, SUM(amount_kopecks) as paid FROM client_payments WHERE order_id IS NOT NULL GROUP BY order_id')
      .all() as Array<{ order_id: string; paid: number }>;
    for (const p of paymentRows) {
      paymentsByOrder.set(p.order_id, Number(p.paid || 0));
    }

    const enrichedCompanies = companies
      .filter((c) => {
        if (!search) return true;
        return (
          String(c.name || '').toLowerCase().includes(search) ||
          String(c.phone || '').toLowerCase().includes(search) ||
          String(c.inn || '').toLowerCase().includes(search)
        );
      })
      .map((c) => {
        const compContacts = contacts.filter((ct) => ct.company_id === c.id);
        const compOrders = orders.filter((o) => o.company_id === c.id);
        let totalPrice = 0;
        let totalPaid = 0;
        if (user.role === 'admin') {
          for (const o of compOrders) {
            if (o.status !== 'cancelled') {
              totalPrice += o.price_kopecks;
              totalPaid += paymentsByOrder.get(o.id) || 0;
            }
          }
        }
        return {
          ...c,
          contacts: compContacts,
          orders: compOrders.map((o) => ({
            id: o.id,
            order_number: o.order_number,
            title: o.title,
            status: o.status,
            scheduled_at: o.scheduled_at,
            price_kopecks: user.role === 'admin' ? o.price_kopecks : undefined,
          })),
          debt_kopecks: user.role === 'admin' ? Math.max(0, totalPrice - totalPaid) : undefined,
          total_orders: compOrders.length,
        };
      });

    const enrichedContacts = contacts
      .filter((ct) => {
        if (!search) return true;
        return (
          String(ct.full_name || '').toLowerCase().includes(search) ||
          String(ct.phone || '').toLowerCase().includes(search) ||
          String(ct.company_name || '').toLowerCase().includes(search)
        );
      })
      .map((ct) => {
        const ctOrders = orders.filter((o) => o.client_contact_id === ct.id);
        let totalPrice = 0;
        let totalPaid = 0;
        if (user.role === 'admin') {
          for (const o of ctOrders) {
            if (o.status !== 'cancelled') {
              totalPrice += o.price_kopecks;
              totalPaid += paymentsByOrder.get(o.id) || 0;
            }
          }
        }
        return {
          ...ct,
          orders: ctOrders.map((o) => ({
            id: o.id,
            order_number: o.order_number,
            title: o.title,
            status: o.status,
            scheduled_at: o.scheduled_at,
            price_kopecks: user.role === 'admin' ? o.price_kopecks : undefined,
          })),
          debt_kopecks: user.role === 'admin' ? Math.max(0, totalPrice - totalPaid) : undefined,
          total_orders: ctOrders.length,
        };
      });

    res.json({ companies: enrichedCompanies, contacts: enrichedContacts });
  });

  router.post('/companies', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (
      user.role !== 'admin' &&
      !hasPermission(user, 'clients.create') &&
      !hasPermission(user, 'orders.create')
    ) {
      res.status(403).json({ error: 'Нет прав на добавление компаний.' });
      return;
    }

    const { name, inn, requisites, address, phone, email, notes } = req.body as Record<
      string,
      string | undefined
    >;
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Укажите название компании.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO companies (id, name, inn, requisites, address, phone, email, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name.trim(),
      (inn || '').trim(),
      (requisites || '').trim(),
      (address || '').trim(),
      (phone || '').trim(),
      (email || '').trim(),
      (notes || '').trim(),
      now
    );

    writeAuditLog(db, user.id, 'company', id, 'company_created', { name: name.trim() });
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    res.status(201).json({ company: row });
  });

  router.patch('/companies/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'clients.edit')) {
      res.status(403).json({ error: 'Нет прав на редактирование компаний.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as
      | Record<string, string>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Компания не найдена.' });
      return;
    }
    const b = req.body as Record<string, string | undefined>;
    db.prepare(
      `UPDATE companies SET name = ?, inn = ?, requisites = ?, address = ?, phone = ?, email = ?, notes = ? WHERE id = ?`
    ).run(
      b.name?.trim() || existing.name,
      b.inn !== undefined ? b.inn.trim() : existing.inn,
      b.requisites !== undefined ? b.requisites.trim() : existing.requisites,
      b.address !== undefined ? b.address.trim() : existing.address,
      b.phone !== undefined ? b.phone.trim() : existing.phone,
      b.email !== undefined ? b.email.trim() : existing.email,
      b.notes !== undefined ? b.notes.trim() : existing.notes,
      id
    );
    writeAuditLog(db, user.id, 'company', id, 'company_updated', {});
    res.json({ company: db.prepare('SELECT * FROM companies WHERE id = ?').get(id) });
  });

  router.delete('/companies/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'clients.edit')) {
      res.status(403).json({ error: 'Нет прав на удаление компаний.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(id) as
      | { id: string; name: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Компания не найдена.' });
      return;
    }
    if (db.prepare('SELECT 1 FROM orders WHERE company_id = ? LIMIT 1').get(id) ||
        db.prepare('SELECT 1 FROM client_payments WHERE company_id = ? LIMIT 1').get(id)) {
      res.status(409).json({ error: 'Компания связана с заказами или платежами и не может быть удалена.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM companies WHERE id = ?').run(id);
      writeAuditLog(db, user.id, 'company', id, 'company_deleted', { name: existing.name });
    });
    res.json({ ok: true, id });
  });

  router.post('/contacts', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (
      user.role !== 'admin' &&
      !hasPermission(user, 'clients.create') &&
      !hasPermission(user, 'orders.create')
    ) {
      res.status(403).json({ error: 'Нет прав на добавление контактов.' });
      return;
    }

    const { companyId, fullName, phone, email, position, notes } = req.body as Record<
      string,
      string | undefined
    >;
    if (!fullName || !fullName.trim()) {
      res.status(400).json({ error: 'Укажите ФИО контакта.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, company_id, full_name, phone, email, position, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      companyId || null,
      fullName.trim(),
      (phone || '').trim(),
      (email || '').trim(),
      (position || '').trim(),
      (notes || '').trim(),
      now
    );

    writeAuditLog(db, user.id, 'contact', id, 'contact_created', { fullName: fullName.trim() });
    res.status(201).json({ contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) });
  });

  router.patch('/contacts/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'clients.edit')) {
      res.status(403).json({ error: 'Нет прав на редактирование контактов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as
      | Record<string, string | null>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Контакт не найден.' });
      return;
    }
    const b = req.body as Record<string, string | null | undefined>;
    db.prepare(
      `UPDATE contacts SET company_id = ?, full_name = ?, phone = ?, email = ?, position = ?, notes = ? WHERE id = ?`
    ).run(
      b.companyId !== undefined ? b.companyId || null : existing.company_id,
      b.fullName?.trim() || existing.full_name,
      b.phone !== undefined ? (b.phone || '').trim() : existing.phone,
      b.email !== undefined ? (b.email || '').trim() : existing.email,
      b.position !== undefined ? (b.position || '').trim() : existing.position,
      b.notes !== undefined ? (b.notes || '').trim() : existing.notes,
      id
    );
    writeAuditLog(db, user.id, 'contact', id, 'contact_updated', {});
    res.json({ contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) });
  });

  router.delete('/contacts/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'clients.edit')) {
      res.status(403).json({ error: 'Нет прав на удаление контактов.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT id, full_name FROM contacts WHERE id = ?').get(id) as
      | { id: string; full_name: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Контакт не найден.' });
      return;
    }
    if (db.prepare('SELECT 1 FROM orders WHERE client_contact_id = ? LIMIT 1').get(id) ||
        db.prepare('SELECT 1 FROM client_payments WHERE contact_id = ? LIMIT 1').get(id)) {
      res.status(409).json({ error: 'Контакт связан с заказами или платежами и не может быть удалён.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
      writeAuditLog(db, user.id, 'contact', id, 'contact_deleted', { fullName: existing.full_name });
    });
    res.json({ ok: true, id });
  });

  return router;
}
