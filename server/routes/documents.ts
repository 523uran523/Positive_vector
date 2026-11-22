import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';
import { withTransaction } from '../db.ts';

function folder() {
  const dir = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'documents');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function legacyFolder() {
  return path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'accounting');
}

function resolveDocumentPath(storedName: string): string {
  const primary = path.join(folder(), storedName);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(legacyFolder(), storedName);
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 0);
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) {
  throw new Error('MAX_UPLOAD_BYTES must be a non-negative integer');
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, folder()),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { files: 1, ...(maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : {}) },
});

function safeName(name: string) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const value = decoded.includes('\uFFFD') ? name : decoded;
  return value.replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'Документ';
}

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

  function inlineMimeType(name: string): string {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.txt') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
  }

  router.get('/', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase('ru-RU') : '';
    const ascending = req.query.sort === 'oldest';
    const category = req.query.category === 'drawings' ? 'drawings' : 'acts';
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
    const rows = db
      .prepare(
        `SELECT d.id, d.original_name, d.size_bytes, d.created_at, d.category, d.order_id, o.order_number, o.title AS order_title
         FROM documents d
         LEFT JOIN orders o ON o.id = d.order_id
         WHERE d.category = ?${orderId ? ' AND d.order_id = ?' : ''}
         ORDER BY d.created_at ${ascending ? 'ASC' : 'DESC'}, d.id ${ascending ? 'ASC' : 'DESC'}`
      )
      .all(...(orderId ? [category, orderId] : [category])) as Array<{
      id: string;
      original_name: string;
      size_bytes: number;
      created_at: string;
      category: string;
      order_id: string | null;
      order_number: string | null;
      order_title: string | null;
    }>;
    res.json({
      documents: q
        ? rows.filter((row) =>
            `${row.original_name} ${row.order_number || ''} ${row.order_title || ''}`
              .toLocaleLowerCase('ru-RU')
              .includes(q)
          )
        : rows,
    });
  });

  router.post('/', upload.single('file'), (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Выберите файл.' });
      return;
    }
    const id = crypto.randomUUID();
    const stored = req.file.filename;
    const name = safeName(req.file.originalname);
    const now = new Date().toISOString();
    const category = req.body.category === 'drawings' ? 'drawings' : 'acts';
    const rawOrderId = typeof req.body.orderId === 'string' ? req.body.orderId.trim() : '';
    const orderId = rawOrderId || null;
    const target = path.join(folder(), stored);
    if (orderId && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(orderId)) {
      fs.rmSync(target, { force: true });
      res.status(400).json({ error: 'Указанный заказ не найден.' });
      return;
    }
    const linkedOrder = orderId
      ? (db.prepare('SELECT order_number, title FROM orders WHERE id = ?').get(orderId) as
          | { order_number: string; title: string }
          | undefined)
      : undefined;
    try {
      fs.chmodSync(target, 0o600);
      withTransaction(db, () => {
        db.prepare(
          'INSERT INTO documents(id, original_name, stored_name, size_bytes, uploaded_by, created_at, category, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, name, stored, req.file!.size, req.authUser!.id, now, category, orderId);
        writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_uploaded', { orderId });
      });
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    }
    res.status(201).json({
      document: {
        id,
        original_name: name,
        size_bytes: req.file.size,
        created_at: now,
        category,
        order_id: orderId,
        order_number: linkedOrder?.order_number || null,
        order_title: linkedOrder?.title || null,
      },
    });
  });

  router.patch('/:id', (req: AuthedRequest, res) => {
    const category = req.body?.category;
    const hasCategory = category !== undefined;
    const hasOrderId = req.body?.orderId !== undefined;
    if (hasCategory && category !== 'acts' && category !== 'drawings') {
      res.status(400).json({ error: 'Выберите категорию документа.' });
      return;
    }
    if (!hasCategory && !hasOrderId) {
      res.status(400).json({ error: 'Выберите категорию документа.' });
      return;
    }
    const id = String(req.params.id);
    const existing = db.prepare('SELECT category, order_id FROM documents WHERE id = ?').get(id) as
      | { category: string; order_id: string | null }
      | undefined;
    if (!existing) {
      res.sendStatus(404);
      return;
    }
    const nextCategory = hasCategory ? category : existing.category;
    const nextOrderId = hasOrderId
      ? (typeof req.body.orderId === 'string' && req.body.orderId.trim() ? req.body.orderId.trim() : null)
      : existing.order_id;
    if (nextOrderId && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(nextOrderId)) {
      res.status(400).json({ error: 'Указанный заказ не найден.' });
      return;
    }
    withTransaction(db, () => {
      db.prepare('UPDATE documents SET category = ?, order_id = ? WHERE id = ?').run(nextCategory, nextOrderId, id);
      writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_moved', {
        category: nextCategory,
        orderId: nextOrderId,
      });
    });
    res.json({ ok: true });
  });

  router.delete('/:id', (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const row = db
      .prepare('SELECT stored_name FROM documents WHERE id = ?')
      .get(id) as { stored_name: string } | undefined;
    if (!row) {
      res.sendStatus(404);
      return;
    }
    if (!/^[0-9a-f-]{36}$/.test(row.stored_name)) {
      res.sendStatus(500);
      return;
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_deleted', {});
    });
    fs.rmSync(path.join(folder(), row.stored_name), { force: true });
    fs.rmSync(path.join(legacyFolder(), row.stored_name), { force: true });
    res.status(204).end();
  });

  router.get('/:id/download', (req, res) => {
    const row = db
      .prepare('SELECT original_name, stored_name FROM documents WHERE id = ?')
      .get(String(req.params.id)) as { original_name: string; stored_name: string } | undefined;
    if (!row) {
      res.sendStatus(404);
      return;
    }
    if (!/^[0-9a-f-]{36}$/.test(row.stored_name)) {
      res.sendStatus(500);
      return;
    }
    const inline = req.query.inline === '1';
    const contentType = inline ? inlineMimeType(row.original_name) : 'application/octet-stream';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `${inline && contentType !== 'application/octet-stream' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`
    );
    res.sendFile(resolveDocumentPath(row.stored_name));
  });

  return router;
}
