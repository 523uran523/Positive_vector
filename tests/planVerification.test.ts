import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import * as webpush from 'web-push';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { notifyUser } from '../server/security.ts';
import { sendPushToUser, setPushSenderForTests } from '../server/services/push.ts';
import { verifyBackup } from '../server/services/backup.ts';
import { resetOperationalData } from '../server/scripts/resetData.ts';
import { inject } from './httpHarness.ts';
import { uploadWithRetry, UploadError } from '../src/lib/upload.ts';
import { setCsrfToken } from '../src/lib/apiTransport.ts';

test('uploadWithRetry tracks progress, retries transient errors up to 3 attempts, and stops on 4xx', async () => {
  type Listener = (event?: any) => void;
  const attemptsLog: Array<{ headers: Record<string, string>; timeout: number; withCredentials: boolean }> = [];
  let mode: 'retry-then-ok' | 'bad-request' | 'unauthorized' = 'retry-then-ok';
  let callCount = 0;
  let unauthorizedEvents = 0;

  const prevXhr = (globalThis as any).XMLHttpRequest;
  const prevWindow = (globalThis as any).window;
  const prevCustomEvent = (globalThis as any).CustomEvent;

  class FakeCustomEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }

  class FakeXMLHttpRequest {
    timeout = -1;
    withCredentials = false;
    status = 0;
    responseText = '';
    headers: Record<string, string> = {};
    respHeaders: Record<string, string> = { 'content-type': 'application/json' };
    upload: { onprogress: Listener | null } = { onprogress: null };
    onload: Listener | null = null;
    onerror: Listener | null = null;
    onabort: Listener | null = null;
    ontimeout: Listener | null = null;

    open(_method: string, _url: string) {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    getResponseHeader(k: string) {
      return this.respHeaders[k.toLowerCase()] || null;
    }
    send(_body: unknown) {
      callCount++;
      attemptsLog.push({
        headers: { ...this.headers },
        timeout: this.timeout,
        withCredentials: this.withCredentials,
      });
      queueMicrotask(() => {
        if (mode === 'retry-then-ok') {
          if (callCount === 1) {
            this.onerror?.();
            return;
          }
          if (callCount === 2) {
            this.status = 502;
            this.responseText = JSON.stringify({ error: 'Upstream unavailable' });
            this.onload?.();
            return;
          }
          this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
          this.status = 201;
          this.responseText = JSON.stringify({ id: 'att-1' });
          this.onload?.();
          return;
        }
        if (mode === 'bad-request') {
          this.status = 400;
          this.responseText = JSON.stringify({ error: 'Недопустимый формат' });
          this.onload?.();
          return;
        }
        this.status = 401;
        this.responseText = JSON.stringify({ error: 'Требуется вход' });
        this.onload?.();
      });
    }
  }

  (globalThis as any).XMLHttpRequest = FakeXMLHttpRequest;
  (globalThis as any).CustomEvent = FakeCustomEvent;
  (globalThis as any).window = {
    dispatchEvent(ev: { type: string }) {
      if (ev.type === 'pv:unauthorized') unauthorizedEvents++;
    },
  };
  setCsrfToken('csrf-test-token');

  try {
    const progressEvents: number[] = [];
    const form = new FormData();
    const res = await uploadWithRetry<{ id: string }>({
      url: '/api/orders/1/attachments',
      formData: form,
      attempts: 3,
      retryDelayMs: 1,
      onProgress: (p) => progressEvents.push(p),
    });
    assert.deepEqual(res, { id: 'att-1' });
    assert.equal(callCount, 3);
    assert.equal(attemptsLog[0].timeout, 0);
    assert.equal(attemptsLog[0].withCredentials, true);
    assert.equal(attemptsLog[0].headers['X-CSRF-Token'], 'csrf-test-token');
    assert.ok(progressEvents.includes(50) && progressEvents.includes(100));

    mode = 'bad-request';
    callCount = 0;
    await assert.rejects(
      () =>
        uploadWithRetry({
          url: '/api/orders/1/attachments',
          formData: form,
          attempts: 3,
          retryDelayMs: 1,
        }),
      (err: unknown) =>
        err instanceof UploadError &&
        err.status === 400 &&
        err.retryable === false &&
        err.message === 'Недопустимый формат'
    );
    assert.equal(callCount, 1);

    mode = 'unauthorized';
    callCount = 0;
    await assert.rejects(
      () =>
        uploadWithRetry({
          url: '/api/orders/1/attachments',
          formData: form,
          attempts: 3,
          retryDelayMs: 1,
        }),
      (err: unknown) => err instanceof UploadError && err.status === 401 && err.retryable === false
    );
    assert.equal(unauthorizedEvents, 1);
  } finally {
    setCsrfToken(null);
    (globalThis as any).XMLHttpRequest = prevXhr;
    (globalThis as any).window = prevWindow;
    (globalThis as any).CustomEvent = prevCustomEvent;
  }
});

