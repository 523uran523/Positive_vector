import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type MessengerChannel = 'telegram' | 'max';

export interface MessengerPayload {
  title: string;
  body: string;
  url?: string;
}

export type MessengerSender = (
  channel: MessengerChannel,
  externalId: string,
  payload: MessengerPayload
) => Promise<void>;

export interface MessengerChannelStatus {
  configured: boolean;
  linked: boolean;
  username: string;
  botUsername: string;
}

export interface MessengerStatus {
  telegram: MessengerChannelStatus;
  max: MessengerChannelStatus;
}

export interface LinkTokenInfo {
  channel: MessengerChannel;
  code: string;
  url: string | null;
  botUsername: string;
  expiresAt: string;
}

export type LinkFailure = 'TOKEN_NOT_FOUND' | 'TOKEN_EXPIRED' | 'TOKEN_USED' | 'CHANNEL_MISMATCH';

export interface IncomingMessengerMessage {
  channel: MessengerChannel;
  externalId: string;
  username: string;
  text: string;
}

export const MESSENGER_LINK_TTL_MINUTES = 30;

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_API = 'https://platform-api2.max.ru';

let customSender: MessengerSender | null = null;

export function setMessengerSenderForTests(sender: MessengerSender | null): void {
  customSender = sender;
}

export function getTelegramToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

export function getTelegramBotUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
}

export function getMaxToken(): string {
  return (process.env.MAX_BOT_TOKEN || '').trim();
}

export function getMaxBotUsername(): string {
  return (process.env.MAX_BOT_USERNAME || '').trim().replace(/^@/, '');
}

export function getPublicUrl(): string {
  return (process.env.PUBLIC_URL || 'https://crm.gulya-studio.ru').trim().replace(/\/+$/, '');
}

export function getWebhookSecret(): string {
  return (process.env.MESSENGER_WEBHOOK_SECRET || '').trim();
}

export function isMessengerConfigured(channel: MessengerChannel): boolean {
  return channel === 'telegram'
    ? Boolean(getTelegramToken() && getTelegramBotUsername())
    : Boolean(getMaxToken() && getMaxBotUsername());
}

export function isAnyMessengerConfigured(): boolean {
  return isMessengerConfigured('telegram') || isMessengerConfigured('max');
}

function botUsername(channel: MessengerChannel): string {
  return channel === 'telegram' ? getTelegramBotUsername() : getMaxBotUsername();
}

