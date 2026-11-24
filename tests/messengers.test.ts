import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { notifyUser } from '../server/security.ts';
import {
  handleIncomingMessage,
  parseMaxUpdate,
  parseTelegramUpdate,
  sendMessengersToRoom,
  setMessengerSenderForTests,
  type MessengerChannel,
  type MessengerPayload,
} from '../server/services/messengers.ts';
import { inject } from './httpHarness.ts';

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'MAX_BOT_TOKEN',
  'MAX_BOT_USERNAME',
  'PUBLIC_URL',
  'MESSENGER_WEBHOOK_SECRET',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCaller(app: ReturnType<typeof createApp>) {
  let cookie = '';
  let csrf = '';
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers }
    );
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { res, status: res.status, data };
  }
  return {
    call,
    setAuth(nextCookie: string, nextCsrf: string) {
      cookie = nextCookie;
      csrf = nextCsrf;
    },
  };
}

test('messengers: привязка через бота, уведомление со ссылкой, отключение', async () => {
  const restoreEnv = withEnv({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_BOT_USERNAME: '@pozitiv_test_bot',
    MAX_BOT_TOKEN: 'max-test-token',
    MAX_BOT_USERNAME: 'pozitiv_test_bot',
    PUBLIC_URL: 'https://crm.example.test',
    MESSENGER_WEBHOOK_SECRET: 'test-secret',
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  const sent: Array<{ channel: MessengerChannel; externalId: string; payload: MessengerPayload }> = [];
  setMessengerSenderForTests(async (channel, externalId, payload) => {
    sent.push({ channel, externalId, payload });
  });
  const client = makeCaller(app);

  try {
    const setup = await client.call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    client.setAuth(setup.res.headers.get('set-cookie')!.split(';')[0], setup.data.csrfToken);

    const worker = await client.call('POST', '/api/users', {
      login: 'worker',
      fullName: 'Worker',
      password: 'long-password-123',
    });
    const workerId = worker.data.user.id as string;

    const login = await client.call('POST', '/api/auth/login', {
      login: 'worker',
      password: 'long-password-123',
    });
    client.setAuth(login.res.headers.get('set-cookie')!.split(';')[0], login.data.csrfToken);

    const initial = await client.call('GET', '/api/messengers/status');
    assert.equal(initial.status, 200);
    assert.equal(initial.data.telegram.configured, true);
    assert.equal(initial.data.telegram.linked, false);
    assert.equal(initial.data.telegram.botUsername, 'pozitiv_test_bot');
    assert.equal(initial.data.max.configured, true);

    const link = await client.call('POST', '/api/messengers/link', { channel: 'telegram' });
    assert.equal(link.status, 200);
    assert.match(link.data.code, /^[a-f0-9]{8}$/);
    assert.equal(link.data.url, `https://t.me/pozitiv_test_bot?start=${link.data.code}`);
    assert.ok(new Date(link.data.expiresAt).getTime() > Date.now());

    // Сотрудник нажал «Старт» и прислал код — привязка выполняется ботом.
    const incoming = parseTelegramUpdate({
      message: { chat: { id: 555000111 }, from: { username: 'worker_tg' }, text: `/start ${link.data.code}` },
    });
    assert.ok(incoming);
    assert.match(handleIncomingMessage(db, incoming!), /Готово/);

    const linked = await client.call('GET', '/api/messengers/status');
    assert.equal(linked.data.telegram.linked, true);
    assert.equal(linked.data.telegram.username, 'worker_tg');

    // Повторное использование кода отклоняется.
    assert.match(handleIncomingMessage(db, incoming!), /уже использован/);

    // Задача для сотрудника уходит в привязанный Telegram со ссылкой «Перейти».
    notifyUser(db, workerId, 'order_assigned', 'Новый заказ', 'Заказ №42', 'order', 'ord-42');
    await wait();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'telegram');
    assert.equal(sent[0].externalId, '555000111');
    assert.equal(sent[0].payload.title, 'Новый заказ');
    assert.equal(sent[0].payload.url, '/?order=ord-42');

    const testMessage = await client.call('POST', '/api/messengers/test', { channel: 'telegram' });
    assert.equal(testMessage.status, 200);
    await wait();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].payload.title, 'Проверка уведомлений');

    const unlink = await client.call('POST', '/api/messengers/unlink', { channel: 'telegram' });
    assert.equal(unlink.status, 200);
    const afterUnlink = await client.call('GET', '/api/messengers/status');
    assert.equal(afterUnlink.data.telegram.linked, false);

    // Отписка командой /stop из самого мессенджера.
    const relink = await client.call('POST', '/api/messengers/link', { channel: 'telegram' });
    assert.equal(
      handleIncomingMessage(
        db,
        parseTelegramUpdate({
          message: { chat: { id: 555000111 }, from: { username: 'worker_tg' }, text: `/start ${relink.data.code}` },
        })!
      ).startsWith('Готово'),
      true
    );
    assert.match(
      handleIncomingMessage(
        db,
        parseTelegramUpdate({
          message: { chat: { id: 555000111 }, from: { username: 'worker_tg' }, text: '/stop' },
        })!
      ),
      /отключены/
    );
    assert.equal((await client.call('GET', '/api/messengers/status')).data.telegram.linked, false);

    // Без привязки уведомления в мессенджеры не уходят.
    notifyUser(db, workerId, 'order_assigned', 'Новый заказ', 'Заказ №43', 'order', 'ord-43');
    await wait();
    assert.equal(sent.length, 2);
  } finally {
    setMessengerSenderForTests(null);
    restoreEnv();
    db.close();
  }
});