test('notifyUser triggers push with deep links, survives expired sessions, and deletes 410 endpoints', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  const sent: Array<{ endpoint: string; payload: { title: string; body: string; tag?: string; url?: string } }> = [];
  let failNextWith410 = false;

  setPushSenderForTests(async (sub, payload) => {
    if (failNextWith410) {
      const err: any = new Error('Gone');
      err.statusCode = 410;
      throw err;
    }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  });

  let cookie = '';
  let csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }
    );
    return { res, status: res.status, data: await res.json() };
  }

  const keys = webpush.generateVAPIDKeys();
  const prevPub = process.env.WEB_PUSH_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_PRIVATE_KEY;
  process.env.WEB_PUSH_PUBLIC_KEY = keys.publicKey;
  process.env.WEB_PUSH_PRIVATE_KEY = keys.privateKey;

  try {
    const setup = await call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0];
    csrf = setup.data.csrfToken;
    const worker = await call('POST', '/api/users', {
      login: 'worker',
      fullName: 'Worker',
      password: 'long-password-123',
    });
    const workerId = worker.data.user.id as string;

    const wLogin = await call('POST', '/api/auth/login', {
      login: 'worker',
      password: 'long-password-123',
    });
    cookie = wLogin.res.headers.get('set-cookie')!.split(';')[0];
    csrf = wLogin.data.csrfToken;

    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/worker-1', keys: { p256dh: 'p', auth: 'a' } };
    assert.equal((await call('POST', '/api/push/subscription', sub)).status, 200);
    assert.equal((await call('POST', '/api/push/subscription', sub)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(workerId)?.n, 1);

    // Expire worker session — push must NOT be disabled by expired session
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run('2020-01-01T00:00:00.000Z', workerId);

    notifyUser(db, workerId, 'order_assigned', 'Заказ', 'Детали заказа', 'order', 'ord-42');
    notifyUser(db, workerId, 'quick_task_assigned', 'Задача', 'Сделать чек', 'quick_task', 'tsk-7');
    notifyUser(db, workerId, 'salary_paid', 'Зарплата', 'Выплата', 'salary', 'pay-9');

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 3);
    assert.equal(sent[0].payload.url, '/?order=ord-42');
    assert.equal(sent[0].payload.tag, 'order:ord-42');
    assert.equal(sent[1].payload.url, '/?task=tsk-7');
    assert.equal(sent[1].payload.tag, 'task:tsk-7');
    assert.equal(sent[2].payload.url, '/?salary=1');

    // 410 deletes broken endpoint automatically
    failNextWith410 = true;
    await sendPushToUser(db, workerId, { title: 'Gone test', body: 'Should remove', url: '/' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(workerId)?.n, 0);
  } finally {
    setPushSenderForTests(null);
    if (prevPub === undefined) delete process.env.WEB_PUSH_PUBLIC_KEY;
    else process.env.WEB_PUSH_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.WEB_PUSH_PRIVATE_KEY;
    else process.env.WEB_PUSH_PRIVATE_KEY = prevPriv;
    db.close();
  }
});

