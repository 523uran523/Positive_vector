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
  const dir = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'accounting');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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

  router.get('/', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase('ru-RU') : '';
    const ascending = req.query.sort === 'oldest';
    const category = req.query.category === 'drawings' ? 'drawings' : 'acts';
    const rows = db
      .prepare(
        `SELECT id, original_name, size_bytes, created_at, category
         FROM documents
         WHERE category = ?
         ORDER BY created_at ${ascending ? 'ASC' : 'DESC'}, id ${ascending ? 'ASC' : 'DESC'}`
      )
      .all(category) as Array<{ id: string; original_name: string; size_bytes: number; created_at: string; category: string }>;
    res.json({ documents: q ? rows.filter((row) => row.original_name.toLocaleLowerCase('ru-RU').includes(q)) : rows });
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
    const target = path.join(folder(), stored);
    try {
      fs.chmodSync(target, 0o600);
      withTransaction(db, () => {
        db.prepare(
          'INSERT INTO documents(id, original_name, stored_name, size_bytes, uploaded_by, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, name, stored, req.file!.size, req.authUser!.id, now, category);
        writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_uploaded', {});
      });
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    }
    res.status(201).json({ document: { id, original_name: name, size_bytes: req.file.size, created_at: now, category } });
  });

  router.patch('/:id', (req: AuthedRequest, res) => {
    const category = req.body?.category;
    if (category !== 'acts' && category !== 'drawings') {
      res.status(400).json({ error: 'Выберите категорию документа.' });
      return;
    }
    const id = String(req.params.id);
    if (!db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id)) {
      res.sendStatus(404);
      return;
    }
    withTransaction(db, () => {
      db.prepare('UPDATE documents SET category = ? WHERE id = ?').run(category, id);
      writeAuditLog(db, req.authUser!.id, 'accounting_document', id, 'accounting_document_moved', { category });
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
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.sendFile(path.join(folder(), row.stored_name));
  });

  return router;
}
