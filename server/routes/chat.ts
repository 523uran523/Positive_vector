import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import * as webpush from 'web-push';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { withTransaction } from '../db.ts';
import { writeAuditLog } from '../security.ts';

const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
function folder() { const p = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'chat'); fs.mkdirSync(p, { recursive: true }); return p; }
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 0);
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) throw new Error('MAX_UPLOAD_BYTES must be a non-negative integer');
const messageUpload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, folder()), filename: (_req, _file, cb) => cb(null, crypto.randomUUID()) }),
  limits: { files: 1, ...(maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : {}) },
});
function hashFile(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try { let count: number; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function cutoff(db: DatabaseSync, userId: string) { return Number((db.prepare('SELECT chat_history_after FROM users WHERE id = ?').get(userId) as { chat_history_after: number }).chat_history_after); }
function baseType(type: string) { return type.split(';')[0].trim().toLowerCase(); }
function imageValid(type: string, b: Buffer) {
  return (type === 'image/jpeg' && b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
    (type === 'image/png' && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (type === 'image/gif' && /^GIF8[79]a/.test(b.subarray(0, 6).toString())) ||
    (type === 'image/webp' && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP');
}

export function createChatRouter(db: DatabaseSync) {
  const router = express.Router();
  router.use(requireAuth);
  const pub = process.env.WEB_PUSH_PUBLIC_KEY || '', priv = process.env.WEB_PUSH_PRIVATE_KEY || '';
  if (pub && priv) webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT || 'mailto:admin@example.com', pub, priv);
  function roomAccess(roomId: string, userId: string): boolean {
    return roomId === 'general' || Boolean(db.prepare('SELECT 1 FROM chat_room_members m JOIN chat_rooms r ON r.id=m.room_id WHERE m.room_id=? AND m.user_id=? AND r.archived_at IS NULL').get(roomId, userId));
  }
  function roomCutoff(roomId: string, userId: string): number {
    const member = db.prepare('SELECT history_after FROM chat_room_members WHERE room_id=? AND user_id=?').get(roomId, userId) as { history_after: number } | undefined;
    return roomId === 'general' ? cutoff(db, userId) : member?.history_after || 0;
  }
  router.get('/rooms', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const rooms = db.prepare(`SELECT r.id, r.name FROM chat_rooms r WHERE r.archived_at IS NULL AND (?='admin' OR r.id='general' OR EXISTS(SELECT 1 FROM chat_room_members m WHERE m.room_id=r.id AND m.user_id=?)) ORDER BY r.id!='general',r.created_at`).all(user.role,user.id) as Array<{id:string;name:string}>;
    const items = rooms.map(room => {
      const isMember = roomAccess(room.id,user.id);
      if (!isMember) return { ...room, isMember, unreadCount: 0 };
      const row = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE room_id=? AND seq>? AND seq>COALESCE((SELECT last_read_seq FROM chat_reads WHERE user_id=? AND room_id=?),0) AND author_id!=? AND deleted_at IS NULL`).get(room.id, roomCutoff(room.id,user.id), user.id, room.id, user.id) as {n:number};
      return { ...room, isMember, unreadCount: row.n };
    });
    res.json({ rooms: items, unreadCount: items.reduce((sum, room) => sum + room.unreadCount, 0) });
  });
  router.post('/rooms', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'admin') { res.status(403).json({error:'Создавать чаты может только администратор.'}); return; }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const ids = Array.isArray(req.body.memberIds) ? [...new Set(req.body.memberIds)] : [];
    if (!name || name.length > 80 || ids.some(id => typeof id !== 'string' || !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(id))) { res.status(400).json({error:'Укажите название и действующих участников.'}); return; }
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const count = db.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE id!='general' AND archived_at IS NULL").get() as {n:number};
    if (count.n >= 5) { res.status(409).json({error:'Можно создать не более пяти дополнительных чатов.'}); return; }
    withTransaction(db, () => {
      db.prepare('INSERT INTO chat_rooms(id,name,created_by,created_at) VALUES (?,?,?,?)').run(id,name,user.id,now);
      const insert = db.prepare('INSERT INTO chat_room_members(room_id,user_id) VALUES (?,?)');
      for (const memberId of new Set([user.id, ...ids] as string[])) insert.run(id,memberId);
    });
    res.status(201).json({id,name});
  });
  router.get('/rooms/:roomId/members', (req: AuthedRequest, res) => {
    const id=String(req.params.roomId), user=req.authUser!;
    if (id==='general' || user.role!=='admin' || !db.prepare('SELECT 1 FROM chat_rooms WHERE id=? AND archived_at IS NULL').get(id)) { res.sendStatus(403); return; }
    res.json({ memberIds: (db.prepare('SELECT user_id FROM chat_room_members WHERE room_id=?').all(id) as Array<{user_id:string}>).map(r=>r.user_id) });
  });
  router.post('/rooms/:roomId/members', (req: AuthedRequest, res) => {
    const id=String(req.params.roomId), user=req.authUser!;
    if (id==='general' || user.role!=='admin' || !db.prepare('SELECT 1 FROM chat_rooms WHERE id=? AND archived_at IS NULL').get(id)) { res.sendStatus(403); return; }
    const ids = Array.isArray(req.body.memberIds) ? [...new Set(req.body.memberIds)] : [];
    if (ids.some(memberId => typeof memberId !== 'string' || !db.prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(memberId))) { res.status(400).json({error:'Выберите действующих сотрудников.'}); return; }
    withTransaction(db, () => {
      const add = db.prepare('INSERT OR IGNORE INTO chat_room_members(room_id,user_id) VALUES (?,?)');
      for (const memberId of ids as string[]) add.run(id,memberId);
    });
    res.json({ok:true});
  });
  router.delete('/rooms/:roomId/members/:userId', (req: AuthedRequest, res) => {
    const roomId=String(req.params.roomId), targetId=String(req.params.userId), user=req.authUser!;
    if (roomId==='general' || user.role!=='admin' || !db.prepare('SELECT 1 FROM chat_rooms WHERE id=? AND archived_at IS NULL').get(roomId)) { res.sendStatus(403); return; }
    withTransaction(db, () => {
      db.prepare('DELETE FROM chat_room_members WHERE room_id=? AND user_id=?').run(roomId,targetId);
      writeAuditLog(db,user.id,'chat_room',roomId,'chat_member_removed',{userId:targetId});
    });
    res.json({ok:true});
  });
  router.delete('/rooms/:roomId', (req: AuthedRequest, res) => {
    const roomId=String(req.params.roomId), user=req.authUser!;
    if (roomId==='general' || user.role!=='admin') { res.sendStatus(403); return; }
    const room=db.prepare('SELECT id FROM chat_rooms WHERE id=? AND archived_at IS NULL').get(roomId);
    if (!room) { res.sendStatus(404); return; }
    withTransaction(db, () => {
      db.prepare('UPDATE chat_rooms SET archived_at=? WHERE id=?').run(new Date().toISOString(),roomId);
      writeAuditLog(db,user.id,'chat_room',roomId,'chat_room_archived',{});
    });
    res.json({ok:true});
  });
  function broadcast(roomId: string, authorId: string, author: string, body: string) {
    if (!pub || !priv) return;
    const rows = db.prepare("SELECT p.endpoint, p.subscription_json FROM chat_push_subscriptions p JOIN sessions s ON s.id=p.session_id JOIN users u ON u.id=p.user_id WHERE p.user_id != ? AND u.is_active=1 AND s.expires_at > ? AND (?='general' OR EXISTS(SELECT 1 FROM chat_room_members m WHERE m.room_id=? AND m.user_id=p.user_id))").all(authorId, new Date().toISOString(), roomId, roomId) as Array<{ endpoint: string; subscription_json: string }>;
    for (const row of rows) void webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({ title: author, body: body.slice(0, 180) || 'Вложение', roomId })).catch((error: any) => {
      if (error?.statusCode === 404 || error?.statusCode === 410) db.prepare('DELETE FROM chat_push_subscriptions WHERE endpoint = ?').run(row.endpoint);
    });
  }
  router.get('/messages', (req: AuthedRequest, res) => {
    const roomId = typeof req.query.room === 'string' ? req.query.room : 'general';
    if (!roomAccess(roomId,req.authUser!.id)) { res.sendStatus(403); return; }
    const after = roomCutoff(roomId, req.authUser!.id);
    const before = Math.max(0, Number(req.query.before) || Number.MAX_SAFE_INTEGER);
    const messages = db.prepare(`SELECT m.seq, m.id, m.author_id, u.full_name AS author_name, m.body, m.file_id, f.original_name, f.mime_type, f.size_bytes, m.created_at, m.edited_at,
      m.reply_to_id, CASE WHEN parent.deleted_at IS NULL AND parent.seq > ? THEN parent.body END AS reply_body,
      CASE WHEN parent.deleted_at IS NULL AND parent.seq > ? THEN pu.full_name END AS reply_author
      FROM chat_messages m JOIN users u ON u.id=m.author_id LEFT JOIN chat_files f ON f.id=m.file_id
      LEFT JOIN chat_messages parent ON parent.id=m.reply_to_id AND parent.room_id=m.room_id LEFT JOIN users pu ON pu.id=parent.author_id
      WHERE m.room_id = ? AND m.seq > ? AND m.seq < ? AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 100`).all(after, after, roomId, after, before).reverse();
    const row = db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE room_id=? AND seq > ? AND seq > COALESCE((SELECT last_read_seq FROM chat_reads WHERE user_id=? AND room_id=?),0) AND author_id != ? AND deleted_at IS NULL`).get(roomId, after, req.authUser!.id, roomId, req.authUser!.id) as { count: number };
    res.json({ messages, unreadCount: row.count, hasMore: messages.length === 100 });
  });
  router.post('/read', (req: AuthedRequest, res) => {
    const roomId = typeof req.body.roomId === 'string' ? req.body.roomId : 'general';
    if (!roomAccess(roomId,req.authUser!.id)) { res.sendStatus(403); return; }
    const max = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM chat_messages WHERE room_id=?').get(roomId) as { seq: number };
    const seq = Math.max(0, Math.min(max.seq, Number(req.body.seq) || 0));
    db.prepare('INSERT INTO chat_reads(user_id,room_id,last_read_seq) VALUES (?,?,?) ON CONFLICT(user_id,room_id) DO UPDATE SET last_read_seq=MAX(last_read_seq,excluded.last_read_seq)').run(req.authUser!.id,roomId,seq);
    res.json({ ok: true });
  });
  router.post('/messages', (req: AuthedRequest, res, next) => {
    res.once('finish', () => { if (req.file && (res.statusCode >= 400 || res.locals.replayed)) fs.rmSync(req.file.path, {force:true}); });
    next();
  }, messageUpload.single('file'), (req: AuthedRequest, res) => {
    const user = req.authUser!, body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const roomId = typeof req.body.roomId === 'string' ? req.body.roomId : 'general';
    if (!roomAccess(roomId,user.id)) { res.sendStatus(403); return; }
    const replyTo = typeof req.body.replyToId === 'string' && req.body.replyToId ? req.body.replyToId : null;
    if (replyTo && !db.prepare('SELECT 1 FROM chat_messages WHERE id=? AND room_id=? AND seq>? AND deleted_at IS NULL').get(replyTo, roomId, roomCutoff(roomId,user.id))) {
      res.status(400).json({error:'Сообщение для ответа недоступно.'}); return;
    }
    if (body.length > 5000 || (!body && !req.file)) { res.status(400).json({ error: 'Введите сообщение до 5000 символов или прикрепите файл.' }); return; }
    const clientId = req.body.clientMessageId;
    if (clientId !== undefined && (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId))) {
      res.status(400).json({error:'Некорректный идентификатор сообщения.'}); return;
    }
    if (clientId) {
      const previous = db.prepare('SELECT author_id,room_id,body,file_id,reply_to_id FROM chat_messages WHERE id=?').get(clientId) as {author_id:string;room_id:string;body:string;file_id:string|null;reply_to_id:string|null} | undefined;
      if (previous) {
        let sameFile = !previous.file_id && !req.file;
        if (previous.file_id && req.file) {
          const saved = db.prepare('SELECT stored_name,original_name,mime_type FROM chat_files WHERE id=?').get(previous.file_id) as {stored_name:string;original_name:string;mime_type:string} | undefined;
          if (saved && saved.original_name === path.basename(req.file.originalname).slice(0,200) && saved.mime_type === baseType(req.file.mimetype)) {
            const savedPath = path.join(folder(),saved.stored_name);
            sameFile = fs.existsSync(savedPath) && hashFile(savedPath) === hashFile(req.file.path);
          }
        }
        if (previous.author_id !== user.id || previous.room_id !== roomId || previous.body !== body || previous.reply_to_id !== replyTo || !sameFile) {
          res.status(409).json({error:'Повторная отправка отличается от исходного сообщения.'}); return;
        }
        res.locals.replayed = true; res.status(200).json({id:clientId,replayed:true}); return;
      }
    }
    let fileId: string | null = null, stored = '';
    if (req.file) {
      const type = baseType(req.file.mimetype);
      const fd = fs.openSync(req.file.path, 'r'); const prefix = Buffer.alloc(16);
      let read: number; try { read = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
      const head = prefix.subarray(0, read);
      const video = (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/x-m4v') ? head.subarray(4, 8).toString() === 'ftyp' : type === 'video/webm' && head.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
      if ((!allowed.has(type) && !video) || (type.startsWith('image/') && !imageValid(type, head))) { res.status(400).json({ error: 'Формат файла не поддерживается.' }); return; }
      fileId = crypto.randomUUID(); stored = req.file.filename; fs.chmodSync(req.file.path, 0o600);
    }
    const now = new Date().toISOString(), id = clientId || crypto.randomUUID();
    try {
      withTransaction(db, () => {
        if (req.file && fileId) db.prepare('INSERT INTO chat_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(fileId, stored, path.basename(req.file.originalname).slice(0, 200), baseType(req.file.mimetype), req.file.size, user.id, 'message', now);
        db.prepare('INSERT INTO chat_messages(id,author_id,body,file_id,created_at,room_id,reply_to_id) VALUES (?,?,?,?,?,?,?)').run(id, user.id, body, fileId, now, roomId, replyTo);
      });
    } catch (error) { if (stored) fs.rmSync(path.join(folder(), stored), { force: true }); throw error; }
    broadcast(roomId, user.id, user.fullName, body || (req.file?.mimetype.startsWith('audio/') ? 'Голосовое сообщение' : 'Файл'));
    res.status(201).json({ id });
  });
  router.patch('/messages/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!, body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(String(req.params.id)) as any;
    if (!msg || !roomAccess(msg.room_id,user.id) || msg.seq <= roomCutoff(msg.room_id,user.id)) { res.status(404).json({ error: 'Сообщение не найдено.' }); return; }
    if (msg.author_id !== user.id || Date.now() - Date.parse(msg.created_at) > (user.role === 'admin' ? 86400000 : 300000)) { res.status(403).json({ error: 'Время редактирования истекло или нет прав.' }); return; }
    if (body.length > 5000 || (!body && !msg.file_id)) { res.status(400).json({ error: 'Введите текст сообщения.' }); return; }
    db.prepare('UPDATE chat_messages SET body=?, edited_at=? WHERE id=?').run(body, new Date().toISOString(), msg.id); res.json({ ok: true });
  });
  router.delete('/messages/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(String(req.params.id)) as any;
    if (!msg || !roomAccess(msg.room_id,user.id) || msg.seq <= roomCutoff(msg.room_id,user.id)) { res.status(404).json({ error: 'Сообщение не найдено.' }); return; }
    if (msg.author_id !== user.id && user.role !== 'admin') { res.status(403).json({ error: 'Нет прав на удаление.' }); return; }
    db.prepare('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), msg.id); res.json({ ok: true });
  });
  router.get('/files/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const file = db.prepare(`SELECT f.*,m.room_id,m.seq FROM chat_files f JOIN chat_messages m ON m.file_id=f.id WHERE f.id=? AND m.deleted_at IS NULL`).get(String(req.params.id)) as any;
    if (!file || !roomAccess(file.room_id,user.id) || file.seq <= roomCutoff(file.room_id,user.id)) { res.sendStatus(404); return; }
    const inline = /^(image|audio|video)\//.test(file.mime_type);
    res.setHeader('Content-Type', inline ? file.mime_type : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.sendFile(path.join(folder(), file.stored_name));
  });
  router.get('/avatar/:id', (req, res) => {
    const file = db.prepare('SELECT f.* FROM chat_avatars a JOIN chat_files f ON f.id=a.file_id WHERE a.user_id=?').get(String(req.params.id)) as any;
    if (!file) { res.sendStatus(404); return; } res.type(file.mime_type).sendFile(path.join(folder(), file.stored_name));
  });
  router.post('/avatar', upload.single('file'), (req: AuthedRequest, res) => {
    const file = req.file, user = req.authUser!;
    if (!file || file.size > 5 * 1024 * 1024 || !imageValid(baseType(file.mimetype), file.buffer)) { res.status(400).json({ error: 'Выберите изображение JPG, PNG, GIF или WebP до 5 МБ.' }); return; }
    const id = crypto.randomUUID(), stored = crypto.randomUUID(), now = new Date().toISOString();
    fs.writeFileSync(path.join(folder(), stored), file.buffer, { flag: 'wx', mode: 0o600 });
    try { withTransaction(db, () => {
      db.prepare('INSERT INTO chat_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, stored, 'avatar', baseType(file.mimetype), file.size, user.id, 'avatar', now);
      db.prepare('INSERT INTO chat_avatars(user_id,file_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET file_id=excluded.file_id').run(user.id, id);
    }); } catch (error) { fs.rmSync(path.join(folder(), stored), { force: true }); throw error; }
    res.json({ ok: true });
  });
  router.get('/push-key', (_req, res) => res.json({ publicKey: pub || null }));
  router.post('/push-subscription', (req: AuthedRequest, res) => {
    const sub = req.body;
    if (!pub || !priv) { res.status(503).json({ error: 'Push-уведомления ещё не настроены на сервере.' }); return; }
    try { const url = new URL(sub.endpoint); if (url.protocol !== 'https:' || url.username || url.password || url.port || !['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname) && !url.hostname.endsWith('.push.apple.com') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error(); }
    catch { res.status(400).json({ error: 'Некорректная подписка.' }); return; }
    db.prepare('INSERT INTO chat_push_subscriptions(endpoint,user_id,session_id,subscription_json) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, session_id=excluded.session_id, subscription_json=excluded.subscription_json').run(sub.endpoint, req.authUser!.id, req.sessionId!, JSON.stringify(sub)); res.json({ ok: true });
  });
  return router;
}