test('migrations 013-019 safely migrate a populated pre-013 database snapshot with zero FK/integrity errors', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const dir = path.resolve('server/migrations');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql') && name < '013').sort()) {
      db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, '2026-01-01T00:00:00Z');
    }

    const now = '2026-01-02T00:00:00.000Z';
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES('u1','admin','h','admin','Admin',?,?)").run(now, now);
    db.prepare("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at,created_at) VALUES('s1','u1','th','ct','2026-12-31T00:00:00Z',?)").run(now);
    db.prepare("INSERT INTO chat_push_subscriptions(endpoint,user_id,session_id,subscription_json) VALUES('https://fcm.googleapis.com/old','u1','s1','{\"endpoint\":\"https://fcm.googleapis.com/old\"}')").run();
    db.prepare("INSERT INTO accounting_documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at) VALUES('doc1','act.pdf','12345678-1234-4234-8234-123456789abc',123,'u1',?)").run(now);
    db.prepare("INSERT INTO salary_payouts(id,user_id,amount_kopecks,payment_method,paid_at,created_at) VALUES('p1','u1',5000,'cash','2026-01-02',?)").run(now);
    db.prepare("INSERT INTO client_payments(id,amount_kopecks,payment_type,payment_method,paid_at,created_at) VALUES('cp1',10000,'advance','card','2026-01-02',?)").run(now);
    db.prepare("INSERT INTO expenses(id,category,amount_kopecks,payment_method,expense_date,created_at) VALUES('ex1','Материалы',2000,'bank','2026-01-02',?)").run(now);

    runMigrations(db);

    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get()?.['1'], 1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_push_subscriptions'").get(), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()?.n, 1);

    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get()?.['1'], 1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounting_documents'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visit_work_times'").get()?.['1'], 1);

    for (const table of ['salary_payouts', 'client_payments', 'expenses']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      assert.equal(cols.includes('payment_method'), false, `${table} must not have payment_method`);
    }

    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('LIMIT_FILE_SIZE error message reflects MAX_UPLOAD_BYTES and MAX_UPLOAD_BYTES=0 disables limit', () => {
  const buildUploadScript = (overrideMaxEnvAfterSetup?: string) => `
    import { createApp } from './server/app.ts';
    import { openDatabase, runMigrations } from './server/db.ts';
    import { inject } from './tests/httpHarness.ts';
    const db = openDatabase(':memory:'); runMigrations(db);
    const app = createApp(db);
    const setup = await inject(app, 'POST', '/api/auth/setup', JSON.stringify({ login: 'admin', password: 'long-password-123', fullName: 'Admin' }), { 'Content-Type': 'application/json' });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const csrf = (await setup.json()).csrfToken;
    ${overrideMaxEnvAfterSetup || ''}
    const boundary = 'lim-b';
    const payload = Buffer.alloc(1500, 65);
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="big.pdf"\\r\\nContent-Type: application/pdf\\r\\n\\r\\n'),
      payload,
      Buffer.from('\\r\\n--' + boundary + '--\\r\\n')
    ]);
    const res = await inject(app, 'POST', '/api/documents', body, { 'Content-Type': 'multipart/form-data; boundary=' + boundary, Cookie: cookie, 'X-CSRF-Token': csrf });
    console.log(JSON.stringify({ status: res.status, body: await res.json() }));
    db.close();
  `;

  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-limit-test-'));
  try {
    const out1 = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', buildUploadScript()], {
      env: { ...process.env, MAX_UPLOAD_BYTES: '300000000', UPLOAD_DIR: uploadRoot },
      encoding: 'utf8',
    });
    const parsed1 = JSON.parse(out1.trim().split('\n').pop()!);
    assert.equal(parsed1.status, 201);

    const out2 = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', buildUploadScript("process.env.MAX_UPLOAD_BYTES = '300000000';")],
      {
        env: { ...process.env, MAX_UPLOAD_BYTES: '1024', UPLOAD_DIR: uploadRoot },
        encoding: 'utf8',
      }
    );
    const parsed2 = JSON.parse(out2.trim().split('\n').pop()!);
    assert.equal(parsed2.status, 400);
    assert.equal(parsed2.body.error, 'Размер файла превышает лимит 286 МБ.');

    const out3 = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', buildUploadScript()], {
      env: { ...process.env, MAX_UPLOAD_BYTES: '0', UPLOAD_DIR: uploadRoot },
      encoding: 'utf8',
    });
    const parsed3 = JSON.parse(out3.trim().split('\n').pop()!);
    assert.equal(parsed3.status, 201);
  } finally {
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});

