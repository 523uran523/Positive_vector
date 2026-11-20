import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';

export function createSettingsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/', requireAuth, (_req, res) => {
    const rows = db.prepare('SELECT key, value_json, updated_at FROM settings').all() as Array<{
      key: string;
      value_json: string;
      updated_at: string;
    }>;
    const settings: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        settings[r.key] = JSON.parse(r.value_json);
      } catch {
        settings[r.key] = r.value_json;
      }
    }
    res.json({ settings });
  });

  router.put('/', requireAdmin, (req: AuthedRequest, res) => {
    const updates = req.body as Record<string, unknown>;
    const allowedKeys = new Set([
      'company_name',
      'default_shift_rate_kopecks',
      'order_tags',
      'expense_categories',
      'units',
      'material_categories',
      'default_theme',
      'email_notifications',
    ]);

    const now = new Date().toISOString();
    withTransaction(db, () => {
      const stmt = db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      );
      for (const [k, v] of Object.entries(updates)) {
        if (!allowedKeys.has(k)) continue;
        stmt.run(k, JSON.stringify(v), now);
      }
      writeAuditLog(db, req.authUser!.id, 'settings', 'global', 'settings_updated', {
        keys: Object.keys(updates).filter((k) => allowedKeys.has(k)),
      });
    });

    res.json({ ok: true });
  });

  router.get('/audit-log', requireAdmin, (_req, res) => {
    const logs = db
      .prepare(
        `SELECT al.*, u.full_name as actor_name, u.login as actor_login
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ORDER BY al.created_at DESC
         LIMIT 120`
      )
      .all();
    res.json({ logs });
  });

  return router;
}
