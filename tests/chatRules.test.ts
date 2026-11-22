import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as webpush from 'web-push';

test('room migration preserves existing general messages and read state', () => {
  const db = openDatabase(':memory:');
  try {
    for (const name of ['001_init.sql', '002_sync.sql', '003_chat.sql']) db.exec(fs.readFileSync(path.join('server', 'migrations', name), 'utf8'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('u','u','x','employee','User',?,?)").run(now,now);
    db.prepare("INSERT INTO chat_messages(id,author_id,body,created_at) VALUES ('m','u','Старое сообщение',?)").run(now);
    db.prepare("INSERT INTO chat_reads(user_id,last_read_seq) VALUES ('u',1)").run();
    db.exec('BEGIN IMMEDIATE');
    db.exec(fs.readFileSync(path.join('server','migrations','004_chat_rooms.sql'),'utf8'));
    db.exec('COMMIT');
    assert.deepEqual({ ...db.prepare("SELECT room_id,body FROM chat_messages WHERE id='m'").get() }, {room_id:'general',body:'Старое сообщение'});
    assert.deepEqual({ ...db.prepare("SELECT room_id,last_read_seq FROM chat_reads WHERE user_id='u'").get() }, {room_id:'general',last_read_seq:1});
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('dismissal revokes sessions but preserves salary history and can be restored', async () => {
  const db=openDatabase(':memory:'); runMigrations(db); const app=createApp(db);
  let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown) {
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return {res,status:res.status,data:(res.headers.get('content-type')||'').includes('json') ? await res.json() : null};
  }
  try {
    const setup=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    const adminCookie=setup.res.headers.get('set-cookie')!.split(';')[0], adminCsrf=setup.data.csrfToken, adminId=setup.data.user.id;
    cookie=adminCookie; csrf=adminCsrf;
    assert.equal((await call('POST',`/api/users/${adminId}/dismiss`,{})).status,400);
    const user=await call('POST','/api/users',{login:'worker',fullName:'Worker',password:'long-password-123'});
    const id=user.data.user.id, now=new Date().toISOString();
    db.prepare("INSERT INTO salary_accruals(id,user_id,source_type,amount_kopecks,created_at) VALUES ('accrual',?,'manual',12300,?)").run(id,now);
    db.prepare("INSERT INTO workshop_shifts(id,user_id,started_at,status,rate_snapshot_kopecks,created_at) VALUES ('active-shift',?,?,'active',300000,?)").run(id,now,now);
    const login=await call('POST','/api/auth/login',{login:'worker',password:'long-password-123'});
    const workerCookie=login.res.headers.get('set-cookie')!.split(';')[0];
    cookie=adminCookie; csrf=adminCsrf;
    const fired=await call('POST',`/api/users/${id}/dismiss`,{}); assert.equal(fired.status,200); assert.equal(fired.data.user.isActive,false); assert.ok(fired.data.user.dismissedAt); assert.equal(fired.data.activeShift,true);
    assert.equal(db.prepare("SELECT status FROM workshop_shifts WHERE id='active-shift'").get()?.status,'active');
    assert.equal(db.prepare("SELECT amount_kopecks FROM salary_accruals WHERE id='accrual'").get()?.amount_kopecks,12300);
    assert.equal((await inject(app,'GET','/api/chat/rooms',undefined,{Cookie:workerCookie})).status,401);
    const dismissedLogin=await call('POST','/api/auth/login',{login:'worker',password:'long-password-123'}); assert.equal(dismissedLogin.status,200);
    const dismissedCookie=dismissedLogin.res.headers.get('set-cookie')!.split(';')[0], dismissedCsrf=dismissedLogin.data.csrfToken;
    cookie=dismissedCookie; csrf=dismissedCsrf;
    assert.equal((await call('GET','/api/auth/me')).status,200);
    const balance = await call('GET','/api/auth/dismissal-balance');
    assert.equal(balance.data.remainingKopecks,12300); assert.equal(balance.data.settlementPending,true);
    for (const route of ['/api/chat/rooms','/api/orders','/api/salaries/my','/api/users','/api/export/database.xlsx']) assert.equal((await call('GET',route)).status,403,route);
    assert.equal((await call('POST','/api/chat/messages',{body:'forbidden'})).status,403);
    assert.equal((await call('PATCH','/api/auth/profile',{fullName:'Forbidden'})).status,403);
    db.prepare("INSERT INTO salary_payouts(id,user_id,amount_kopecks,paid_at,created_at) VALUES ('pay',?,12300,?,?)").run(id,now,now);
    const paidBalance = await call('GET','/api/auth/dismissal-balance');
    assert.equal(paidBalance.data.remainingKopecks,0); assert.equal(paidBalance.data.settlementPending,true);
    db.prepare("UPDATE workshop_shifts SET status='completed' WHERE id='active-shift'").run();
    assert.equal((await call('GET','/api/auth/dismissal-balance')).data.settlementPending,false);
    db.prepare("INSERT INTO orders(id,order_number,title,created_at,updated_at) VALUES ('pending-order','PENDING','Order',?,?)").run(now,now);
    db.prepare("INSERT INTO order_visits(id,order_id,title,scheduled_at,created_at) VALUES ('pending-visit','pending-order','Visit',?,?)").run(now,now);
    db.prepare("INSERT INTO visit_assignees(id,visit_id,user_id) VALUES ('pending-assignee','pending-visit',?)").run(id);
    assert.equal((await call('GET','/api/auth/dismissal-balance')).data.settlementPending,true);
    db.prepare("UPDATE order_visits SET status='cancelled' WHERE id='pending-visit'").run();
    assert.equal((await call('GET','/api/auth/dismissal-balance')).data.settlementPending,false);
    cookie=adminCookie; csrf=adminCsrf;
    assert.equal((await call('PATCH',`/api/users/${id}`,{isActive:true})).status,400);
    assert.equal((await call('POST',`/api/users/${id}/restore`,{})).status,200);
    assert.equal((await inject(app,'GET','/api/auth/dismissal-balance',undefined,{Cookie:dismissedCookie})).status,403);
    const restored=await call('POST','/api/auth/login',{login:'worker',password:'long-password-123'});
    assert.equal(restored.status,200); assert.equal(restored.data.user.mustChangePassword,true); assert.equal(restored.data.user.dismissedAt,null);
    const actions=db.prepare("SELECT action FROM audit_log WHERE entity_id=?").all(id).map((row:any)=>row.action);
    assert.ok(actions.includes('user_dismissed') && actions.includes('user_restored'));
  } finally {db.close();}
});

test('private rooms restrict access and provide full history to added members', async () => {
  const db = openDatabase(':memory:'); runMigrations(db); const app = createApp(db);
  let cookie = '', csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf });
    const contentType = res.headers.get('content-type') || '';
    return { res, status: res.status, data: contentType.includes('json') ? await res.json() : null };
  }
  try {
    const setup = await call('POST', '/api/auth/setup', { login: 'admin', password: 'long-password-123', fullName: 'Admin' });
    const adminCookie = setup.res.headers.get('set-cookie')!.split(';')[0], adminCsrf = setup.data.csrfToken;
    cookie=adminCookie; csrf=adminCsrf;
    const worker = await call('POST', '/api/users', { login:'worker', fullName:'Worker', password:'long-password-123', chatHistory:false });
    const outsider = await call('POST', '/api/users', { login:'outsider', fullName:'Outsider', password:'long-password-123', chatHistory:false });
    const secondAdmin = await call('POST', '/api/users', { login:'admin2', fullName:'Admin 2', role:'admin', password:'long-password-123' });
    assert.equal(secondAdmin.data.user.role, 'admin');
    const room = await call('POST', '/api/chat/rooms', { name:'Проект', memberIds:[worker.data.user.id] }); assert.equal(room.status,201);
    const id = room.data.id;
    const msg = await call('POST', '/api/chat/messages', {roomId:id,body:'private'}); assert.equal(msg.status,201);
    assert.equal((await call('POST','/api/chat/messages',{roomId:'general',body:'cross-room',replyToId:msg.data.id})).status,400);
    const reply = await call('POST','/api/chat/messages',{roomId:id,body:'answer',replyToId:msg.data.id});
    assert.equal(reply.status,201);
    const replyView = (await call('GET',`/api/chat/messages?room=${id}`)).data.messages.find((m:any)=>m.id===reply.data.id);
    assert.equal(replyView.reply_body,'private');
    assert.equal(replyView.reply_author,'Admin');
    assert.equal((await call('DELETE',`/api/chat/messages/${reply.data.id}`)).status,200);
    const fileId = 'private-file';
    db.prepare("INSERT INTO chat_files(id,stored_name,original_name,mime_type,size_bytes,owner_id,kind,created_at) VALUES (?,?,?,?,?,?,?,?)").run(fileId,'00000000-0000-0000-0000-000000000003','file.txt','text/plain',1,setup.data.user.id,'message',new Date().toISOString());
    db.prepare('UPDATE chat_messages SET file_id=? WHERE id=?').run(fileId,msg.data.id);
    let admin2Login = await call('POST','/api/auth/login',{login:'admin2',password:'long-password-123'});
    cookie=admin2Login.res.headers.get('set-cookie')!.split(';')[0]; csrf=admin2Login.data.csrfToken;
    assert.equal((await call('GET',`/api/chat/messages?room=${id}`)).status,403, 'admin without membership cannot read');
    assert.equal((await call('POST',`/api/chat/rooms/${id}/members`,{memberIds:[secondAdmin.data.user.id]})).status,200);
    assert.equal((await call('GET',`/api/chat/messages?room=${id}`)).status,200, 'admin may add themselves');
    cookie=adminCookie; csrf=adminCsrf;
    let login = await call('POST','/api/auth/login',{login:'outsider',password:'long-password-123'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0]; csrf=login.data.csrfToken;
    assert.equal((await call('GET', `/api/chat/messages?room=${id}`)).status,403);
    assert.equal((await inject(app,'GET',`/api/chat/files/${fileId}`,undefined,{Cookie:cookie})).status,404);
    assert.equal((await call('POST','/api/chat/messages',{roomId:id,body:'intrusion'})).status,403);
    assert.equal((await call('POST','/api/chat/rooms',{name:'forbidden'})).status,403);
    cookie=adminCookie; csrf=adminCsrf;
    assert.equal((await call('POST',`/api/chat/rooms/${id}/members`,{memberIds:[outsider.data.user.id]})).status,200);
    login=await call('POST','/api/auth/login',{login:'outsider',password:'long-password-123'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0]; csrf=login.data.csrfToken;
    assert.deepEqual((await call('GET',`/api/chat/messages?room=${id}`)).data.messages.map((m:any)=>m.body),['private']);
    assert.equal((await call('DELETE',`/api/chat/messages/${msg.data.id}`)).status,403);
    cookie=adminCookie; csrf=adminCsrf;
    assert.equal((await call('DELETE',`/api/chat/rooms/general/members/${outsider.data.user.id}`)).status,403);
    assert.equal((await call('DELETE',`/api/chat/rooms/${id}/members/${outsider.data.user.id}`)).status,200);
    login=await call('POST','/api/auth/login',{login:'outsider',password:'long-password-123'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0]; csrf=login.data.csrfToken;
    assert.equal((await call('GET',`/api/chat/messages?room=${id}`)).status,403);
    assert.equal((await inject(app,'GET',`/api/chat/files/${fileId}`,undefined,{Cookie:cookie})).status,404);
    assert.equal((await call('GET','/api/chat/messages?room=general')).status,200);
    cookie=adminCookie; csrf=adminCsrf;
    for(let i=0;i<4;i++) assert.equal((await call('POST','/api/chat/rooms',{name:`Доп ${i}`})).status,201);
    assert.equal((await call('POST','/api/chat/rooms',{name:'Лишний'})).status,409);
    assert.equal((await call('DELETE','/api/chat/rooms/general')).status,403);
    assert.equal((await call('DELETE',`/api/chat/rooms/${id}`)).status,200);
    assert.equal((await call('POST','/api/chat/rooms',{name:'Новый вместо удалённого'})).status,201);
    assert.equal(db.prepare('SELECT body FROM chat_messages WHERE id=?').get(msg.data.id)?.body,'private');
    assert.equal((await call('GET',`/api/chat/messages?room=${id}`)).status,403);
  } finally { db.close(); }
});

test('chat history boundary, edit windows and deletion permissions are enforced by server', async () => {
  const db = openDatabase(':memory:'); runMigrations(db); const app = createApp(db);
  let cookie = '', csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf });
    return { res, status: res.status, data: await res.json() };
  }
  try {
    const setup = await call('POST', '/api/auth/setup', { login: 'admin', password: 'long-password-123', fullName: 'Admin' });
    const adminCookie = setup.res.headers.get('set-cookie')!.split(';')[0], adminCsrf = setup.data.csrfToken;
    cookie = adminCookie; csrf = adminCsrf;
    const old = await call('POST', '/api/chat/messages', { body: 'old' }); assert.equal(old.status, 201);
    const retryId = crypto.randomUUID();
    const firstSend = await call('POST', '/api/chat/messages', { body: 'retry', clientMessageId: retryId }); assert.equal(firstSend.status,201);
    const retried = await call('POST', '/api/chat/messages', { body: 'retry', clientMessageId: retryId }); assert.equal(retried.status,200); assert.equal(retried.data.replayed,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE id=?').get(retryId)?.n,1);
    assert.equal((await call('POST', '/api/chat/messages', { body:'different', clientMessageId:retryId })).status,409);
    const created = await call('POST', '/api/users', { login: 'worker', fullName: 'Worker', password: 'long-password-123', chatHistory: false }); assert.equal(created.status, 201);
    const newer = await call('POST', '/api/chat/messages', { body: 'new' }); assert.equal(newer.status, 201);
    const login = await call('POST', '/api/auth/login', { login: 'worker', password: 'long-password-123' }); assert.equal(login.status, 200);
    cookie = login.res.headers.get('set-cookie')!.split(';')[0]; csrf = login.data.csrfToken;
    const visible = await call('GET', '/api/chat/messages');
    assert.deepEqual(visible.data.messages.map((m: any) => m.body), ['new']);
    assert.equal((await call('DELETE', `/api/chat/messages/${old.data.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/chat/messages/${newer.data.id}`)).status, 403);
    const own = await call('POST', '/api/chat/messages', { body: 'mine' });
    assert.equal((await call('PATCH', `/api/chat/messages/${own.data.id}`, { body: 'edited' })).status, 200);
    db.prepare('UPDATE chat_messages SET created_at=? WHERE id=?').run(new Date(Date.now() - 6 * 60000).toISOString(), own.data.id);
    assert.equal((await call('PATCH', `/api/chat/messages/${own.data.id}`, { body: 'late' })).status, 403);
    cookie = adminCookie; csrf = adminCsrf;
    assert.equal((await call('PATCH', `/api/chat/messages/${own.data.id}`, { body: 'admin edit' })).status, 403);
    assert.equal((await call('DELETE', `/api/chat/messages/${own.data.id}`)).status, 200);
    assert.equal((await call('PATCH', `/api/chat/messages/${newer.data.id}`, { body: 'admin own' })).status, 200);
    db.prepare('UPDATE chat_messages SET created_at=? WHERE id=?').run(new Date(Date.now() - 25 * 3600000).toISOString(), newer.data.id);
    assert.equal((await call('PATCH', `/api/chat/messages/${newer.data.id}`, { body: 'late' })).status, 403);
  } finally { db.close(); }
});

test('push subscription is scoped to session, preserved across expired sessions, and removed on logout', async () => {
  const db = openDatabase(':memory:'); runMigrations(db);
  const keys = webpush.generateVAPIDKeys();
  const previousPublic = process.env.WEB_PUSH_PUBLIC_KEY, previousPrivate = process.env.WEB_PUSH_PRIVATE_KEY;
  process.env.WEB_PUSH_PUBLIC_KEY = keys.publicKey; process.env.WEB_PUSH_PRIVATE_KEY = keys.privateKey;
  const app = createApp(db); let cookie = '', csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf });
    return { res, status: res.status, data: await res.json() };
  }
  try {
    const setup = await call('POST', '/api/auth/setup', { login: 'admin', password: 'long-password-123', fullName: 'Admin' });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0]; csrf = setup.data.csrfToken;
    const subscription = { endpoint: 'https://fcm.googleapis.com/test', keys: { p256dh: 'example', auth: 'example' } };
    assert.equal((await call('GET', '/api/push/key')).data.publicKey, keys.publicKey);
    assert.equal((await call('POST', '/api/chat/push-subscription', { ...subscription, endpoint: 'https://127.0.0.1/test' })).status, 400);
    assert.equal((await call('POST', '/api/chat/push-subscription', subscription)).status, 200);
    assert.equal((await call('POST', '/api/push/subscription', subscription)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n, 1);
    assert.equal((await call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n, 0);
  } finally {
    if (previousPublic === undefined) delete process.env.WEB_PUSH_PUBLIC_KEY; else process.env.WEB_PUSH_PUBLIC_KEY = previousPublic;
    if (previousPrivate === undefined) delete process.env.WEB_PUSH_PRIVATE_KEY; else process.env.WEB_PUSH_PRIVATE_KEY = previousPrivate;
    db.close();
  }
});