test('PAYMENT_METHOD identifiers are completely removed and UI views cover activity, lightbox, and direct upload', () => {
  const srcDir = path.resolve('src');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('PAYMENT_METHOD'), false, `Found stale PAYMENT_METHOD in ${file}`);
  }

  const orderModals = fs.readFileSync(path.resolve('src/views/OrderModals.tsx'), 'utf8');
  assert.ok(orderModals.includes('uploadWithRetry'));
  assert.ok(orderModals.includes('wakeLock'));
  assert.ok(orderModals.includes('Повторить неудачные'));
  assert.ok(orderModals.includes('max-h-[85vh]'));
  assert.equal(orderModals.includes('offlineDb'), false);

  const chatView = fs.readFileSync(path.resolve('src/views/ChatView.tsx'), 'utf8');
  assert.ok(chatView.includes('accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"'));
  assert.ok(chatView.includes('max-h-[85vh]'));

  const empSalary = fs.readFileSync(path.resolve('src/views/EmployeeSalaryView.tsx'), 'utf8');
  assert.ok(empSalary.includes('Монтажи и смены по месяцам'));
  assert.ok(empSalary.includes('data.activity'));

  const employeesView = fs.readFileSync(path.resolve('src/views/EmployeesView.tsx'), 'utf8');
  assert.ok(employeesView.includes('sal.activity'));
  assert.ok(employeesView.includes('Монтажи и смены по месяцам'));
});

