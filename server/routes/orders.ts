import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { reservationsFor } from '../services/reservations.ts';
import { replaySafeMutations } from '../sync.ts';
import { scheduleFileDeletion } from '../services/fileCleanup.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import { hasPermission, notifyAdmins, notifyUser, writeAuditLog } from '../security.ts';
import { applyMaterialOperationTx, getOrderMaterialBalance, issueToolTx, returnToolTx } from '../services/warehouseService.ts';
import { clampTzOffset, formatIsoToHm, syncVisitWorkTimeFromShifts } from './shifts.ts';

const isOrderClosed = (status: unknown): boolean => status === 'completed' || status === 'cancelled';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

export function getUploadDir(): string {
  const dir = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createMulterUpload() {
  const uploadDir = getUploadDir();
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 0);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) throw new Error('MAX_UPLOAD_BYTES must be a non-negative integer');
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
  return multer({
    storage,
    limits: { files: 1, ...(maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : {}) },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Недопустимый формат файла: ${file.mimetype}`));
      }
    },
  });
}

function isUserAssignedToOrder(db: DatabaseSync, orderId: string, userId: string): boolean {
  const direct = db
    .prepare('SELECT 1 FROM order_assignees WHERE order_id = ? AND user_id = ?')
    .get(orderId, userId);
  if (direct) return true;
  const viaVisit = db
    .prepare(
      `SELECT 1 FROM visit_assignees va
       JOIN order_visits v ON v.id = va.visit_id
       WHERE v.order_id = ? AND va.user_id = ? LIMIT 1`
    )
    .get(orderId, userId);
  return Boolean(viaVisit);
}

const ORDER_STATUSES = new Set(['new', 'in_progress', 'completed', 'cancelled']);
const ORDER_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

function nextOrderNumber(db: DatabaseSync): string {
  const prefix = `ПВ-${new Date().getFullYear().toString().slice(-2)}`;
  const rows = db
    .prepare('SELECT order_number FROM orders WHERE order_number LIKE ?')
    .all(`${prefix}%`) as Array<{ order_number: string }>;
  let max = 0;
  for (const r of rows) {
    const tail = Number(String(r.order_number).slice(prefix.length));
    if (Number.isInteger(tail) && tail > max) max = tail;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function enrichOrder(db: DatabaseSync, orderRow: Record<string, unknown>, isAdmin: boolean, currentUserId: string, canViewOtherReports: boolean) {
  const orderId = String(orderRow.id);
  const assignees = db
    .prepare(
      `SELECT u.id, u.full_name, u.position, u.phone
       FROM order_assignees oa
       JOIN users u ON u.id = oa.user_id
       WHERE oa.order_id = ?
       ORDER BY u.full_name ASC`
    )
    .all(orderId) as Array<Record<string, unknown>>;

  const visitRows = db
    .prepare('SELECT * FROM order_visits WHERE order_id = ? ORDER BY scheduled_at ASC, created_at ASC')
    .all(orderId) as Array<Record<string, unknown>>;

  const visits = visitRows.map((v) => {
    const vId = String(v.id);
    const vAssignees = db
      .prepare(
        `SELECT va.id, va.user_id, va.is_lead, va.wage_kopecks, va.wage_assigned_at, u.full_name, u.position, u.phone
         FROM visit_assignees va
         JOIN users u ON u.id = va.user_id
         WHERE va.visit_id = ?
         ORDER BY va.is_lead DESC, u.full_name ASC`
      )
      .all(vId) as Array<Record<string, unknown>>;

    const visibleAssignees = vAssignees.map((a) => {
      if (isAdmin || a.user_id === currentUserId) return a;
      const { wage_kopecks: _w, wage_assigned_at: _wa, ...rest } = a;
      return rest;
    });

    const reportsAll = db
      .prepare(
        `SELECT vr.*, u.full_name as author_name
         FROM visit_reports vr
         JOIN users u ON u.id = vr.user_id
         WHERE vr.visit_id = ?
         ORDER BY vr.created_at ASC`
      )
      .all(vId) as Array<Record<string, unknown>>;

    const reports =
      isAdmin || canViewOtherReports
        ? reportsAll
        : reportsAll.filter((r) => r.user_id === currentUserId);

    const visitAttachments = db
      .prepare("SELECT id, kind, original_name, mime_type, size_bytes, created_at FROM attachments WHERE entity_type = 'visit' AND entity_id = ? ORDER BY created_at ASC")
      .all(vId);

    const visitShifts = db
      .prepare(
        `SELECT ws.id, ws.user_id, u.full_name as employee_name, ws.started_at, ws.ended_at,
                ws.work_date, ws.status, ws.work_done, ws.is_manual_entry
         FROM workshop_shifts ws
         JOIN users u ON u.id = ws.user_id
         WHERE ws.visit_id = ?
         ORDER BY ws.started_at DESC`
      )
      .all(vId);

    return {
      ...v,
      assignees: visibleAssignees,
      reports,
      attachments: visitAttachments,
      shifts: visitShifts,
    };
  });

  const attachments = db
    .prepare("SELECT id, kind, original_name, mime_type, size_bytes, created_at FROM attachments WHERE entity_type = 'order' AND entity_id = ? ORDER BY created_at ASC")
    .all(orderId);

  const plannedRows = db
    .prepare(
      `SELECT opr.*, m.name as material_name, m.unit as material_unit, t.name as tool_name, t.icon_emoji as tool_emoji
       FROM order_planned_resources opr
       LEFT JOIN materials m ON m.id = opr.material_id
       LEFT JOIN tools t ON t.id = opr.tool_id
       WHERE opr.order_id = ?`
    )
    .all(orderId) as Array<Record<string, any>>;
  // Older versions allowed duplicate material rows. Present their sum without modifying history.
  const plannedResources: Array<Record<string, any>> = [];
  for (const row of plannedRows) {
    const previous = row.item_type === 'material' && row.material_id
      ? plannedResources.find(item => item.item_type === 'material' && item.material_id === row.material_id)
      : undefined;
    if (previous) previous.planned_qty_milli += row.planned_qty_milli;
    else plannedResources.push({...row});
  }
  for (const row of plannedResources) {
    const id=row.item_type==='material'?row.material_id:row.tool_id;
    if(!id) continue;
    const info=reservationsFor(db,row.item_type,id,orderId);
    row.reserved_remaining_milli=info.byOrder.find(item=>item.orderId===orderId)?.remainingMilli || 0;
    row.reserved_other_milli=info.otherMilli;
    const stock=row.item_type==='material'
      ? (db.prepare('SELECT quantity_milli AS qty FROM materials WHERE id=?').get(id) as {qty:number}|undefined)?.qty || 0
      : ((db.prepare('SELECT available_qty AS qty FROM tools WHERE id=?').get(id) as {qty:number}|undefined)?.qty || 0)*1000;
    row.available_for_order_milli=Math.max(0,stock-info.otherMilli);
    row.shortage_milli=Math.max(0,row.reserved_remaining_milli-row.available_for_order_milli);
  }

  const warehouseOps = db
    .prepare(
      `SELECT wo.*, m.name as material_name, m.unit as material_unit, t.name as tool_name, ti.serial_number as tool_serial, u.full_name as employee_name
       FROM warehouse_operations wo
       LEFT JOIN materials m ON m.id = wo.material_id
       LEFT JOIN tools t ON t.id = wo.tool_id
       LEFT JOIN tool_instances ti ON ti.id = wo.tool_instance_id
       LEFT JOIN users u ON u.id = wo.user_id
       WHERE wo.order_id = ?
       ORDER BY wo.created_at DESC`
    )
    .all(orderId);

  const company = orderRow.company_id
    ? db.prepare('SELECT id, name, phone FROM companies WHERE id = ?').get(orderRow.company_id)
    : null;
  const contact = orderRow.client_contact_id
    ? db.prepare('SELECT id, full_name, phone, position FROM contacts WHERE id = ?').get(orderRow.client_contact_id)
    : null;

  let paidKopecks: number | undefined;
  let materialCostKopecks: number | undefined;
  let salaryCostKopecks: number | undefined;
  let payments: Array<Record<string, unknown>> = [];
  if (isAdmin) {
    const payRow = db
      .prepare('SELECT COALESCE(SUM(amount_kopecks), 0) as paid FROM client_payments WHERE order_id = ?')
      .get(orderId) as { paid: number };
    paidKopecks = Number(payRow.paid || 0);

    payments = db
      .prepare(
        `SELECT id, amount_kopecks, payment_type, paid_at, comment, created_at
         FROM client_payments
         WHERE order_id = ?
         ORDER BY paid_at DESC, created_at DESC`
      )
      .all(orderId) as Array<Record<string, unknown>>;

    const matRow = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(ROUND(wo.qty_milli * wo.unit_cost_kopecks / 1000.0) AS INTEGER)), 0) as mat_cost
         FROM warehouse_operations wo
         WHERE wo.order_id = ? AND wo.item_type = 'material' AND wo.op_type = 'consume'`
      )
      .get(orderId) as { mat_cost: number };
    materialCostKopecks = Number(matRow.mat_cost || 0);

    const salRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_kopecks), 0) AS total
         FROM salary_accruals
         WHERE (source_type = 'visit' AND source_id IN (SELECT id FROM order_visits WHERE order_id = ?))
            OR (source_type = 'shift' AND source_id IN (SELECT id FROM workshop_shifts WHERE order_id = ?))`
      )
      .get(orderId, orderId) as { total: number };
    salaryCostKopecks = Number(salRow.total || 0);
  }

  const orderShifts = db
    .prepare(
      `SELECT ws.id, ws.user_id, u.full_name as employee_name, ws.started_at, ws.ended_at,
              ws.work_date, ws.status, ws.work_done, ws.shift_type, ws.visit_id, ws.quick_task_id, ws.is_manual_entry
       FROM workshop_shifts ws
       JOIN users u ON u.id = ws.user_id
       WHERE ws.order_id = ?
       ORDER BY ws.started_at DESC`
    )
    .all(orderId);

  const base: Record<string, unknown> = {
    ...orderRow,
    tags: parseTags(orderRow.tags_json),
    company,
    contact,
    assignees,
    visits,
    attachments,
    plannedResources,
    warehouseOps,
    orderShifts,
  };

  if (isAdmin) {
    const effectiveMat =
      orderRow.cost_override_kopecks !== null && orderRow.cost_override_kopecks !== undefined
        ? Number(orderRow.cost_override_kopecks)
        : Number(materialCostKopecks || 0);
    const priceK = Number(orderRow.price_kopecks || 0);
    const paidK = Number(paidKopecks || 0);
    base.payments = payments;
    base.paid_kopecks = paidK;
    base.overpaid_kopecks = Math.max(0, paidK - priceK);
    base.auto_material_cost_kopecks = materialCostKopecks;
    base.material_cost_kopecks = effectiveMat;
    base.salary_cost_kopecks = salaryCostKopecks;
    base.profit_kopecks = priceK - effectiveMat - Number(salaryCostKopecks || 0);
    if(orderRow.status==='cancelled') {
      const ids=db.prepare("SELECT DISTINCT material_id FROM warehouse_operations WHERE order_id=? AND item_type='material' AND material_id IS NOT NULL").all(orderId) as Array<{material_id:string}>;
      const materials=ids.map(row=>({id:row.material_id,...getOrderMaterialBalance(db,orderId,row.material_id),...db.prepare('SELECT name,unit FROM materials WHERE id=?').get(row.material_id)})).filter(row=>row.unconsumedIssuedMilli>0);
      const tools=db.prepare(`SELECT t.name,t.id, SUM(CASE WHEN w.op_type='issue' THEN w.qty_milli WHEN w.op_type='return' THEN -w.qty_milli ELSE 0 END) AS qty_milli FROM warehouse_operations w JOIN tools t ON t.id=w.tool_id WHERE w.order_id=? AND w.item_type='tool' GROUP BY t.id HAVING qty_milli>0`).all(orderId);
      const accrued=(db.prepare(`SELECT COALESCE(SUM(amount_kopecks),0) AS total FROM salary_accruals WHERE (source_type='visit' AND source_id IN (SELECT id FROM order_visits WHERE order_id=?)) OR (source_type='shift' AND source_id IN (SELECT id FROM workshop_shifts WHERE order_id=?))`).get(orderId,orderId) as {total:number}).total;
      const reviews=(db.prepare('SELECT issue_key,reviewed_at,note,subject_total_kopecks FROM order_cancel_reviews WHERE order_id=?').all(orderId) as Array<{issue_key:string;subject_total_kopecks:number}>).filter(review=>review.subject_total_kopecks===(review.issue_key==='payments'?paidKopecks:accrued));
      base.cancellationIssues={materials,tools,paymentsKopecks:paidKopecks,accrualsKopecks:accrued,reviews};
    }
  } else {
    // Employee MUST NOT see total order price or company financial override
    delete base.price_kopecks;
    delete base.cost_override_kopecks;
  }

  return base;
}

export function createOrdersRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  const upload = createMulterUpload();

  // List orders (filtered by role & permissions)
  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin';
    const canViewAll = isAdmin || hasPermission(user, 'orders.view_all');
    const canViewOtherReports = isAdmin || hasPermission(user, 'reports.view_others');

    const statusFilter = String(req.query.status || '').trim();
    const unplannedOnly = req.query.unplanned === '1';

    let rows: Array<Record<string, unknown>>;
    if (canViewAll) {
      rows = db
        .prepare('SELECT * FROM orders ORDER BY CASE WHEN scheduled_at IS NULL THEN 1 ELSE 0 END, scheduled_at ASC, created_at DESC')
        .all() as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `SELECT DISTINCT o.*
           FROM orders o
           LEFT JOIN order_assignees oa ON oa.order_id = o.id
           LEFT JOIN order_visits ov ON ov.order_id = o.id
           LEFT JOIN visit_assignees va ON va.visit_id = ov.id
           WHERE oa.user_id = ? OR va.user_id = ?
           ORDER BY CASE WHEN o.scheduled_at IS NULL THEN 1 ELSE 0 END, o.scheduled_at ASC, o.created_at DESC`
        )
        .all(user.id, user.id) as Array<Record<string, unknown>>;
    }

    if (statusFilter) {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    if (unplannedOnly) {
      rows = rows.filter((r) => !r.scheduled_at);
    }

    const items = rows.map((r) => enrichOrder(db, r, isAdmin, user.id, canViewOtherReports));
    res.json({ orders: items });
  });

  // Get single order
  router.get('/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.id);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const isAdmin = user.role === 'admin';
    const canView =
      isAdmin ||
      hasPermission(user, 'orders.view_all') ||
      isUserAssignedToOrder(db, orderId, user.id);

    if (!canView) {
      res.status(403).json({ error: 'Нет доступа к этому заказу.' });
      return;
    }

    const canViewOtherReports = isAdmin || hasPermission(user, 'reports.view_others');
    res.json({ order: enrichOrder(db, row, isAdmin, user.id, canViewOtherReports) });
  });

  // Create fast/draft or full order
  router.post('/', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin' && !hasPermission(user, 'orders.create')) {
      res.status(403).json({ error: 'Нет прав на создание заказов.' });
      return;
    }

    const b = req.body as {
      orderNumber?: string;
      title?: string;
      status?: 'new' | 'in_progress' | 'completed' | 'cancelled';
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      scheduledAt?: string | null;
      companyId?: string | null;
      clientContactId?: string | null;
      siteContactName?: string;
      siteContactPhone?: string;
      address?: string;
      description?: string;
      priceKopecks?: number;
      tags?: string[];
      comments?: string;
      assigneeIds?: string[];
      visits?: Array<{
        title?: string;
        scheduledAt: string;
        description?: string;
        assigneeIds?: string[];
      }>;
      plannedMaterials?: Array<{ materialId: string; qtyMilli: number }>;
      plannedTools?: Array<{ toolId: string; qty: number }>;
    };

    if (Array.isArray(b.plannedMaterials) && new Set(b.plannedMaterials.map(item => item.materialId)).size !== b.plannedMaterials.length) {
      res.status(400).json({ error: 'Каждый материал можно добавить в план только один раз.' }); return;
    }
    if (b.companyId && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(b.companyId)) {
      res.status(404).json({ error: 'Компания не найдена.' }); return;
    }
    if (b.clientContactId && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(b.clientContactId)) {
      res.status(404).json({ error: 'Контакт клиента не найден.' }); return;
    }
    if (user.role === 'admin' && b.priceKopecks !== undefined && (!Number.isSafeInteger(Number(b.priceKopecks)) || Number(b.priceKopecks) < 0)) {
      res.status(400).json({ error: 'Сумма заказа должна быть целым неотрицательным числом копеек.' }); return;
    }
    if (Array.isArray(b.assigneeIds)) {
      for (const uid of b.assigneeIds) {
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) {
          res.status(404).json({ error: 'Назначенный сотрудник не найден.' }); return;
        }
      }
    }

    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      withTransaction(db, () => {
        let orderNumber = (b.orderNumber || '').trim();
        if (orderNumber) {
          if (orderNumber.length > 40) throw new Error('ORDER_NUMBER_INVALID');
          const dup = db
            .prepare('SELECT 1 FROM orders WHERE order_number = ?')
            .get(orderNumber);
          if (dup) throw new Error('ORDER_NUMBER_EXISTS');
        } else {
          orderNumber = nextOrderNumber(db);
        }
        const title = (b.title || '').trim() || `Заказ ${orderNumber}`;
        const status =
          user.role === 'admin' && b.status && ORDER_STATUSES.has(b.status) ? b.status : 'new';
        const priority =
          b.priority && ORDER_PRIORITIES.has(b.priority) ? b.priority : 'normal';

        const cleanTags = Array.isArray(b.tags)
          ? Array.from(new Set(b.tags.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)))
          : [];

        db.prepare(
          `INSERT INTO orders
           (id, order_number, title, status, priority, scheduled_at, company_id, client_contact_id, site_contact_name, site_contact_phone, address, description, price_kopecks, tags_json, comments, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          orderId,
          orderNumber,
          title,
          status,
          priority,
          b.scheduledAt || null,
          b.companyId || null,
          b.clientContactId || null,
          (b.siteContactName || '').trim(),
          (b.siteContactPhone || '').trim(),
          (b.address || '').trim(),
          (b.description || '').trim(),
          user.role === 'admin' ? Math.max(0, Math.round(Number(b.priceKopecks || 0))) : 0,
          JSON.stringify(cleanTags),
          (b.comments || '').trim(),
          user.id,
          now,
          now
        );

        if (cleanTags.length > 0) {
          const tagRow = db
            .prepare("SELECT value_json FROM settings WHERE key = 'order_tags'")
            .get() as { value_json: string } | undefined;
          let existingTags: string[] = [];
          if (tagRow) {
            try {
              const parsed = JSON.parse(tagRow.value_json);
              if (Array.isArray(parsed)) {
                existingTags = parsed.filter((t): t is string => typeof t === 'string' && Boolean(t.trim()));
              }
            } catch {
              existingTags = [];
            }
          }
          const mergedTags = Array.from(new Set([...existingTags, ...cleanTags]));
          if (mergedTags.length > existingTags.length) {
            db.prepare(
              `INSERT INTO settings (key, value_json, updated_at)
               VALUES ('order_tags', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
            ).run(JSON.stringify(mergedTags), now);
          }
        }

      const assigneeSet = new Set<string>(Array.isArray(b.assigneeIds) ? b.assigneeIds : []);
      const insOrderAssignee = db.prepare(
        'INSERT OR IGNORE INTO order_assignees (order_id, user_id) VALUES (?, ?)'
      );
      for (const uid of assigneeSet) {
        insOrderAssignee.run(orderId, uid);
      }

      // Create visits (if provided, OR auto-create 1 initial visit if scheduledAt + assignees are set?
      // Better: create visits explicitly passed, and if scheduledAt is set with no explicit visits, keep visits empty until created OR allow creating visits anytime)
      if (Array.isArray(b.visits)) {
        for (let idx = 0; idx < b.visits.length; idx++) {
          const v = b.visits[idx];
          if (!v.scheduledAt) continue;
          const visitId = crypto.randomUUID();
          db.prepare(
            `INSERT INTO order_visits (id, order_id, title, scheduled_at, description, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'planned', ?)`
          ).run(
            visitId,
            orderId,
            (v.title || `Выезд ${idx + 1}`).trim(),
            v.scheduledAt,
            (v.description || '').trim(),
            now
          );
          const vAssignees = Array.isArray(v.assigneeIds) && v.assigneeIds.length > 0
            ? v.assigneeIds
            : Array.from(assigneeSet);
          vAssignees.forEach((uid, aIdx) => {
            db.prepare(
              `INSERT OR IGNORE INTO visit_assignees (id, visit_id, user_id, is_lead, wage_kopecks)
               VALUES (?, ?, ?, ?, NULL)`
            ).run(crypto.randomUUID(), visitId, uid, aIdx === 0 ? 1 : 0);
            insOrderAssignee.run(orderId, uid);
            assigneeSet.add(uid);
          });
        }
      }

      if (Array.isArray(b.plannedMaterials)) {
        for (const pm of b.plannedMaterials) {
          if (!pm.materialId || pm.qtyMilli <= 0) continue;
          db.prepare(
            `INSERT INTO order_planned_resources (id, order_id, item_type, material_id, tool_id, planned_qty_milli, created_by, created_at)
             VALUES (?, ?, 'material', ?, NULL, ?, ?, ?)`
          ).run(crypto.randomUUID(), orderId, pm.materialId, Math.round(pm.qtyMilli), user.id, now);
        }
      }

      if (Array.isArray(b.plannedTools)) {
        for (const pt of b.plannedTools) {
          if (!pt.toolId || pt.qty <= 0) continue;
          db.prepare(
            `INSERT INTO order_planned_resources (id, order_id, item_type, material_id, tool_id, planned_qty_milli, created_by, created_at)
             VALUES (?, ?, 'tool', NULL, ?, ?, ?, ?)`
          ).run(crypto.randomUUID(), orderId, pt.toolId, Math.round(pt.qty * 1000), user.id, now);
        }
      }

      for (const uid of assigneeSet) {
        notifyUser(
          db,
          uid,
          'order_assigned',
          `Назначен заказ ${orderNumber}`,
          `${title}${b.address ? ` · ${b.address}` : ''}`,
          'order',
          orderId
        );
      }

      writeAuditLog(db, user.id, 'order', orderId, 'order_created', { orderNumber, title });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'ORDER_NUMBER_EXISTS' || message.includes('orders.order_number')) {
        res.status(409).json({ error: 'Заказ с таким номером уже существует. Укажите другой номер.' });
        return;
      }
      if (message === 'ORDER_NUMBER_INVALID') {
        res.status(400).json({ error: 'Номер заказа слишком длинный (максимум 40 символов).' });
        return;
      }
      if (message.includes('SQLITE_CONSTRAINT')) {
        res.status(400).json({ error: 'Некорректные ссылки или данные при создании заказа.' });
        return;
      }
      throw err;
    }

    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.status(201).json({ order: enrichOrder(db, row, user.role === 'admin', user.id, true) });
  });

  // Update order
  router.patch('/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.id);
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const isAdmin = user.role === 'admin';
    if (!isAdmin && isOrderClosed(existing.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Редактировать закрытый заказ может только администратор.' });
      return;
    }
    const canEdit =
      isAdmin ||
      (hasPermission(user, 'orders.edit_assigned') && isUserAssignedToOrder(db, orderId, user.id));
    if (!canEdit) {
      res.status(403).json({ error: 'Нет прав на редактирование этого заказа.' });
      return;
    }

    const b = req.body as Record<string, unknown>;
    const now = new Date().toISOString();
    const nextStatus: string =
      isAdmin && typeof b.status === 'string' && ORDER_STATUSES.has(b.status)
        ? b.status
        : String(existing.status);
    const nextPriority: string =
      typeof b.priority === 'string' && ORDER_PRIORITIES.has(b.priority)
        ? b.priority
        : String(existing.priority);
    const priceValue = Number(b.priceKopecks);
    if (b.orderNumber !== undefined) {
      if (typeof b.orderNumber !== 'string' || !b.orderNumber.trim() || b.orderNumber.trim().length > 40) {
        res.status(400).json({ error: 'Укажите номер заказа длиной до 40 символов.' }); return;
      }
      if (db.prepare('SELECT 1 FROM orders WHERE order_number = ? AND id != ?').get(b.orderNumber.trim(), orderId)) {
        res.status(409).json({ error: 'Заказ с таким номером уже существует. Укажите другой номер.' }); return;
      }
    }
    if (b.plannedMaterials !== undefined && (!Array.isArray(b.plannedMaterials) || b.plannedMaterials.some((item: any) =>
      !item || typeof item.materialId !== 'string' || !Number.isSafeInteger(item.qtyMilli) || item.qtyMilli < 1 ||
      !db.prepare('SELECT 1 FROM materials WHERE id = ?').get(item.materialId)))) {
      res.status(400).json({ error: 'Укажите существующий материал и положительное количество.' }); return;
    }
    if (Array.isArray(b.plannedMaterials) && new Set(b.plannedMaterials.map((item: any) => item.materialId)).size !== b.plannedMaterials.length) {
      res.status(400).json({ error: 'Каждый материал можно добавить в план только один раз.' }); return;
    }
    if(b.plannedTools!==undefined && (!Array.isArray(b.plannedTools) || b.plannedTools.some((tool:any)=>
      !tool || typeof tool.toolId!=='string' || !Number.isSafeInteger(tool.qty) || tool.qty<1 || tool.qty>Math.floor(Number.MAX_SAFE_INTEGER/1000) ||
      !db.prepare('SELECT 1 FROM tools WHERE id = ?').get(tool.toolId)))) {
      res.status(400).json({error:'Укажите существующий инструмент и целое положительное количество.'});return;
    }
    if (b.companyId && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(String(b.companyId))) {
      res.status(404).json({ error: 'Компания не найдена.' }); return;
    }
    if (b.clientContactId && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(String(b.clientContactId))) {
      res.status(404).json({ error: 'Контакт клиента не найден.' }); return;
    }
    if (isAdmin && Array.isArray(b.assigneeIds)) {
      for (const uid of b.assigneeIds) {
        if (typeof uid !== 'string' || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) {
          res.status(404).json({ error: 'Назначенный сотрудник не найден.' }); return;
        }
      }
    }

    withTransaction(db, () => {
      if(nextStatus==='cancelled' && existing.status!=='cancelled') db.prepare('DELETE FROM order_cancel_reviews WHERE order_id=?').run(orderId);
      db.prepare(
        `UPDATE orders SET
          order_number = ?,
          title = ?,
          status = ?,
          priority = ?,
          scheduled_at = ?,
          company_id = ?,
          client_contact_id = ?,
          site_contact_name = ?,
          site_contact_phone = ?,
          address = ?,
          description = ?,
          price_kopecks = ?,
          tags_json = ?,
          comments = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(
        typeof b.orderNumber === 'string' ? b.orderNumber.trim() : existing.order_number,
        typeof b.title === 'string' && b.title.trim() ? b.title.trim() : existing.title,
        nextStatus,
        nextPriority,
        b.scheduledAt !== undefined ? (b.scheduledAt || null) : existing.scheduled_at,
        b.companyId !== undefined ? (b.companyId || null) : existing.company_id,
        b.clientContactId !== undefined ? (b.clientContactId || null) : existing.client_contact_id,
        typeof b.siteContactName === 'string' ? b.siteContactName.trim() : existing.site_contact_name,
        typeof b.siteContactPhone === 'string' ? b.siteContactPhone.trim() : existing.site_contact_phone,
        typeof b.address === 'string' ? b.address.trim() : existing.address,
        typeof b.description === 'string' ? b.description.trim() : existing.description,
        isAdmin && b.priceKopecks !== undefined && Number.isFinite(priceValue)
          ? Math.max(0, Math.round(priceValue))
          : existing.price_kopecks,
        Array.isArray(b.tags)
          ? JSON.stringify(b.tags.filter((t): t is string => typeof t === 'string'))
          : existing.tags_json,
        typeof b.comments === 'string' ? b.comments.trim() : existing.comments,
        now,
        orderId
      );

      if (isAdmin && Array.isArray(b.assigneeIds)) {
        db.prepare('DELETE FROM order_assignees WHERE order_id = ?').run(orderId);
        const ins = db.prepare('INSERT OR IGNORE INTO order_assignees (order_id, user_id) VALUES (?, ?)');
        for (const uid of b.assigneeIds as string[]) {
          ins.run(orderId, uid);
          notifyUser(
            db,
            uid,
            'order_updated',
            `Обновлён заказ ${String(existing.order_number)}`,
            String(b.title || existing.title),
            'order',
            orderId
          );
        }
      }

      if(Array.isArray(b.plannedTools)) {
        db.prepare("DELETE FROM order_planned_resources WHERE order_id=? AND item_type='tool'").run(orderId);
        for(const tool of b.plannedTools as Array<{toolId:string;qty:number}>) {
          db.prepare("INSERT INTO order_planned_resources(id,order_id,item_type,tool_id,planned_qty_milli,created_by,created_at) VALUES (?,?,'tool',?,?,?,?)").run(crypto.randomUUID(),orderId,tool.toolId,tool.qty*1000,user.id,now);
        }
      }
      if (Array.isArray(b.plannedMaterials)) {
        db.prepare("DELETE FROM order_planned_resources WHERE order_id = ? AND item_type = 'material'").run(orderId);
        for (const item of b.plannedMaterials as Array<{ materialId: string; qtyMilli: number }>) {
          db.prepare("INSERT INTO order_planned_resources(id, order_id, item_type, material_id, planned_qty_milli, created_by, created_at) VALUES (?, ?, 'material', ?, ?, ?, ?)")
            .run(crypto.randomUUID(), orderId, item.materialId, item.qtyMilli, user.id, now);
        }
      }
      writeAuditLog(db, user.id, 'order', orderId, 'order_updated', {
        fields: Object.keys(b),
      });
    });

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.json({ order: enrichOrder(db, updated, isAdmin, user.id, isAdmin || hasPermission(user, 'reports.view_others')) });
  });

  router.post('/:id/cancellation-review',requireAdmin,(req:AuthedRequest,res)=>{
    const id=String(req.params.id),key=req.body?.issueKey,note=typeof req.body?.note==='string'?req.body.note.trim():'';
    if(!['payments','accruals'].includes(key) || !note || note.length>1000){res.status(400).json({error:'Опишите решение вопроса (до 1000 символов).'});return;}
    const order=db.prepare("SELECT * FROM orders WHERE id=? AND status='cancelled'").get(id) as Record<string,unknown>|undefined;
    if(!order){res.status(404).json({error:'Отменённый заказ не найден.'});return;}
    const total=key==='payments'
      ? (db.prepare('SELECT COALESCE(SUM(amount_kopecks),0) AS total FROM client_payments WHERE order_id=?').get(id) as {total:number}).total
      : (db.prepare(`SELECT COALESCE(SUM(amount_kopecks),0) AS total FROM salary_accruals WHERE (source_type='visit' AND source_id IN (SELECT id FROM order_visits WHERE order_id=?)) OR (source_type='shift' AND source_id IN (SELECT id FROM workshop_shifts WHERE order_id=?))`).get(id,id) as {total:number}).total;
    withTransaction(db,()=>{
      db.prepare('INSERT INTO order_cancel_reviews(order_id,issue_key,reviewed_by,reviewed_at,note,subject_total_kopecks) VALUES (?,?,?,?,?,?) ON CONFLICT(order_id,issue_key) DO UPDATE SET reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,note=excluded.note,subject_total_kopecks=excluded.subject_total_kopecks').run(id,key,req.authUser!.id,new Date().toISOString(),note,total);
      writeAuditLog(db,req.authUser!.id,'order',id,'cancellation_reviewed',{issueKey:key,note});
    });
    res.json({order:enrichOrder(db,order,true,req.authUser!.id,true)});
  });

  // Admin reopen order with audit history
  router.post('/:id/reopen', requireAdmin, (req: AuthedRequest, res) => {
    const orderId = String(req.params.id);
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }
    const { reason } = req.body as { reason?: string };
    withTransaction(db, () => {
      db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        orderId
      );
      writeAuditLog(db, req.authUser!.id, 'order', orderId, 'order_reopened', {
        previousStatus: existing.status,
        reason: reason || '',
      });
    });
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.json({ order: enrichOrder(db, updated, true, req.authUser!.id, true) });
  });

  // Admin delete order + attached files cleanup
  router.delete('/:id', requireAdmin, (req: AuthedRequest, res) => {
    const orderId = String(req.params.id);
    const existing = db
      .prepare('SELECT id, order_number, title FROM orders WHERE id = ?')
      .get(orderId) as { id: string; order_number: string; title: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const hasHistory =
      Boolean(db.prepare('SELECT 1 FROM client_payments WHERE order_id = ? LIMIT 1').get(orderId)) ||
      Boolean(db.prepare('SELECT 1 FROM expenses WHERE order_id = ? LIMIT 1').get(orderId)) ||
      Boolean(db.prepare('SELECT 1 FROM warehouse_operations WHERE order_id = ? LIMIT 1').get(orderId)) ||
      Boolean(db.prepare('SELECT 1 FROM visit_reports WHERE order_id = ? LIMIT 1').get(orderId)) ||
      Boolean(db.prepare('SELECT 1 FROM workshop_shifts WHERE order_id = ? LIMIT 1').get(orderId)) ||
      Boolean(
        db
          .prepare(
            `SELECT 1 FROM salary_accruals
             WHERE (source_type = 'visit' AND source_id IN (SELECT id FROM order_visits WHERE order_id = ?))
                OR (source_type = 'shift' AND source_id IN (SELECT id FROM workshop_shifts WHERE order_id = ?))
             LIMIT 1`
          )
          .get(orderId, orderId)
      );
    if (hasHistory) {
      res.status(409).json({ error: 'У заказа есть учётная история. Используйте отмену заказа.' });
      return;
    }
    const visitRows = db
      .prepare('SELECT id FROM order_visits WHERE order_id = ?')
      .all(orderId) as Array<{ id: string }>;
    const visitIds = visitRows.map((v) => v.id);

    const attachmentFiles: string[] = [];
    withTransaction(db, () => {
      const orderAtts = db
        .prepare("SELECT id, stored_name FROM attachments WHERE entity_type = 'order' AND entity_id = ?")
        .all(orderId) as Array<{ id: string; stored_name: string }>;
      for (const a of orderAtts) attachmentFiles.push(a.stored_name);
      db.prepare("DELETE FROM attachments WHERE entity_type = 'order' AND entity_id = ?").run(orderId);

      for (const vid of visitIds) {
        const vAtts = db
          .prepare("SELECT id, stored_name FROM attachments WHERE entity_type = 'visit' AND entity_id = ?")
          .all(vid) as Array<{ id: string; stored_name: string }>;
        for (const a of vAtts) attachmentFiles.push(a.stored_name);
        db.prepare("DELETE FROM attachments WHERE entity_type = 'visit' AND entity_id = ?").run(vid);
      }

      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
      for(const name of attachmentFiles) scheduleFileDeletion(db,name);
      writeAuditLog(db, req.authUser!.id, 'order', orderId, 'order_deleted', {
        orderNumber: existing.order_number,
        title: existing.title,
      });
    });

    res.json({ ok: true, id: orderId });
  });

  // Add visit (multi-day order)
  router.post('/:id/visits', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined;
    if (!order) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    if (user.role !== 'admin' && isOrderClosed(order.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Добавлять выезды может только администратор.' });
      return;
    }

    const canEdit =
      user.role === 'admin' ||
      (hasPermission(user, 'orders.edit_assigned') && isUserAssignedToOrder(db, orderId, user.id));
    if (!canEdit) {
      res.status(403).json({ error: 'Нет прав на добавление выезда.' });
      return;
    }

    const { title, scheduledAt, description, assigneeIds } = req.body as {
      title?: string;
      scheduledAt?: string;
      description?: string;
      assigneeIds?: string[];
    };
    if (!scheduledAt) {
      res.status(400).json({ error: 'Укажите дату и время выезда.' });
      return;
    }

    const visitId = crypto.randomUUID();
    const now = new Date().toISOString();
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO order_visits (id, order_id, title, scheduled_at, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'planned', ?)`
      ).run(visitId, orderId, (title || 'Монтажный выезд').trim(), scheduledAt, (description || '').trim(), now);

      const list = Array.isArray(assigneeIds) ? assigneeIds : [];
      list.forEach((uid, idx) => {
        db.prepare(
          `INSERT OR IGNORE INTO visit_assignees (id, visit_id, user_id, is_lead, wage_kopecks)
           VALUES (?, ?, ?, ?, NULL)`
        ).run(crypto.randomUUID(), visitId, uid, idx === 0 ? 1 : 0);
        db.prepare('INSERT OR IGNORE INTO order_assignees (order_id, user_id) VALUES (?, ?)').run(orderId, uid);
        notifyUser(
          db,
          uid,
          'order_assigned',
          `Назначен выезд по заказу ${String(order.order_number)}`,
          `${title || 'Выезд'} · ${scheduledAt.slice(0, 16).replace('T', ' ')}`,
          'order',
          orderId
        );
      });

      if (order.status === 'new' || order.status === 'completed') {
        db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, orderId);
      }
      writeAuditLog(db, user.id, 'visit', visitId, 'visit_created', { orderId, scheduledAt });
    });

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.status(201).json({ order: enrichOrder(db, updated, user.role === 'admin', user.id, true) });
  });

  // Personal working hours are independent of completion reports.
  router.put('/:orderId/visits/:visitId/work-time', requireAuth, (req: AuthedRequest, res) => {
    const { orderId, visitId } = req.params;
    const user = req.authUser!;
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Время работы фиксируется автоматически таймером смены. Ручной ввод доступен только администратору.' });
      return;
    }
    const visit = db.prepare('SELECT id FROM order_visits WHERE id=? AND order_id=?').get(visitId, orderId);
    if (!visit) { res.sendStatus(404); return; }
    const { workDate, startTime, endTime } = req.body;
    if (typeof workDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) ||
        !Number.isFinite(Date.parse(`${workDate}T00:00:00Z`)) || new Date(`${workDate}T00:00:00Z`).toISOString().slice(0, 10) !== workDate ||
        typeof startTime !== 'string' || typeof endTime !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime === endTime) {
      res.status(400).json({error:'Укажите дату и время начала и окончания работы.'}); return;
    }
    withTransaction(db, () => {
      db.prepare(`INSERT INTO visit_work_times(visit_id,user_id,work_date,start_time,end_time,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(visit_id,user_id,work_date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,updated_at=excluded.updated_at`)
        .run(visitId,user.id,workDate,startTime,endTime,new Date().toISOString());
      writeAuditLog(db,user.id,'visit',visitId,'work_time_updated',{workDate});
    });
    res.json({ok:true});
  });

  router.get('/:orderId/visits/:visitId/work-times', requireAuth, (req: AuthedRequest, res) => {
    const { orderId, visitId } = req.params; const user = req.authUser!;
    if (!db.prepare('SELECT 1 FROM order_visits WHERE id=? AND order_id=?').get(visitId,orderId)) { res.sendStatus(404); return; }
    const assigned = db.prepare('SELECT 1 FROM visit_assignees WHERE visit_id=? AND user_id=? UNION ALL SELECT 1 FROM order_assignees WHERE order_id=? AND user_id=?').get(visitId,user.id,orderId,user.id);
    if (user.role !== 'admin' && !assigned) { res.sendStatus(403); return; }
    const rows = db.prepare(`SELECT w.user_id,u.full_name,w.work_date,w.start_time,w.end_time FROM visit_work_times w
      JOIN users u ON u.id=w.user_id WHERE w.visit_id=? AND (?=1 OR w.user_id=?) ORDER BY w.work_date DESC,u.full_name`).all(visitId,user.role === 'admin' ? 1 : 0,user.id);
    res.json({items:rows});
  });

  // Submit visit completion/participant report (auto-completes visit AND parent order if all visits finished)
  router.post('/:orderId/visits/:visitId/report', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.orderId);
    const visitId = String(req.params.visitId);

    const visit = db
      .prepare('SELECT * FROM order_visits WHERE id = ? AND order_id = ?')
      .get(visitId, orderId) as Record<string, unknown> | undefined;
    if (!visit) {
      res.status(404).json({ error: 'Выезд не найден.' });
      return;
    }

    const parentOrder = db.prepare('SELECT id, status, order_number, title FROM orders WHERE id = ?').get(orderId) as
      | { id: string; status: string; order_number: string; title: string }
      | undefined;
    if (!parentOrder) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }
    if (user.role !== 'admin' && isOrderClosed(parentOrder.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Добавлять отчёты может только администратор.' });
      return;
    }

    const assignedRow = db
      .prepare('SELECT id FROM visit_assignees WHERE visit_id = ? AND user_id = ?')
      .get(visitId, user.id);
    if (user.role !== 'admin' && !assignedRow && !isUserAssignedToOrder(db, orderId, user.id)) {
      res.status(403).json({ error: 'Вы не назначены на этот выезд.' });
      return;
    }

    const { startTime, endTime, workDone, notes, completeVisit, stopActiveShift, tzOffsetMinutes } = req.body as {
      startTime?: string;
      endTime?: string;
      workDone?: string;
      notes?: string;
      completeVisit?: boolean;
      stopActiveShift?: boolean;
      tzOffsetMinutes?: number;
    };

    if (!workDone || !workDone.trim()) {
      res.status(400).json({ error: 'Опишите выполненные работы.' });
      return;
    }

    const tzOffset = clampTzOffset(tzOffsetMinutes);
    const now = new Date().toISOString();
    const reportId = crypto.randomUUID();

    withTransaction(db, () => {
      let resolvedStartTime = user.role === 'admin' ? (startTime || '').trim() : '';
      let resolvedEndTime = user.role === 'admin' ? (endTime || '').trim() : '';

      // If caller has an active shift bound to this visit (or order), close it and derive times unless explicitly skipped
      const activeShift = db
        .prepare(
          `SELECT id, started_at, work_date
           FROM workshop_shifts
           WHERE user_id = ? AND status = 'active' AND (visit_id = ? OR (visit_id IS NULL AND order_id = ?))
           LIMIT 1`
        )
        .get(user.id, visitId, orderId) as
        | { id: string; started_at: string; work_date: string }
        | undefined;

      if (activeShift && stopActiveShift !== false) {
        const workDate = activeShift.work_date || activeShift.started_at.slice(0, 10);
        db.prepare(
          "UPDATE workshop_shifts SET ended_at = ?, work_done = ?, status = 'completed', work_date = ?, visit_id = COALESCE(visit_id, ?) WHERE id = ?"
        ).run(now, workDone.trim(), workDate, visitId, activeShift.id);
        syncVisitWorkTimeFromShifts(db, visitId, user.id, workDate, tzOffset);
        if (!resolvedStartTime) resolvedStartTime = formatIsoToHm(activeShift.started_at, tzOffset);
        if (!resolvedEndTime) resolvedEndTime = formatIsoToHm(now, tzOffset);
        writeAuditLog(db, user.id, 'shift', activeShift.id, 'shift_completed', {
          shiftType: 'visit',
          orderId,
          visitId,
          closedViaVisitReport: true,
        });
      } else if (!resolvedStartTime && !resolvedEndTime) {
        const latestShift = db
          .prepare(
            `SELECT started_at, ended_at
             FROM workshop_shifts
             WHERE user_id = ? AND status = 'completed' AND (visit_id = ? OR (visit_id IS NULL AND order_id = ?))
             ORDER BY started_at DESC
             LIMIT 1`
          )
          .get(user.id, visitId, orderId) as { started_at: string; ended_at: string | null } | undefined;
        if (latestShift) {
          resolvedStartTime = formatIsoToHm(latestShift.started_at, tzOffset);
          resolvedEndTime = latestShift.ended_at ? formatIsoToHm(latestShift.ended_at, tzOffset) : '';
        }
      }

      const existingPrimary = db
        .prepare('SELECT id FROM visit_reports WHERE visit_id = ? AND is_primary = 1')
        .get(visitId);

      const isPrimary = !existingPrimary && completeVisit !== false ? 1 : 0;

      db.prepare(
        `INSERT INTO visit_reports (id, visit_id, order_id, user_id, is_primary, start_time, end_time, work_done, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        reportId,
        visitId,
        orderId,
        user.id,
        isPrimary,
        resolvedStartTime,
        resolvedEndTime,
        workDone.trim(),
        (notes || '').trim(),
        now
      );

      // Required report marks visit as completed automatically without mandatory admin approval
      if (completeVisit !== false && visit.status !== 'completed') {
        db.prepare(
          `UPDATE order_visits
           SET status = 'completed', actual_start_at = ?, actual_end_at = ?, completed_by = ?, completed_at = ?
           WHERE id = ?`
        ).run(resolvedStartTime || null, resolvedEndTime || null, user.id, now, visitId);

        // Check if ALL planned/active visits of this order are completed (and at least 1 visit exists)
        const allVisits = db
          .prepare("SELECT status FROM order_visits WHERE order_id = ? AND status != 'cancelled'")
          .all(orderId) as Array<{ status: string }>;

        if (allVisits.length > 0 && allVisits.every((v) => v.status === 'completed')) {
          db.prepare("UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?").run(now, orderId);
        } else {
          db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'new'").run(
            now,
            orderId
          );
        }

        notifyAdmins(
          db,
          'visit_completed',
          `Монтаж завершён: ${parentOrder.order_number}`,
          `${user.fullName} отправил отчёт по выезду «${String(visit.title)}»`,
          'order',
          orderId,
          user.id
        );
      }

      writeAuditLog(db, user.id, 'visit', visitId, 'report_submitted', { reportId, orderId });
    });

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.status(201).json({
      reportId,
      order: enrichOrder(db, updated, user.role === 'admin', user.id, user.role === 'admin' || hasPermission(user, 'reports.view_others')),
    });
  });

  // Edit visit report (admin or report author)
  router.patch('/:orderId/visits/:visitId/reports/:reportId', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.orderId);
    const visitId = String(req.params.visitId);
    const reportId = String(req.params.reportId);

    const existing = db
      .prepare('SELECT * FROM visit_reports WHERE id = ? AND visit_id = ? AND order_id = ?')
      .get(reportId, visitId, orderId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Отчёт не найден.' });
      return;
    }

    const orderRow = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as
      | { status: string }
      | undefined;
    if (user.role !== 'admin' && orderRow && isOrderClosed(orderRow.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Редактировать отчёты в закрытом заказе может только администратор.' });
      return;
    }

    if (user.role !== 'admin' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'Редактировать можно только свой отчёт.' });
      return;
    }

    const { startTime, endTime, workDone, notes } = req.body as {
      startTime?: string;
      endTime?: string;
      workDone?: string;
      notes?: string;
    };

    if (workDone !== undefined && !workDone.trim()) {
      res.status(400).json({ error: 'Описание выполненных работ не может быть пустым.' });
      return;
    }

    withTransaction(db, () => {
      db.prepare(
        `UPDATE visit_reports
         SET start_time = ?, end_time = ?, work_done = ?, notes = ?
         WHERE id = ?`
      ).run(
        user.role === 'admin' && startTime !== undefined ? startTime.trim() : existing.start_time,
        user.role === 'admin' && endTime !== undefined ? endTime.trim() : existing.end_time,
        workDone !== undefined ? workDone.trim() : existing.work_done,
        notes !== undefined ? notes.trim() : existing.notes,
        reportId
      );
      writeAuditLog(db, user.id, 'visit_report', reportId, 'report_updated', { orderId, visitId });
    });

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.json({
      order: enrichOrder(
        db,
        updated,
        user.role === 'admin',
        user.id,
        user.role === 'admin' || hasPermission(user, 'reports.view_others')
      ),
    });
  });

  // Delete visit report (admin or report author)
  router.delete('/:orderId/visits/:visitId/reports/:reportId', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.orderId);
    const visitId = String(req.params.visitId);
    const reportId = String(req.params.reportId);

    const existing = db
      .prepare('SELECT * FROM visit_reports WHERE id = ? AND visit_id = ? AND order_id = ?')
      .get(reportId, visitId, orderId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Отчёт не найден.' });
      return;
    }

    const orderRow = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as
      | { status: string }
      | undefined;
    if (user.role !== 'admin' && orderRow && isOrderClosed(orderRow.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Удалять отчёты может только администратор.' });
      return;
    }

    if (user.role !== 'admin' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'Удалить можно только свой отчёт.' });
      return;
    }

    withTransaction(db, () => {
      db.prepare('DELETE FROM visit_reports WHERE id = ?').run(reportId);
      const remaining = db.prepare('SELECT 1 FROM visit_reports WHERE visit_id = ? LIMIT 1').get(visitId);
      if(remaining && existing.is_primary===1) {
        const replacement=db.prepare('SELECT id FROM visit_reports WHERE visit_id=? ORDER BY created_at,id LIMIT 1').get(visitId);
        db.prepare('UPDATE visit_reports SET is_primary=1 WHERE id=?').run(replacement!.id);
      }
      if (!remaining) {
        db.prepare("UPDATE order_visits SET status = 'planned', actual_start_at = NULL, actual_end_at = NULL, completed_by = NULL, completed_at = NULL WHERE id = ? AND status = 'completed'").run(visitId);
        db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'completed'").run(new Date().toISOString(), orderId);
      }
      writeAuditLog(db, user.id, 'visit_report', reportId, 'report_deleted', { orderId, visitId });
    });

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
    res.json({
      ok: true,
      order: enrichOrder(
        db,
        updated,
        user.role === 'admin',
        user.id,
        user.role === 'admin' || hasPermission(user, 'reports.view_others')
      ),
    });
  });

  // Scenario A/B: take/consume/return materials or tools inside order card
  router.post('/:id/resources', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.id);
    const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId) as
      | { id: string; status: string }
      | undefined;
    if (!order) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }
    if (user.role !== 'admin' && isOrderClosed(order.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Операции со складом по закрытому заказу доступны только администратору.' });
      return;
    }

    const canTake =
      user.role === 'admin' ||
      (hasPermission(user, 'warehouse.take') && isUserAssignedToOrder(db, orderId, user.id));
    if (!canTake) {
      res.status(403).json({ error: 'Нет прав на операции с материалами и инструментами по заказу.' });
      return;
    }

    const b = req.body as {
      itemType: 'material' | 'tool';
      opType: 'issue' | 'consume' | 'return';
      materialId?: string;
      toolId?: string;
      toolInstanceId?: string;
      qty?: number;
      qtyMilli?: number;
      visitId?: string;
      note?: string;
      confirmReserved?: boolean;
    };

    try {
      const outcome = withTransaction(db, () => {
        if (b.itemType === 'material') {
          if (!b.materialId) throw new Error('Выберите материал.');
          const qtyMilli = b.qtyMilli !== undefined ? Number(b.qtyMilli) : Math.round(Number(b.qty || 0) * 1000);
          return applyMaterialOperationTx(db, {
            materialId: b.materialId,
            opType: b.opType,
            qtyMilli,
            orderId,
            visitId: b.visitId || null,
            employeeUserId: user.id,
            actorUserId: user.id,
            note: b.note,
            confirmReserved: b.confirmReserved===true,
          });
        }

        if (!b.toolId) throw new Error('Выберите инструмент.');
        if (b.opType === 'issue') {
          const opId = issueToolTx(db, {
            toolId: b.toolId,
            toolInstanceId: b.toolInstanceId,
            qty: Number(b.qty || 1),
            orderId,
            visitId: b.visitId || null,
            holderUserId: user.id,
            actorUserId: user.id,
            note: b.note,
            confirmReserved: b.confirmReserved===true,
          });
          return { operationId: opId, negativeStockWarning: false };
        }
        if (b.opType === 'return') {
          const opId = returnToolTx(db, {
            toolId: b.toolId,
            toolInstanceId: b.toolInstanceId,
            qty: Number(b.qty || 1),
            orderId,
            visitId: b.visitId || null,
            holderUserId: user.id,
            actorUserId: user.id,
            note: b.note,
            force: user.role === 'admin',
          });
          return { operationId: opId, negativeStockWarning: false };
        }
        throw new Error('Для инструментов допустимы операции issue и return.');
      });

      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
      res.status(201).json({
        ...outcome,
        order: enrichOrder(db, updated, user.role === 'admin', user.id, true),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка складской операции.' });
    }
  });

  // One-click return all outstanding tools bound to an order
  router.post('/:orderId/tools/return-all', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.orderId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined;
    if (!order) {
      res.status(404).json({ error: 'Заказ не найден.' });
      return;
    }

    const isAdmin = user.role === 'admin';
    if (!isAdmin && isOrderClosed(order.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Возвращать инструмент может только администратор.' });
      return;
    }
    const canReturn =
      isAdmin || (hasPermission(user, 'warehouse.take') && isUserAssignedToOrder(db, orderId, user.id));
    if (!canReturn) {
      res.status(403).json({ error: 'Нет прав на возврат инструмента по этому заказу.' });
      return;
    }

    try {
      const returnedCount = withTransaction(db, () => {
        let count = 0;

        const openInstances = db
          .prepare(
            `SELECT id, tool_id, holder_user_id
             FROM tool_instances
             WHERE current_order_id = ? AND status = 'issued'`
          )
          .all(orderId) as Array<{ id: string; tool_id: string; holder_user_id: string | null }>;

        for (const inst of openInstances) {
          if (!isAdmin && inst.holder_user_id && inst.holder_user_id !== user.id) continue;
          returnToolTx(db, {
            toolId: inst.tool_id,
            toolInstanceId: inst.id,
            qty: 1,
            orderId,
            holderUserId: inst.holder_user_id || user.id,
            actorUserId: user.id,
            note: 'Массовый возврат с объекта',
            force: isAdmin,
          });
          count += 1;
        }

        const openQtyTools = db
          .prepare(
            `SELECT wo.tool_id, wo.user_id,
                    SUM(CASE WHEN wo.op_type = 'issue' THEN wo.qty_milli ELSE 0 END) -
                    SUM(CASE WHEN wo.op_type = 'return' THEN wo.qty_milli ELSE 0 END) AS held_milli
             FROM warehouse_operations wo
             JOIN tools t ON t.id = wo.tool_id
             WHERE wo.item_type = 'tool' AND t.tracking_mode = 'quantity' AND wo.order_id = ?
             GROUP BY wo.tool_id, wo.user_id
             HAVING held_milli > 0`
          )
          .all(orderId) as Array<{ tool_id: string; user_id: string | null; held_milli: number }>;

        for (const row of openQtyTools) {
          if (!isAdmin && row.user_id && row.user_id !== user.id) continue;
          const wholeQty = Math.round(Number(row.held_milli || 0) / 1000);
          if (wholeQty <= 0) continue;
          returnToolTx(db, {
            toolId: row.tool_id,
            qty: wholeQty,
            orderId,
            holderUserId: row.user_id || user.id,
            actorUserId: user.id,
            note: 'Массовый возврат с объекта',
            force: isAdmin,
          });
          count += 1;
        }

        writeAuditLog(db, user.id, 'order', orderId, 'order_tools_returned_all', { returnedCount: count });
        return count;
      });

      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>;
      res.json({
        ok: true,
        returnedCount,
        order: enrichOrder(db, updated, isAdmin, user.id, true),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось вернуть инструмент.' });
    }
  });

  // Upload photo / document attachment to order or visit
  router.post('/:orderId/attachments', requireAuth, (req: AuthedRequest,res,next) => {
    const orderId=String(req.params.orderId);
    if(!db.prepare('SELECT 1 FROM orders WHERE id = ?').get(orderId)) {res.status(404).json({error:'Заказ удалён.'});return;}
    const user=req.authUser!;
    if(user.role!=='admin' && !hasPermission(user,'orders.view_all') && !isUserAssignedToOrder(db,orderId,user.id)) {res.status(403).json({error:'Нет доступа к заказу.'});return;}
    res.once('finish',()=>{
      if(req.file && (res.statusCode>=400 || res.locals.replayed)) {
        try {fs.unlinkSync(req.file.path);} catch(error) {console.error('[upload] cleanup failed',error instanceof Error ? error.message : 'unknown');}
      }
    });
    next();
  }, upload.single('file'), replaySafeMutations(db), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const orderId = String(req.params.orderId);
    const visitId = req.body.visitId ? String(req.body.visitId) : null;
    const kind = req.body.kind === 'document' ? 'document' : 'photo';
    const orderStatusRow = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as
      | { status: string }
      | undefined;
    if (!orderStatusRow) {
      res.status(404).json({ error: 'Заказ удалён.' });
      return;
    }
    if(visitId && !db.prepare('SELECT 1 FROM order_visits WHERE id = ? AND order_id = ?').get(visitId,orderId)) {
      res.status(404).json({error:'Выезд не найден в этом заказе.'});return;
    }

    const canAccess =
      user.role === 'admin' ||
      hasPermission(user, 'orders.view_all') ||
      isUserAssignedToOrder(db, orderId, user.id);

    if (!canAccess) {
      res.status(403).json({ error: 'Нет прав на загрузку файлов в этот заказ.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Файл не передан.' });
      return;
    }
    if (user.role !== 'admin' && isOrderClosed(orderStatusRow.status)) {
      if (kind !== 'photo' || !req.file.mimetype.startsWith('image/')) {
        res.status(403).json({ error: 'В закрытом заказе монтажник может загружать только фотографии.' });
        return;
      }
    }

    const entityType = visitId ? 'visit' : 'order';
    const entityId = visitId || orderId;
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO attachments (id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      attachmentId,
      entityType,
      entityId,
      kind,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      user.id,
      now
    );

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
  });

  // Authenticated attachment download/view with access check
  router.get('/attachments/:attachmentId', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const att = db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(String(req.params.attachmentId)) as
      | {
          id: string;
          entity_type: string;
          entity_id: string;
          original_name: string;
          stored_name: string;
          mime_type: string;
        }
      | undefined;

    if (!att) {
      res.status(404).json({ error: 'Файл не найден.' });
      return;
    }

    let orderId: string | null = null;
    if (att.entity_type === 'order') orderId = att.entity_id;
    if (att.entity_type === 'visit') {
      const v = db.prepare('SELECT order_id FROM order_visits WHERE id = ?').get(att.entity_id) as
        | { order_id: string }
        | undefined;
      orderId = v?.order_id || null;
    }

    if (
      user.role !== 'admin' &&
      !hasPermission(user, 'orders.view_all') &&
      (!orderId || !isUserAssignedToOrder(db, orderId, user.id))
    ) {
      res.status(403).json({ error: 'Нет доступа к этому файлу.' });
      return;
    }

    const fullPath = path.join(getUploadDir(), att.stored_name);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Файл отсутствует на диске.' });
      return;
    }

    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
    res.sendFile(fullPath);
  });

  // Delete attachment
  router.delete('/attachments/:attachmentId', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const attachmentId = String(req.params.attachmentId);
    const att = db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(attachmentId) as
      | {
          id: string;
          entity_type: string;
          entity_id: string;
          original_name: string;
          stored_name: string;
          uploaded_by: string | null;
        }
      | undefined;

    if (!att) {
      res.status(404).json({ error: 'Файл не найден.' });
      return;
    }

    let orderId: string | null = null;
    if (att.entity_type === 'order') orderId = att.entity_id;
    if (att.entity_type === 'visit') {
      const v = db.prepare('SELECT order_id FROM order_visits WHERE id = ?').get(att.entity_id) as
        | { order_id: string }
        | undefined;
      orderId = v?.order_id || null;
    }

    const orderRow = orderId
      ? (db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as { status: string } | undefined)
      : undefined;
    if (user.role !== 'admin' && orderRow && isOrderClosed(orderRow.status)) {
      res.status(403).json({ error: 'Заказ закрыт. Удалять файлы из закрытого заказа может только администратор.' });
      return;
    }

    const canDelete =
      user.role === 'admin' ||
      att.uploaded_by === user.id ||
      (orderId && hasPermission(user, 'orders.edit_assigned') && isUserAssignedToOrder(db, orderId, user.id));

    if (!canDelete) {
      res.status(403).json({ error: 'Нет прав на удаление этого файла.' });
      return;
    }

    withTransaction(db, () => {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
      scheduleFileDeletion(db,att.stored_name);
      writeAuditLog(db, user.id, 'attachment', attachmentId, 'attachment_deleted', {
        originalName: att.original_name,
        orderId,
      });
    });

    res.json({ ok: true, id: attachmentId, orderId });
  });

  return router;
}
