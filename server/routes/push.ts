import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import {
  getVapidPublicKey,
  isPushConfigured,
  removePushSubscription,
  savePushSubscription,
} from '../services/push.ts';

export function createPushRouter(db: DatabaseSync): express.Router {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/key', (_req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  router.post('/subscription', (req: AuthedRequest, res) => {
    if (!isPushConfigured()) {
      res.status(503).json({ error: 'Push-уведомления ещё не настроены на сервере.' });
      return;
    }
    try {
      savePushSubscription(db, req.authUser!.id, req.sessionId || null, req.body);
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: 'Некорректная подписка.' });
    }
  });

  router.delete('/subscription', (req: AuthedRequest, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
    removePushSubscription(db, req.authUser!.id, {
      endpoint,
      sessionId: endpoint ? undefined : req.sessionId,
    });
    res.json({ ok: true });
  });

  return router;
}