test('resetOperationalData backs up database, enforces --confirm-reset, clears operational rows, and keeps chosen logins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-reset-test-'));
  const dbPath = path.join(root, 'crm.sqlite');
  const uploadDir = path.join(root, 'uploads');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(path.join(uploadDir, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(uploadDir, 'chat'), { recursive: true });

  const db = openDatabase(dbPath);
  runMigrations(db);
  const now = '2026-06-01T10:00:00.000Z';
  db.prepare(
    "INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('adm','admin1','hash','admin','Admin',?,?), ('emp','emp1','hash','employee','Worker',?,?)"
  ).run(now, now, now, now);
  db.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES('company_name','\"Позитив Вектор\"',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at"
  ).run(now);
  db.prepare("INSERT INTO orders(id,order_number,title,created_at,updated_at) VALUES('o1','ORD-1','Монтаж',?,?)").run(now, now);
  db.prepare("INSERT INTO order_visits(id,order_id,title,scheduled_at,created_at) VALUES('v1','o1','Выезд',?,?)").run(now, now);
  db.prepare("INSERT INTO visit_work_times(visit_id,user_id,work_date,start_time,end_time,updated_at) VALUES('v1','emp','2026-06-01','09:00','17:00',?)").run(now);
  db.prepare("INSERT INTO chat_messages(id,room_id,author_id,body,created_at) VALUES('m1','general','emp','Привет',?)").run(now);
  db.prepare("INSERT INTO chat_rooms(id,name,created_by,created_at) VALUES('priv','Секретная','emp',?)").run(now);
  const docUuid = '12345678-1234-4234-8234-123456789def';
  const attUuid = '12345678-1234-4234-8234-123456789aaa.jpg';
  const chatUuid = '12345678-1234-4234-8234-123456789bbb';
  fs.writeFileSync(path.join(uploadDir, 'documents', docUuid), 'doc');
  fs.writeFileSync(path.join(uploadDir, attUuid), 'att');
  fs.writeFileSync(path.join(uploadDir, 'chat', chatUuid), 'chat');
  db.prepare("INSERT INTO documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at) VALUES('d1','d.pdf',?,3,'adm',?)").run(docUuid, now);
  db.prepare("INSERT INTO attachments(id,entity_type,entity_id,kind,original_name,stored_name,mime_type,size_bytes,created_at) VALUES('a1','order','o1','photo','a.jpg',?,'image/jpeg',3,?)").run(attUuid, now);
  db.prepare("INSERT INTO chat_files(id,stored_name,original_name,mime_type,size_bytes,owner_id,kind,created_at) VALUES('cf1',?,'c.bin','audio/webm',4,'emp','message',?)").run(chatUuid, now);
  db.close();

  try {
    await assert.rejects(() =>
      resetOperationalData({
        dbPath,
        uploadDir,
        backupDir,
        keepLogins: ['admin1'],
        confirmReset: false,
      })
    );

    const result = await resetOperationalData({
      dbPath,
      uploadDir,
      backupDir,
      keepLogins: ['admin1'],
      confirmReset: true,
    });

    verifyBackup(result.backupPath);
    assert.equal(result.removedUsers, 1);
    assert.equal(result.removedFiles, 3);
    assert.deepEqual(
      result.keptUsers.map((u) => u.login),
      ['admin1']
    );
    assert.equal(fs.existsSync(path.join(uploadDir, attUuid)), false);
    assert.equal(fs.existsSync(path.join(uploadDir, 'documents', docUuid)), false);
    assert.equal(fs.existsSync(path.join(uploadDir, 'chat', chatUuid)), false);

    const check = openDatabase(dbPath);
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get()?.n, 1);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM orders').get()?.n, 0);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM visit_work_times').get()?.n, 0);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()?.n, 0);
      assert.equal(check.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE id = 'general'").get()?.n, 1);
      assert.equal(check.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE id != 'general'").get()?.n, 0);
      assert.equal(check.prepare("SELECT value_json FROM settings WHERE key='company_name'").get()?.value_json, '"Позитив Вектор"');
      assert.equal(check.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UI redesign enforces zero browser alert/confirm/prompt, no duplicate + button labels, and full navigation coverage', () => {
  const srcDir = path.resolve('src');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      /window\.(alert|confirm|prompt)\s*\(/.test(content),
      false,
      `Disallowed browser dialog found in ${file}`
    );
    assert.equal(
      /<Plus[^>]*\/>\s*(?:<span>)?\s*\+\s/.test(content),
      false,
      `Duplicate '+' icon and '+' text label found in ${file}`
    );
  }

  const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8');
  for (const section of ['Работа', 'Чат', 'Клиенты', 'Склад', 'Финансы', 'Документы', 'Сотрудники', 'Настройки', 'Моя зарплата']) {
    assert.ok(appShell.includes(section), `AppShell missing section ${section}`);
  }
  const adminNav = appShell.slice(appShell.indexOf('const navItems'), appShell.indexOf('const activeTitle'));
  let navPos = -1;
  for (const label of ['Работа', 'Финансы', 'Склад', 'Чат', 'Документы', 'Клиенты', 'Сотрудники', 'Настройки']) {
    const next = adminNav.indexOf(`label: '${label}'`, navPos + 1);
    assert.ok(next > navPos, `AppShell admin nav order broken at ${label}`);
    navPos = next;
  }

  const workView = fs.readFileSync(path.resolve('src/views/WorkView.tsx'), 'utf8');
  for (const tab of ['Календарь', 'Заказы', 'Быстрые задачи', 'Смены в цеху', 'Отчёты']) {
    assert.ok(workView.includes(tab), `WorkView missing tab ${tab}`);
  }
  assert.ok(workView.includes('Инструменты и работа'), 'WorkView must label switcher Инструменты и работа');
  assert.ok(workView.includes('workDropdownOpen'), 'WorkView must have calendar dropdown state');
  assert.ok(workView.includes('addTaskDropdownOpen'), 'WorkView must have add task dropdown state');
  assert.ok(workView.includes('Добавить задачу'), 'WorkView must rename button to Добавить задачу');
  assert.ok(workView.includes('Быстрая') && workView.includes('Заказ'), 'Add Task dropdown must include Быстрая and Заказ');
  assert.equal(workView.includes('bottom-[calc(100%+8px)]'), false, 'WorkView dropdowns must open downward below button');
  assert.ok(workView.includes('top-[calc(100%+8px)]'), 'WorkView dropdowns must open downward');
  assert.ok(workView.includes('role="menu"'), 'WorkView dropdown must be an accessible menu');
  assert.ok(workView.includes('Незапланированные заказы и черновики'));

  const chatViewChecks = fs.readFileSync(path.resolve('src/views/ChatView.tsx'), 'utf8');
  assert.ok(chatViewChecks.includes('Чаты'), 'ChatView must use Чаты dropdown button');
  assert.ok(chatViewChecks.includes('BellOff') && chatViewChecks.includes('Bell'), 'ChatView must use compact bell toggle');

  const financeView = fs.readFileSync(path.resolve('src/views/FinanceView.tsx'), 'utf8');
  for (const tab of ['Обзор', 'Отчёты по работе', 'Движение денег', 'Экономика заказов']) {
    assert.ok(financeView.includes(tab), `FinanceView missing tab ${tab}`);
  }
  assert.ok(financeView.includes('Сводка прибыли по месяцам'), 'FinanceView must show monthly profit table');
  assert.ok(financeView.includes('ReportsView'), 'FinanceView must embed ReportsView');
  assert.equal(financeView.includes("id: 'orders'"), false, 'Order economics must live inside Overview');

  const sectionHeader = fs.readFileSync(path.resolve('src/components/SectionHeader.tsx'), 'utf8');
  assert.ok(sectionHeader.includes('flex-wrap items-center gap-2'), 'SectionHeader actions must wrap');
  assert.ok(
    sectionHeader.includes('flex-wrap items-center justify-between gap-2'),
    'SectionHeader must combine tabs and actions onto one row on wide screens'
  );
  assert.equal(sectionHeader.includes('sm:shrink-0'), false, 'SectionHeader actions must not have sm:shrink-0 causing overflow');

  assert.equal(workView.includes('title="Работа"'), false, 'WorkView must not duplicate Работа title');
  assert.equal(financeView.includes('title="Финансы"'), false, 'FinanceView must not duplicate Финансы title');
  assert.equal(fs.readFileSync(path.resolve('src/views/WarehouseView.tsx'), 'utf8').includes('title="Склад"'), false);
  assert.equal(fs.readFileSync(path.resolve('src/views/ClientsView.tsx'), 'utf8').includes('title="Клиенты"'), false);
  assert.equal(fs.readFileSync(path.resolve('src/views/DocumentsView.tsx'), 'utf8').includes('title="Документы"'), false);
  assert.equal(fs.readFileSync(path.resolve('src/views/EmployeesView.tsx'), 'utf8').includes('title="Сотрудники"'), false);
  assert.equal(fs.readFileSync(path.resolve('src/views/EmployeeSalaryView.tsx'), 'utf8').includes('title="Моя зарплата"'), false);

  const empView = fs.readFileSync(path.resolve('src/views/EmployeesView.tsx'), 'utf8');
  for (const tab of ['Сотрудники', 'Уволенные', 'Зарплаты']) {
    assert.ok(empView.includes(tab), `EmployeesView missing tab ${tab}`);
  }
  assert.ok(empView.includes('Сводка по месяцам и сотрудникам'));
  assert.ok(empView.includes('Детальная таблица начислений, удержаний и выплат'));

  const settingsView = fs.readFileSync(path.resolve('src/views/SettingsView.tsx'), 'utf8');
  for (const section of ['Мой аккаунт и пароль', 'Справочники и параметры компании', 'Резервные копии на Яндекс Диск']) {
    assert.ok(settingsView.includes(section), `SettingsView missing section ${section}`);
  }
  assert.equal(settingsView.includes('activeTab'), false, 'Settings must be a single list without tabs');
  assert.equal(settingsView.includes('onSelectTab'), false, 'Settings must be a single list without tabs');

  const clientsView = fs.readFileSync(path.resolve('src/views/ClientsView.tsx'), 'utf8');
  assert.equal(clientsView.includes('ИНН'), false, 'ClientsView should not show ИНН field');
  assert.equal(clientsView.includes('Реквизит'), false, 'ClientsView should not show Реквизиты field');

  const warehouseView = fs.readFileSync(path.resolve('src/views/WarehouseView.tsx'), 'utf8');
  assert.ok(warehouseView.includes('ChevronDown'));
  assert.ok(warehouseView.includes('Материал'));
  assert.ok(warehouseView.includes('Инструмент'));
  assert.ok(warehouseView.includes('Журнал операций'));

  const documentsView = fs.readFileSync(path.resolve('src/views/DocumentsView.tsx'), 'utf8');
  assert.ok(documentsView.includes('Загрузить файл'));
  assert.equal(documentsView.includes('disabled={!file'), false, 'Documents upload button must stay active');

  const orderModals = fs.readFileSync(path.resolve('src/views/OrderModals.tsx'), 'utf8');
  assert.ok(financeView.includes('commitInlineEdit'));
  assert.ok(orderModals.includes('accept="image/*,video/*"'));
  assert.ok(orderModals.includes('Фото / видео'));
  assert.ok(workView.includes('Убрать материал'));

  const viteCfg = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
  assert.ok(viteCfg.includes("registerType: 'autoUpdate'"));

  const securityTs = fs.readFileSync(path.resolve('server/security.ts'), 'utf8');
  assert.ok(securityTs.includes("linkEntityType === 'chat_room'"));
});