test('messengers: срок кода, чужой канал и привязка MAX через bot_started', async () => {
  const restoreEnv = withEnv({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_BOT_USERNAME: 'pozitiv_test_bot',
    MAX_BOT_TOKEN: 'max-test-token',
    MAX_BOT_USERNAME: 'pozitiv_test_bot',
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  setMessengerSenderForTests(async () => {});
  const client = makeCaller(app);

  try {
    const setup = await client.call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    client.setAuth(setup.res.headers.get('set-cookie')!.split(';')[0], setup.data.csrfToken);

    const maxLink = await client.call('POST', '/api/messengers/link', { channel: 'max' });
    assert.equal(maxLink.status, 200);
    assert.equal(maxLink.data.url, `https://max.ru/pozitiv_test_bot?start=${maxLink.data.code}`);

    // Код MAX нельзя погасить из Telegram.
    assert.match(
      handleIncomingMessage(
        db,
        parseTelegramUpdate({
          message: { chat: { id: 1 }, from: { username: 'someone' }, text: `/start ${maxLink.data.code}` },
        })!
      ),
      /не найден/
    );

    const started = parseMaxUpdate({
      update_type: 'bot_started',
      chat_id: 7001,
      user: { user_id: 7001, username: 'max_user' },
      payload: maxLink.data.code,
    });
    assert.ok(started);
    assert.equal(started!.text, maxLink.data.code);
    assert.match(handleIncomingMessage(db, started!), /Готово/);
    assert.equal((await client.call('GET', '/api/messengers/status')).data.max.linked, true);

    // Просроченный код не привязывается.
    const tgLink = await client.call('POST', '/api/messengers/link', { channel: 'telegram' });
    db.prepare('UPDATE messenger_link_tokens SET expires_at = ? WHERE token = ?').run(
      '2020-01-01T00:00:00.000Z',
      tgLink.data.code
    );
    assert.match(
      handleIncomingMessage(
        db,
        parseTelegramUpdate({
          message: { chat: { id: 2 }, from: { username: 'late' }, text: tgLink.data.code },
        })!
      ),
      /устарел/
    );
    assert.equal((await client.call('GET', '/api/messengers/status')).data.telegram.linked, false);

    // Неизвестный мессенджер отклоняется.
    assert.equal((await client.call('POST', '/api/messengers/link', { channel: 'viber' })).status, 400);
  } finally {
    setMessengerSenderForTests(null);
    restoreEnv();
    db.close();
  }
});

test('messengers: webhook проверяет секрет и привязывает аккаунт', async () => {
  const restoreEnv = withEnv({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_BOT_USERNAME: 'pozitiv_test_bot',
    MAX_BOT_TOKEN: 'max-test-token',
    MAX_BOT_USERNAME: 'pozitiv_test_bot',
    MESSENGER_WEBHOOK_SECRET: 'webhook-secret-1',
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  const sent: Array<{ channel: MessengerChannel; externalId: string; payload: MessengerPayload }> = [];
  setMessengerSenderForTests(async (channel, externalId, payload) => {
    sent.push({ channel, externalId, payload });
  });
  const client = makeCaller(app);

  try {
    const setup = await client.call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    client.setAuth(setup.res.headers.get('set-cookie')!.split(';')[0], setup.data.csrfToken);
    const link = await client.call('POST', '/api/messengers/link', { channel: 'max' });

    const badSecret = await client.call('POST', '/api/messengers/max/webhook', {
      update_type: 'bot_started',
      user: { user_id: 9001, username: 'max_worker' },
      payload: link.data.code,
    });
    assert.equal(badSecret.status, 403);
    assert.equal((await client.call('GET', '/api/messengers/status')).data.max.linked, false);

    const good = await client.call(
      'POST',
      '/api/messengers/max/webhook',
      { update_type: 'bot_started', user: { user_id: 9001, username: 'max_worker' }, payload: link.data.code },
      { 'X-Max-Bot-Api-Secret': 'webhook-secret-1' }
    );
    assert.equal(good.status, 200);
    await wait();
    assert.equal((await client.call('GET', '/api/messengers/status')).data.max.linked, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.title, /Готово/);
  } finally {
    setMessengerSenderForTests(null);
    restoreEnv();
    db.close();
  }
});

test('messengers: сообщение в чат уходит участникам комнаты, кроме автора', async () => {
  const restoreEnv = withEnv({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    TELEGRAM_BOT_USERNAME: 'pozitiv_test_bot',
    MAX_BOT_TOKEN: 'max-test-token',
    MAX_BOT_USERNAME: 'pozitiv_test_bot',
  });
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  const sent: Array<{ channel: MessengerChannel; externalId: string; payload: MessengerPayload }> = [];
  setMessengerSenderForTests(async (channel, externalId, payload) => {
    sent.push({ channel, externalId, payload });
  });
  const client = makeCaller(app);

  try {
    const setup = await client.call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    client.setAuth(setup.res.headers.get('set-cookie')!.split(';')[0], setup.data.csrfToken);

    const first = await client.call('POST', '/api/users', {
      login: 'worker1',
      fullName: 'Worker 1',
      password: 'long-password-123',
    });
    const second = await client.call('POST', '/api/users', {
      login: 'worker2',
      fullName: 'Worker 2',
      password: 'long-password-123',
    });
    const authorId = first.data.user.id as string;
    const readerId = second.data.user.id as string;

    db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?').run(
      '111',
      'author_tg',
      authorId
    );
    db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?').run(
      '222',
      'reader_tg',
      readerId
    );

    await sendMessengersToRoom(db, 'general', authorId, {
      title: 'Иван',
      body: 'Привет',
      url: '/?chat=general',
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].externalId, '222');
    assert.equal(sent[0].payload.body, 'Привет');
    assert.equal(sent[0].payload.url, '/?chat=general');
  } finally {
    setMessengerSenderForTests(null);
    restoreEnv();
    db.close();
  }
});