function newToken(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function createMessengerLink(
  db: DatabaseSync,
  userId: string,
  channel: MessengerChannel
): LinkTokenInfo {
  if (!isMessengerConfigured(channel)) {
    throw new Error('MESSENGER_NOT_CONFIGURED');
  }
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MESSENGER_LINK_TTL_MINUTES * 60_000).toISOString();
  db.prepare('DELETE FROM messenger_link_tokens WHERE user_id = ? AND channel = ?').run(userId, channel);
  db.prepare(
    `INSERT INTO messenger_link_tokens (token, user_id, channel, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(token, userId, channel, now.toISOString(), expiresAt);

  const username = botUsername(channel);
  const url =
    channel === 'telegram'
      ? `https://t.me/${username}?start=${token}`
      : `https://max.ru/${username}?start=${token}`;

  return { channel, code: token, url, botUsername: username, expiresAt };
}

export function linkMessengerByToken(
  db: DatabaseSync,
  channel: MessengerChannel,
  rawToken: string,
  externalId: string,
  username: string
): { ok: true; userId: string } | { ok: false; reason: LinkFailure } {
  const token = String(rawToken || '').trim().toLowerCase();
  const row = db
    .prepare(
      'SELECT token, user_id, channel, expires_at, used_at FROM messenger_link_tokens WHERE token = ?'
    )
    .get(token) as
    | { token: string; user_id: string; channel: string; expires_at: string; used_at: string | null }
    | undefined;

  if (!row) return { ok: false, reason: 'TOKEN_NOT_FOUND' };
  if (row.channel !== channel) return { ok: false, reason: 'CHANNEL_MISMATCH' };
  if (row.used_at) return { ok: false, reason: 'TOKEN_USED' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'TOKEN_EXPIRED' };

  const linkedAt = new Date().toISOString();
  if (channel === 'telegram') {
    db.prepare(
      `UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL, telegram_linked_at = NULL
       WHERE telegram_chat_id = ? AND id != ?`
    ).run(externalId, row.user_id);
    db.prepare(
      'UPDATE users SET telegram_chat_id = ?, telegram_username = ?, telegram_linked_at = ? WHERE id = ?'
    ).run(externalId, username || '', linkedAt, row.user_id);
  } else {
    db.prepare(
      `UPDATE users SET max_user_id = NULL, max_username = NULL, max_linked_at = NULL
       WHERE max_user_id = ? AND id != ?`
    ).run(externalId, row.user_id);
    db.prepare(
      'UPDATE users SET max_user_id = ?, max_username = ?, max_linked_at = ? WHERE id = ?'
    ).run(externalId, username || '', linkedAt, row.user_id);
  }
  db.prepare('UPDATE messenger_link_tokens SET used_at = ? WHERE token = ?').run(linkedAt, token);
  return { ok: true, userId: row.user_id };
}

export function unlinkMessenger(
  db: DatabaseSync,
  userId: string,
  channel: MessengerChannel
): void {
  if (channel === 'telegram') {
    db.prepare(
      'UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL, telegram_linked_at = NULL WHERE id = ?'
    ).run(userId);
  } else {
    db.prepare(
      'UPDATE users SET max_user_id = NULL, max_username = NULL, max_linked_at = NULL WHERE id = ?'
    ).run(userId);
  }
}

function findUserByExternalId(
  db: DatabaseSync,
  channel: MessengerChannel,
  externalId: string
): string | null {
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_user_id';
  const row = db
    .prepare(`SELECT id FROM users WHERE ${column} = ?`)
    .get(externalId) as { id: string } | undefined;
  return row?.id || null;
}

export function getMessengerStatus(db: DatabaseSync, userId: string): MessengerStatus {
  const row = db
    .prepare(
      `SELECT telegram_chat_id, telegram_username, max_user_id, max_username
       FROM users WHERE id = ?`
    )
    .get(userId) as
    | {
        telegram_chat_id: string | null;
        telegram_username: string | null;
        max_user_id: string | null;
        max_username: string | null;
      }
    | undefined;

  return {
    telegram: {
      configured: isMessengerConfigured('telegram'),
      linked: Boolean(row?.telegram_chat_id),
      username: row?.telegram_username || '',
      botUsername: getTelegramBotUsername(),
    },
    max: {
      configured: isMessengerConfigured('max'),
      linked: Boolean(row?.max_user_id),
      username: row?.max_username || '',
      botUsername: getMaxBotUsername(),
    },
  };
}

function formatMessage(payload: MessengerPayload): string {
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  const text = body ? `${title}\n${body}` : title;
  return text.slice(0, 3500);
}

function absoluteUrl(url?: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${getPublicUrl()}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

async function sendTelegram(chatId: string, payload: MessengerPayload): Promise<void> {
  const token = getTelegramToken();
  if (!token) throw new Error('TELEGRAM_NOT_CONFIGURED');
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: formatMessage(payload),
    disable_web_page_preview: true,
  };
  const url = absoluteUrl(payload.url);
  if (url) {
    body.reply_markup = { inline_keyboard: [[{ text: 'Перейти', url }]] };
  }
  const result = await postJson(`${TELEGRAM_API}/bot${token}/sendMessage`, {}, body);
  if (!result.ok) {
    throw new Error(`TELEGRAM_HTTP_${result.status}: ${result.text.slice(0, 200)}`);
  }
}

async function sendMax(userId: string, payload: MessengerPayload): Promise<void> {
  const token = getMaxToken();
  if (!token) throw new Error('MAX_NOT_CONFIGURED');
  const body: Record<string, unknown> = { text: formatMessage(payload) };
  const url = absoluteUrl(payload.url);
  if (url) {
    body.attachments = [
      {
        type: 'inline_keyboard',
        payload: { buttons: [[{ type: 'link', text: 'Перейти', url }]] },
      },
    ];
  }
  const result = await postJson(
    `${MAX_API}/messages?user_id=${encodeURIComponent(userId)}`,
    { Authorization: token },
    body
  );
  if (!result.ok) {
    throw new Error(`MAX_HTTP_${result.status}: ${result.text.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(result.text) as { success?: boolean; message?: string };
    if (parsed && parsed.success === false) {
      throw new Error(`MAX_API_ERROR: ${parsed.message || 'unknown'}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) return;
    throw err;
  }
}

async function deliver(
  channel: MessengerChannel,
  externalId: string,
  payload: MessengerPayload
): Promise<void> {
  if (customSender) {
    await customSender(channel, externalId, payload);
    return;
  }
  if (channel === 'telegram') {
    await sendTelegram(externalId, payload);
  } else {
    await sendMax(externalId, payload);
  }
}

export async function sendMessengerToUser(
  db: DatabaseSync,
  userId: string,
  channel: MessengerChannel,
  payload: MessengerPayload
): Promise<void> {
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_user_id';
  const row = db
    .prepare(
      `SELECT ${column} AS external_id FROM users
       WHERE id = ? AND is_active = 1 AND dismissed_at IS NULL`
    )
    .get(userId) as { external_id: string | null } | undefined;
  if (!row?.external_id) return;
  if (!customSender && !isMessengerConfigured(channel)) return;
  await deliver(channel, String(row.external_id), payload);
}

export async function sendMessengersToUser(
  db: DatabaseSync,
  userId: string,
  payload: MessengerPayload
): Promise<void> {
  if (!customSender && !isAnyMessengerConfigured()) return;
  const row = db
    .prepare(
      `SELECT telegram_chat_id, max_user_id FROM users
       WHERE id = ? AND is_active = 1 AND dismissed_at IS NULL`
    )
    .get(userId) as
    | { telegram_chat_id: string | null; max_user_id: string | null }
    | undefined;
  if (!row) return;

  const jobs: Array<Promise<void>> = [];
  if (row.telegram_chat_id && (customSender || isMessengerConfigured('telegram'))) {
    jobs.push(deliver('telegram', String(row.telegram_chat_id), payload));
  }
  if (row.max_user_id && (customSender || isMessengerConfigured('max'))) {
    jobs.push(deliver('max', String(row.max_user_id), payload));
  }
  await Promise.allSettled(jobs);
}

export function notifyMessengers(
  db: DatabaseSync,
  userId: string,
  payload: MessengerPayload
): void {
  if (!customSender && !isAnyMessengerConfigured()) return;
  setImmediate(() => {
    void sendMessengersToUser(db, userId, payload).catch(() => {});
  });
}

export async function sendMessengersToRoom(
  db: DatabaseSync,
  roomId: string,
  excludeUserId: string,
  payload: MessengerPayload
): Promise<void> {
  if (!customSender && !isAnyMessengerConfigured()) return;
  let rows: Array<{ telegram_chat_id: string | null; max_user_id: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT u.telegram_chat_id, u.max_user_id
         FROM users u
         WHERE u.id != ?
           AND u.is_active = 1
           AND u.dismissed_at IS NULL
           AND (u.telegram_chat_id IS NOT NULL OR u.max_user_id IS NOT NULL)
           AND (? = 'general' OR EXISTS (
             SELECT 1 FROM chat_room_members m WHERE m.room_id = ? AND m.user_id = u.id
           ))`
      )
      .all(excludeUserId, roomId, roomId) as Array<{
      telegram_chat_id: string | null;
      max_user_id: string | null;
    }>;
  } catch {
    return;
  }

  const jobs: Array<Promise<void>> = [];
  for (const row of rows) {
    if (row.telegram_chat_id && (customSender || isMessengerConfigured('telegram'))) {
      jobs.push(deliver('telegram', String(row.telegram_chat_id), payload));
    }
    if (row.max_user_id && (customSender || isMessengerConfigured('max'))) {
      jobs.push(deliver('max', String(row.max_user_id), payload));
    }
  }
  await Promise.allSettled(jobs);
}

export function notifyMessengersToRoom(
  db: DatabaseSync,
  roomId: string,
  excludeUserId: string,
  payload: MessengerPayload
): void {
  if (!customSender && !isAnyMessengerConfigured()) return;
  setImmediate(() => {
    void sendMessengersToRoom(db, roomId, excludeUserId, payload).catch(() => {});
  });
}

export function parseTelegramUpdate(update: unknown): IncomingMessengerMessage | null {
  const message = (update as { message?: Record<string, any> } | null)?.message;
  const chatId = message?.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  return {
    channel: 'telegram',
    externalId: String(chatId),
    username: String(message?.from?.username || ''),
    text: String(message?.text || ''),
  };
}

export function parseMaxUpdate(update: unknown): IncomingMessengerMessage | null {
  const payload = update as Record<string, any> | null;
  if (!payload) return null;
  if (payload.update_type === 'message_created') {
    const message = payload.message;
    const userId = message?.sender?.user_id;
    if (userId === undefined || userId === null) return null;
    return {
      channel: 'max',
      externalId: String(userId),
      username: String(message?.sender?.username || ''),
      text: String(message?.body?.text || ''),
    };
  }
  if (payload.update_type === 'bot_started') {
    const userId = payload.user?.user_id ?? payload.message?.sender?.user_id;
    if (userId === undefined || userId === null) return null;
    return {
      channel: 'max',
      externalId: String(userId),
      username: String(payload.user?.username || ''),
      text: payload.payload ? String(payload.payload) : '/start',
    };
  }
  return null;
}

function extractToken(text: string): string {
  const cleaned = text.replace(/^\/start(@\w+)?\s*/i, '').trim();
  return /^[a-f0-9]{8}$/i.test(cleaned) ? cleaned.toLowerCase() : '';
}

const HELP_TEXT =
  'Чтобы включить уведомления, откройте CRM → Настройки → «Уведомления в мессенджерах», нажмите «Подключить» и отправьте сюда код из 8 символов.';

export function handleIncomingMessage(db: DatabaseSync, message: IncomingMessengerMessage): string {
  const text = message.text.trim();

  if (/^\/(stop|unlink)\b/i.test(text)) {
    const userId = findUserByExternalId(db, message.channel, message.externalId);
    if (!userId) return 'Этот мессенджер не привязан к CRM. ' + HELP_TEXT;
    unlinkMessenger(db, userId, message.channel);
    return 'Уведомления отключены. Включить снова можно в CRM → Настройки.';
  }

  const token = extractToken(text);
  if (!token) return HELP_TEXT;

  const result = linkMessengerByToken(
    db,
    message.channel,
    token,
    message.externalId,
    message.username
  );
  if (result.ok) {
    return 'Готово! Уведомления из CRM включены. Отключить: команда /stop.';
  }
  switch (result.reason) {
    case 'TOKEN_EXPIRED':
      return 'Код устарел. Откройте CRM → Настройки → «Уведомления в мессенджерах» и получите новый.';
    case 'TOKEN_USED':
      return 'Этот код уже использован. Получите новый в CRM → Настройки.';
    default:
      return 'Код не найден. Проверьте, что скопировали его целиком. ' + HELP_TEXT;
  }
}

export async function sendMessengerReply(
  channel: MessengerChannel,
  externalId: string,
  text: string
): Promise<void> {
  if (customSender) {
    await customSender(channel, externalId, { title: text, body: '' });
    return;
  }
  if (channel === 'telegram') {
    await sendTelegram(externalId, { title: text, body: '' });
  } else {
    await sendMax(externalId, { title: text, body: '' });
  }
}

export async function setupMessengerWebhooks(): Promise<string[]> {
  const messages: string[] = [];
  const base = getPublicUrl();
  const secret = getWebhookSecret();

  if (isMessengerConfigured('telegram')) {
    const url = `${base}/api/messengers/telegram/webhook`;
    try {
      const result = await postJson(
        `${TELEGRAM_API}/bot${getTelegramToken()}/setWebhook`,
        {},
        {
          url,
          secret_token: secret || undefined,
          allowed_updates: ['message'],
        }
      );
      messages.push(`telegram: ${result.ok ? 'ok' : `error ${result.status}`}`);
    } catch (err) {
      messages.push(`telegram: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  if (isMessengerConfigured('max')) {
    const url = `${base}/api/messengers/max/webhook`;
    try {
      const result = await postJson(
        `${MAX_API}/subscriptions`,
        { Authorization: getMaxToken() },
        {
          url,
          update_types: ['message_created', 'bot_started'],
          secret: secret || undefined,
        }
      );
      messages.push(`max: ${result.ok ? 'ok' : `error ${result.status}`}`);
    } catch (err) {
      messages.push(`max: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  return messages;
}