test('GET /api/reports filters visitReports and shiftReports by from, to, and orderId', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);

  let cookie = '';
  let csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }
    );
    return { res, status: res.status, data: await res.json() };
  }

  try {
    const setup = await call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0];
    csrf = setup.data.csrfToken;

    const now = '2026-06-15T10:00:00.000Z';
    const userRow = db.prepare("SELECT id FROM users WHERE login = 'admin'").get() as { id: string };
    db.prepare("INSERT INTO orders(id,order_number,title,created_at,updated_at) VALUES('ord-1','ORD-001','Вывеска 1',?,?), ('ord-2','ORD-002','Вывеска 2',?,?)").run(now, now, now, now);
    db.prepare("INSERT INTO order_visits(id,order_id,title,scheduled_at,status,completed_at,created_at) VALUES('vis-1','ord-1','Монтаж 1','2026-06-10T10:00:00.000Z','completed','2026-06-10T18:00:00.000Z',?), ('vis-2','ord-2','Монтаж 2','2026-06-20T10:00:00.000Z','completed','2026-06-20T18:00:00.000Z',?)").run(now, now);
    db.prepare("INSERT INTO visit_reports(id,visit_id,order_id,user_id,work_done,created_at) VALUES('vr-1','vis-1','ord-1',?,'Смонтировано 1',?), ('vr-2','vis-2','ord-2',?,'Смонтировано 2',?)").run(userRow.id, '2026-06-10T18:00:00.000Z', userRow.id, '2026-06-20T18:00:00.000Z');
    db.prepare("INSERT INTO workshop_shifts(id,user_id,started_at,ended_at,work_done,status,rate_snapshot_kopecks,created_at) VALUES('sh-1',?,'2026-06-12T09:00:00.000Z','2026-06-12T18:00:00.000Z','Сварка рамы','completed',300000,?)").run(userRow.id, '2026-06-12T09:00:00.000Z');

    const allRes = await call('GET', '/api/reports');
    assert.equal(allRes.status, 200);
    assert.equal(allRes.data.visitReports.length, 2);
    assert.equal(allRes.data.shiftReports.length, 1);

    const dateRes = await call('GET', '/api/reports?from=2026-06-15&to=2026-06-30');
    assert.equal(dateRes.status, 200);
    assert.equal(dateRes.data.visitReports.length, 1);
    assert.equal(dateRes.data.visitReports[0].order_id, 'ord-2');
    assert.equal(dateRes.data.shiftReports.length, 0);

    const orderRes = await call('GET', '/api/reports?orderId=ord-1');
    assert.equal(orderRes.status, 200);
    assert.equal(orderRes.data.visitReports.length, 1);
    assert.equal(orderRes.data.visitReports[0].order_id, 'ord-1');
    assert.equal(orderRes.data.shiftReports.length, 0);
  } finally {
    db.close();
  }
});

