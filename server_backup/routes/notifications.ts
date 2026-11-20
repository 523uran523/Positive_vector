import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';

export function createNotificationsRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_id = ?
         ORDER BY is_read ASC, created_at DESC
         LIMIT 80`
      )
      .all(req.authUser!.id);
    const unreadRow = db
      .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.authUser!.id) as { cnt: number };
    res.json({ notifications: rows, unreadCount: unreadRow.cnt });
  });

  router.post('/:id/read', requireAuth, (req: AuthedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(
      String(req.params.id),
      req.authUser!.id
    );
    res.json({ ok: true });
  });

  router.post('/read-all', requireAuth, (req: AuthedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.authUser!.id);
    res.json({ ok: true });
  });

  return router;
}
