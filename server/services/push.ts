import * as webpush from 'web-push';
import type { DatabaseSync } from 'node:sqlite';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  roomId?: string;
}

export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string
) => Promise<unknown>;

let customSender: PushSender | null = null;
let configuredKeyPair = '';

export function setPushSenderForTests(sender: PushSender | null): void {
  customSender = sender;
}

function getVapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = (process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) return null;
  const subject = (process.env.WEB_PUSH_SUBJECT || 'mailto:admin@example.com').trim();
  const keyPair = `${subject}|${publicKey}|${privateKey}`;
  if (configuredKeyPair !== keyPair) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configuredKeyPair = keyPair;
  }
  return { publicKey, privateKey, subject };
}

export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey || null;
}

export function isPushConfigured(): boolean {
  return Boolean(getVapidConfig());
}

export function isValidPushSubscription(sub: unknown): sub is {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  if (!sub || typeof sub !== 'object') return false;
  const candidate = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof candidate.endpoint !== 'string' || !candidate.endpoint) return false;
  if (
    typeof candidate.keys?.p256dh !== 'string' ||
    !candidate.keys.p256dh ||
    typeof candidate.keys?.auth !== 'string' ||
    !candidate.keys.auth
  ) {
    return false;
  }
  try {
    const url = new URL(candidate.endpoint);
    const hostAllowed =
      ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname) ||
      url.hostname.endsWith('.push.apple.com') ||
      url.hostname.endsWith('.notify.windows.com');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !hostAllowed
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function savePushSubscription(
  db: DatabaseSync,
  userId: string,
  sessionId: string | null,
  sub: unknown
): void {
  if (!isValidPushSubscription(sub)) {
    throw new Error('INVALID_PUSH_SUBSCRIPTION');
  }
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, session_id, subscription_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       session_id = excluded.session_id,
       subscription_json = excluded.subscription_json`
  ).run(sub.endpoint, userId, sessionId, JSON.stringify(sub), new Date().toISOString());
}

export function removePushSubscription(
  db: DatabaseSync,
  userId: string,
  options: { endpoint?: string; sessionId?: string } = {}
): void {
  if (options.endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(
      options.endpoint,
      userId
    );
    return;
  }
  if (options.sessionId) {
    db.prepare('DELETE FROM push_subscriptions WHERE session_id = ? AND user_id = ?').run(
      options.sessionId,
      userId
    );
    return;
  }
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}

async function deliverToRows(
  db: DatabaseSync,
  rows: Array<{ endpoint: string; subscription_json: string }>,
  payload: PushPayload
): Promise<void> {
  if (!rows.length) return;
  if (!customSender && !getVapidConfig()) return;

  const sender: PushSender =
    customSender || ((sub, data) => webpush.sendNotification(sub, data));
  const serialized = JSON.stringify({
    title: payload.title,
    body: payload.body.slice(0, 180),
    tag: payload.tag || undefined,
    url: payload.url || '/',
    roomId: payload.roomId || undefined,
  });

  await Promise.all(
    rows.map(async (row) => {
      try {
        const sub = JSON.parse(row.subscription_json) as webpush.PushSubscription;
        await sender(sub, serialized);
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          try {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
          } catch {
            // DB may already be closed in tests.
          }
        }
      }
    })
  );
}

export async function sendPushToUser(
  db: DatabaseSync,
  userId: string,
  payload: PushPayload
): Promise<void> {
  if (!customSender && !getVapidConfig()) return;
  let rows: Array<{ endpoint: string; subscription_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT p.endpoint, p.subscription_json
         FROM push_subscriptions p
         JOIN users u ON u.id = p.user_id
         WHERE p.user_id = ? AND u.is_active = 1 AND u.dismissed_at IS NULL`
      )
      .all(userId) as Array<{ endpoint: string; subscription_json: string }>;
  } catch {
    return;
  }
  await deliverToRows(db, rows, payload);
}

export async function sendPushToRoom(
  db: DatabaseSync,
  roomId: string,
  excludeUserId: string,
  payload: PushPayload
): Promise<void> {
  if (!customSender && !getVapidConfig()) return;
  let rows: Array<{ endpoint: string; subscription_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT p.endpoint, p.subscription_json
         FROM push_subscriptions p
         JOIN users u ON u.id = p.user_id
         WHERE p.user_id != ?
           AND u.is_active = 1
           AND u.dismissed_at IS NULL
           AND (? = 'general' OR EXISTS (
             SELECT 1 FROM chat_room_members m WHERE m.room_id = ? AND m.user_id = p.user_id
           ))`
      )
      .all(excludeUserId, roomId, roomId) as Array<{
      endpoint: string;
      subscription_json: string;
    }>;
  } catch {
    return;
  }
  await deliverToRows(db, rows, payload);
}

export function notifyPush(db: DatabaseSync, userId: string, payload: PushPayload): void {
  if (!customSender && !getVapidConfig()) return;
  setImmediate(() => {
    void sendPushToUser(db, userId, payload).catch(() => {});
  });
}