test('chat file access follows history and avatar replacement stays inside test storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-chat-test-'));
  const previous = process.env.UPLOAD_DIR; process.env.UPLOAD_DIR = dir;
  const db = openDatabase(':memory:'); runMigrations(db); const app = createApp(db);
  let cookie = '', csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf });
    return { res, status: res.status, data: await res.json() };
  }
  async function upload(url: string, type: string, data: Buffer, clientId?: string) {
    const boundary = 'chat-test-boundary';
    const field = clientId ? `--${boundary}\r\nContent-Disposition: form-data; name="clientMessageId"\r\n\r\n${clientId}\r\n` : '';
    const body = Buffer.concat([Buffer.from(`${field}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.bin"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await inject(app, 'POST', url, body, { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Cookie: cookie, 'X-CSRF-Token': csrf });
    return { status: res.status, data: await res.json() };
  }
  try {
    const setup = await call('POST', '/api/auth/setup', { login: 'admin', password: 'long-password-123', fullName: 'Admin' });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0]; csrf = setup.data.csrfToken;
    const retryId = crypto.randomUUID();
    const sent = await upload('/api/chat/messages', 'audio/webm', Buffer.from('test-audio'), retryId);
    assert.equal(sent.status, 201);
    assert.equal((await upload('/api/chat/messages','audio/webm',Buffer.from('test-audio'),retryId)).status,200);
    assert.equal((await upload('/api/chat/messages','audio/webm',Buffer.from('other-audio'),retryId)).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_files').get()?.n,1);
    const file = db.prepare('SELECT file_id FROM chat_messages WHERE id=?').get(sent.data.id) as { file_id: string };
    const adminDownload = await inject(app, 'GET', `/api/chat/files/${file.file_id}`, undefined, { Cookie: cookie });
    assert.equal(adminDownload.status, 200); assert.equal(await adminDownload.text(), 'test-audio');
    const video = Buffer.concat([Buffer.from([0,0,0,16]), Buffer.from('ftypisom'), Buffer.from('video-content')]);
    assert.equal((await upload('/api/chat/messages','video/mp4',Buffer.from('not a video'))).status,400);
    const videoMsg = await upload('/api/chat/messages','video/mp4',video);
    assert.equal(videoMsg.status,201);
    const videoRow = db.prepare('SELECT file_id FROM chat_messages WHERE id=?').get(videoMsg.data.id) as { file_id: string };
    const videoRes = await inject(app,'GET',`/api/chat/files/${videoRow.file_id}`,undefined,{Cookie:cookie,Range:'bytes=0-3'});
    assert.equal(videoRes.status,206);
    assert.match(videoRes.headers.get('content-type') || '', /video\/mp4/);
    assert.equal((await upload('/api/chat/avatar', 'image/png', Buffer.from('not an image'))).status, 400);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082', 'hex');
    assert.equal((await upload('/api/chat/avatar', 'image/png', png)).status, 200);
    const created = await call('POST', '/api/users', { login: 'worker', fullName: 'Worker', password: 'long-password-123', chatHistory: false }); assert.equal(created.status, 201);
    const login = await call('POST', '/api/auth/login', { login: 'worker', password: 'long-password-123' });
    cookie = login.res.headers.get('set-cookie')!.split(';')[0]; csrf = login.data.csrfToken;
    assert.equal((await inject(app, 'GET', `/api/chat/files/${file.file_id}`, undefined, { Cookie: cookie })).status, 404);
  } finally { db.close(); process.env.UPLOAD_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('chat messages support multiple attachments with replay protection, access control, and deletion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-chat-multi-test-'));
  const previous = process.env.UPLOAD_DIR; process.env.UPLOAD_DIR = dir;
  const db = openDatabase(':memory:'); runMigrations(db); const app = createApp(db);
  let cookie = '', csrf = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf });
    return { res, status: res.status, data: await res.json() };
  }
  async function uploadMany(files: Array<{ name: string; type: string; data: Buffer }>, clientId?: string, bodyText = '') {
    const boundary = 'chat-multi-boundary';
    const parts: Buffer[] = [];
    if (clientId) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientMessageId"\r\n\r\n${clientId}\r\n`));
    if (bodyText) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="body"\r\n\r\n${bodyText}\r\n`));
    for (const f of files) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
      parts.push(f.data);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await inject(app, 'POST', '/api/chat/messages', Buffer.concat(parts), {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    });
    return { status: res.status, data: await res.json() };
  }

  try {
    const setup = await call('POST', '/api/auth/setup', { login: 'admin', password: 'long-password-123', fullName: 'Admin' });
    cookie = setup.res.headers.get('set-cookie')!.split(';')[0]; csrf = setup.data.csrfToken;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082', 'hex');
    const txt = Buffer.from('Спецификация монтажа');
    const retryId = crypto.randomUUID();
    const sent = await uploadMany(
      [
        { name: 'photo.png', type: 'image/png', data: png },
        { name: 'spec.txt', type: 'text/plain', data: txt },
      ],
      retryId,
      'Два файла сразу'
    );
    assert.equal(sent.status, 201);
    assert.equal(sent.data.fileIds.length, 2);

    const replay = await uploadMany(
      [
        { name: 'photo.png', type: 'image/png', data: png },
        { name: 'spec.txt', type: 'text/plain', data: txt },
      ],
      retryId,
      'Два файла сразу'
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);

    const mismatch = await uploadMany(
      [{ name: 'photo.png', type: 'image/png', data: png }],
      retryId,
      'Два файла сразу'
    );
    assert.equal(mismatch.status, 409);

    const list = await call('GET', '/api/chat/messages');
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 1);
    const msg = list.data.messages[0];
    assert.equal(msg.attachments.length, 2);
    assert.equal(msg.attachments[0].original_name, 'photo.png');
    assert.equal(msg.attachments[1].original_name, 'spec.txt');

    for (const att of msg.attachments) {
      const dl = await inject(app, 'GET', `/api/chat/files/${att.id}`, undefined, { Cookie: cookie });
      assert.equal(dl.status, 200);
    }

    const del = await call('DELETE', `/api/chat/messages/${msg.id}`);
    assert.equal(del.status, 200);
    for (const att of msg.attachments) {
      const dl = await inject(app, 'GET', `/api/chat/files/${att.id}`, undefined, { Cookie: cookie });
      assert.equal(dl.status, 404);
    }
  } finally {
    db.close();
    process.env.UPLOAD_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

