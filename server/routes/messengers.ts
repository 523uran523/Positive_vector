import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import {
  createMessengerLink,
  getMessengerStatus,
  getWebhookSecret,
  handleIncomingMessage,
  isMessengerConfigured,
  parseMaxUpdate,
  parseTelegramUpdate,
  sendMessengerReply,
  sendMessengerToUser,
  setupMessengerWebhooks,
  unlinkMessenger,
  type MessengerChannel,
} from '../services/messengers.ts';

function normalizeChannel(value: unknown): MessengerChannel | null {
  return value === 'telegram' || value === 'max' ? value : null;
}

export function createMessengersRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/status', requireAuth, (req: AuthedRequest, res) => {
    res.json(getMessengerStatus(db, req.authUser!.id));
  });

  router.post('/link', requireAuth, (req: AuthedRequest, res) => {
    const channel = normalizeChannel(req.body?.channel);
    if (!channel) {
      res.status(400).json({ error: 'Неизвестный мессенджер.' });
      return;
    }
    if (!isMessengerConfigured(channel)) {
      res.status(503).json({ error: 'Этот мессенджер ещё не настроен на сервере.' });
      return;
    }
    try {
      res.json(createMessengerLink(db, req.authUser!.id, channel));
    } catch {
      res.status(503).json({ error: 'Не удалось создать код подключения.' });
    }
  });

  router.post('/unlink', requireAuth, (req: AuthedRequest, res) => {
    const channel = normalizeChannel(req.body?.channel);
    if (!channel) {
      res.status(400).json({ error: 'Неизвестный мессенджер.' });
      return;
    }
    unlinkMessenger(db, req.authUser!.id, channel);
    res.json({ ok: true });
  });

  router.post('/test', requireAuth, async (req: AuthedRequest, res) => {
    const channel = normalizeChannel(req.body?.channel);
    if (!channel) {
      res.status(400).json({ error: 'Неизвестный мессенджер.' });
      return;
    }
    if (!isMessengerConfigured(channel)) {
      res.status(503).json({ error: 'Этот мессенджер ещё не настроен на сервере.' });
      return;
    }
    try {
      await sendMessengerToUser(db, req.authUser!.id, channel, {
        title: 'Проверка уведомлений',
        body: 'Если вы это видите, уведомления из CRM работают.',
        url: '/',
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Не удалось отправить сообщение.',
      });
    }
  });

  router.post('/setup', requireAdmin, async (_req, res) => {
    const results = await setupMessengerWebhooks();
    res.json({ ok: true, results });
  });

  router.post('/telegram/webhook', (req, res) => {
    const secret = getWebhookSecret();
    if (secret && req.header('x-telegram-bot-api-secret-token') !== secret) {
      res.status(403).json({ ok: false });
      return;
    }
    const incoming = parseTelegramUpdate(req.body);
    res.json({ ok: true });
    if (!incoming) return;
    const reply = handleIncomingMessage(db, incoming);
    void sendMessengerReply(incoming.channel, incoming.externalId, reply).catch(() => {});
  });

  router.post('/max/webhook', (req, res) => {
    const secret = getWebhookSecret();
    if (secret && req.header('x-max-bot-api-secret') !== secret) {
      res.status(403).json({ ok: false });
      return;
    }
    const incoming = parseMaxUpdate(req.body);
    res.json({ ok: true });
    if (!incoming) return;
    const reply = handleIncomingMessage(db, incoming);
    void sendMessengerReply(incoming.channel, incoming.externalId, reply).catch(() => {});
  });

  return router;
}