test('Quick tasks and documents support optional orderId linking and inline preview download', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-docs-test-'));
  const prevUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadRoot;
  const app = createApp(db);

  let cookie = '';
  let csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }
    );
    return { res, status: res.status, data: res.status === 204 ? null : await res.json() };
  }

  try {
    const setup = await call('POST', '/api/auth/setup', {
      login: 'admin',
      password: 'long-password-123',
      fullName: 'Admin',
    });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0];
    csrf = setup.data.csrfToken;

    const now = '2026-07-01T09:00:00.000Z';
    const userRow = db.prepare("SELECT id FROM users WHERE login = 'admin'").get() as { id: string };
    db.prepare("INSERT INTO orders(id,order_number,title,created_at,updated_at) VALUES('ord-link-1','ORD-101','Стенд',?,?)").run(now, now);

    const createdTask = await call('POST', '/api/quick-tasks', {
      title: 'Купить крепёж',
      dueDate: '2026-07-02',
      assigneeIds: [userRow.id],
      orderId: 'ord-link-1',
    });
    assert.equal(createdTask.status, 201);
    assert.equal(createdTask.data.task.order_id, 'ord-link-1');
    assert.equal(createdTask.data.task.order_number, 'ORD-101');
    assert.equal(createdTask.data.task.order_title, 'Стенд');

    const badTask = await call('POST', '/api/quick-tasks', {
      title: 'Плохой заказ',
      dueDate: '2026-07-02',
      assigneeIds: [userRow.id],
      orderId: 'missing-order',
    });
    assert.equal(badTask.status, 400);

    const docsDir = path.join(uploadRoot, 'documents');
    fs.mkdirSync(docsDir, { recursive: true });
    const storedName = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(docsDir, storedName), 'hello preview', 'utf8');
    db.prepare(
      'INSERT INTO documents(id, original_name, stored_name, size_bytes, uploaded_by, created_at, category, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('doc-1', 'spec.txt', storedName, 13, userRow.id, now, 'acts', 'ord-link-1');

    const docsList = await call('GET', '/api/documents?category=acts&orderId=ord-link-1');
    assert.equal(docsList.status, 200);
    assert.equal(docsList.data.documents.length, 1);
    assert.equal(docsList.data.documents[0].order_number, 'ORD-101');

    const dlInline = await inject(app, 'GET', '/api/documents/doc-1/download?inline=1', undefined, { Cookie: cookie });
    assert.equal(dlInline.status, 200);
    assert.ok((dlInline.headers.get('content-disposition') || '').startsWith('inline;'));
    assert.ok((dlInline.headers.get('content-type') || '').includes('text/plain'));
  } finally {
    db.close();
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});

