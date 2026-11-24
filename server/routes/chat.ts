import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import type { DatabaseSync } from 'node:sqlite';
import { requireAuth, type AuthedRequest } from '../middleware.ts';
import { withTransaction } from '../db.ts';
import { writeAuditLog } from '../security.ts';
import {
  getVapidPublicKey,
  isPushConfigured,
  savePushSubscription,
  sendPushToRoom,
} from '../services/push.ts';
import { notifyMessengersToRoom } from '../services/messengers.ts';

const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
function folder() { const p = path.resolve(process.env.UPLOAD_DIR || './data/uploads', 'chat'); fs.mkdirSync(p, { recursive: true }); return p; }
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 0);
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) throw new Error('MAX_UPLOAD_BYTES must be a non-negative integer');
const MAX_MESSAGE_FILES = 10;
const messageUpload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, folder()), filename: (_req, _file, cb) => cb(null, crypto.randomUUID()) }),
  limits: { files: MAX_MESSAGE_FILES, ...(maxUploadBytes > 0 ? { fileSize: maxUploadBytes } : {}) },
});
function collectUploadedMessageFiles(req: express.Request): Express.Multer.File[] {
  const list: Express.Multer.File[] = [];
  if (req.file) list.push(req.file);
  const filesField = req.files;
  if (Array.isArray(filesField)) {
    list.push(...filesField);
  } else if (filesField && typeof filesField === 'object') {
    if (Array.isArray(filesField.file)) list.push(...filesField.file);
    if (Array.isArray(filesField.files)) list.push(...filesField.files);
  }
  return list;
}
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
    const text = body.slice(0, 180) || 'Вложение';
    setImmediate(() => {
      void sendPushToRoom(db, roomId, authorId, {
        title: author,
        body: text,
        tag: `chat:${roomId}`,
        url: `/?chat=${encodeURIComponent(roomId)}`,
        roomId,
      }).catch(() => {});
    });
    notifyMessengersToRoom(db, roomId, authorId, {
      title: author,
      body: text,
      url: `/?chat=${encodeURIComponent(roomId)}`,
    });
  }
  router.get('/messages', (req: AuthedRequest, res) => {
    const roomId = typeof req.query.room === 'string' ? req.query.room : 'general';
    if (!roomAccess(roomId,req.authUser!.id)) { res.sendStatus(403); return; }
    const after = roomCutoff(roomId, req.authUser!.id);
    const before = Math.max(0, Number(req.query.before) || Number.MAX_SAFE_INTEGER);
    const rows = db.prepare(`SELECT m.seq, m.id, m.author_id, u.full_name AS author_name, m.body, m.file_id, f.original_name, f.mime_type, f.size_bytes, m.created_at, m.edited_at,
      m.reply_to_id, CASE WHEN parent.deleted_at IS NULL AND parent.seq > ? THEN parent.body END AS reply_body,
      CASE WHEN parent.deleted_at IS NULL AND parent.seq > ? THEN pu.full_name END AS reply_author
      FROM chat_messages m JOIN users u ON u.id=m.author_id LEFT JOIN chat_files f ON f.id=m.file_id
      LEFT JOIN chat_messages parent ON parent.id=m.reply_to_id AND parent.room_id=m.room_id LEFT JOIN users pu ON pu.id=parent.author_id
      WHERE m.room_id = ? AND m.seq > ? AND m.seq < ? AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 100`).all(after, after, roomId, after, before).reverse() as Array<Record<string, any>>;

    const attachmentMap = new Map<string, Array<{ id: string; original_name: string; mime_type: string; size_bytes: number }>>();
    if (rows.length > 0) {
      const placeholders = rows.map(() => '?').join(',');
      const msgIds = rows.map((r) => String(r.id));
      const joinedFiles = db.prepare(
        `SELECT mf.message_id, f.id, f.original_name, f.mime_type, f.size_bytes
         FROM chat_message_files mf
         JOIN chat_files f ON f.id = mf.file_id
         WHERE mf.message_id IN (${placeholders})
         ORDER BY mf.sort_order ASC, f.created_at ASC`
      ).all(...msgIds) as Array<{ message_id: string; id: string; original_name: string; mime_type: string; size_bytes: number }>;
      for (const att of joinedFiles) {
        const list = attachmentMap.get(att.message_id) || [];
        list.push({ id: att.id, original_name: att.original_name, mime_type: att.mime_type, size_bytes: att.size_bytes });
        attachmentMap.set(att.message_id, list);
      }
    }

    const messages = rows.map((m) => {
      const joined = attachmentMap.get(String(m.id)) || [];
      const attachments = joined.length > 0
        ? joined
        : m.file_id
          ? [{ id: String(m.file_id), original_name: String(m.original_name || 'Файл'), mime_type: String(m.mime_type || 'application/octet-stream'), size_bytes: Number(m.size_bytes || 0) }]
          : [];
      const primary = attachments[0];
      return {
        ...m,
        file_id: primary ? primary.id : null,
        original_name: primary ? primary.original_name : null,
        mime_type: primary ? primary.mime_type : null,
        size_bytes: primary ? primary.size_bytes : null,
        attachments,
      };
    });
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
    res.once('finish', () => {
      if (res.statusCode >= 400 || res.locals.replayed) {
        for (const f of collectUploadedMessageFiles(req)) fs.rmSync(f.path, { force: true });
      }
    });
    next();
  }, messageUpload.fields([{ name: 'file', maxCount: MAX_MESSAGE_FILES }, { name: 'files', maxCount: MAX_MESSAGE_FILES }]), (req: AuthedRequest, res) => {
    const user = req.authUser!, body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const roomId = typeof req.body.roomId === 'string' ? req.body.roomId : 'general';
    if (!roomAccess(roomId, user.id)) { res.sendStatus(403); return; }
    const uploadedFiles = collectUploadedMessageFiles(req);
    if (uploadedFiles.length > MAX_MESSAGE_FILES) {
      res.status(400).json({ error: `Можно прикрепить не более ${MAX_MESSAGE_FILES} файлов к одному сообщению.` });
      return;
    }
    const replyTo = typeof req.body.replyToId === 'string' && req.body.replyToId ? req.body.replyToId : null;
    if (replyTo && !db.prepare('SELECT 1 FROM chat_messages WHERE id=? AND room_id=? AND seq>? AND deleted_at IS NULL').get(replyTo, roomId, roomCutoff(roomId, user.id))) {
      res.status(400).json({ error: 'Сообщение для ответа недоступно.' }); return;
    }
    if (body.length > 5000 || (!body && uploadedFiles.length === 0)) {
      res.status(400).json({ error: 'Введите сообщение до 5000 символов или прикрепите файл.' });
      return;
    }
    const clientId = req.body.clientMessageId;
    if (clientId !== undefined && (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId))) {
      res.status(400).json({ error: 'Некорректный идентификатор сообщения.' }); return;
    }
    if (clientId) {
      const previous = db.prepare('SELECT author_id,room_id,body,file_id,reply_to_id FROM chat_messages WHERE id=?').get(clientId) as { author_id: string; room_id: string; body: string; file_id: string | null; reply_to_id: string | null } | undefined;
      if (previous) {
        let prevFiles = db.prepare(
          `SELECT f.stored_name, f.original_name, f.mime_type
           FROM chat_message_files mf
           JOIN chat_files f ON f.id = mf.file_id
           WHERE mf.message_id = ?
           ORDER BY mf.sort_order ASC`
        ).all(clientId) as Array<{ stored_name: string; original_name: string; mime_type: string }>;
        if (prevFiles.length === 0 && previous.file_id) {
          const single = db.prepare('SELECT stored_name, original_name, mime_type FROM chat_files WHERE id=?').get(previous.file_id) as { stored_name: string; original_name: string; mime_type: string } | undefined;
          if (single) prevFiles = [single];
        }
        let sameFiles = prevFiles.length === uploadedFiles.length;
        if (sameFiles) {
          for (let i = 0; i < prevFiles.length; i++) {
            const saved = prevFiles[i];
            const incoming = uploadedFiles[i];
            const savedPath = path.join(folder(), saved.stored_name);
            if (
              saved.original_name !== path.basename(incoming.originalname).slice(0, 200) ||
              saved.mime_type !== baseType(incoming.mimetype) ||
              !fs.existsSync(savedPath) ||
              hashFile(savedPath) !== hashFile(incoming.path)
            ) {
              sameFiles = false;
              break;
            }
          }
        }
        if (previous.author_id !== user.id || previous.room_id !== roomId || previous.body !== body || previous.reply_to_id !== replyTo || !sameFiles) {
          res.status(409).json({ error: 'Повторная отправка отличается от исходного сообщения.' }); return;
        }
        res.locals.replayed = true; res.status(200).json({ id: clientId, replayed: true }); return;
      }
    }

    const preparedFiles: Array<{ id: string; stored: string; originalName: string; mimeType: string; size: number }> = [];
    for (const f of uploadedFiles) {
      const type = baseType(f.mimetype);
      const fd = fs.openSync(f.path, 'r'); const prefix = Buffer.alloc(16);
      let read: number; try { read = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
      const head = prefix.subarray(0, read);
      const video = (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/x-m4v') ? head.subarray(4, 8).toString() === 'ftyp' : type === 'video/webm' && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      if ((!allowed.has(type) && !video) || (type.startsWith('image/') && !imageValid(type, head))) {
        res.status(400).json({ error: 'Формат файла не поддерживается.' }); return;
      }
      fs.chmodSync(f.path, 0o600);
      preparedFiles.push({
        id: crypto.randomUUID(),
        stored: f.filename,
        originalName: path.basename(f.originalname).slice(0, 200),
        mimeType: type,
        size: f.size,
      });
    }

    const now = new Date().toISOString(), id = clientId || crypto.randomUUID();
    const primaryFileId = preparedFiles[0]?.id || null;
    try {
      withTransaction(db, () => {
        for (const pf of preparedFiles) {
          db.prepare('INSERT INTO chat_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(pf.id, pf.stored, pf.originalName, pf.mimeType, pf.size, user.id, 'message', now);
        }
        db.prepare('INSERT INTO chat_messages(id,author_id,body,file_id,created_at,room_id,reply_to_id) VALUES (?,?,?,?,?,?,?)').run(id, user.id, body, primaryFileId, now, roomId, replyTo);
        const linkStmt = db.prepare('INSERT INTO chat_message_files(message_id, file_id, sort_order) VALUES (?, ?, ?)');
        preparedFiles.forEach((pf, idx) => linkStmt.run(id, pf.id, idx));
      });
    } catch (error) {
      for (const pf of preparedFiles) fs.rmSync(path.join(folder(), pf.stored), { force: true });
      throw error;
    }
    const pushFallback =
      preparedFiles.length === 1 && preparedFiles[0].mimeType.startsWith('audio/')
        ? 'Голосовое сообщение'
        : preparedFiles.length > 1
          ? `Вложения (${preparedFiles.length})`
          : 'Файл';
    broadcast(roomId, user.id, user.fullName, body || pushFallback);
    res.status(201).json({ id, fileIds: preparedFiles.map((pf) => pf.id) });
  });
  router.patch('/messages/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!, body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(String(req.params.id)) as any;
    if (!msg || !roomAccess(msg.room_id, user.id) || msg.seq <= roomCutoff(msg.room_id, user.id)) { res.status(404).json({ error: 'Сообщение не найдено.' }); return; }
    if (msg.author_id !== user.id || Date.now() - Date.parse(msg.created_at) > (user.role === 'admin' ? 86400000 : 300000)) { res.status(403).json({ error: 'Время редактирования истекло или нет прав.' }); return; }
    const hasJoinedFiles = Boolean(db.prepare('SELECT 1 FROM chat_message_files WHERE message_id = ? LIMIT 1').get(msg.id));
    if (body.length > 5000 || (!body && !msg.file_id && !hasJoinedFiles)) { res.status(400).json({ error: 'Введите текст сообщения.' }); return; }
    db.prepare('UPDATE chat_messages SET body=?, edited_at=? WHERE id=?').run(body, new Date().toISOString(), msg.id); res.json({ ok: true });
  });
  router.delete('/messages/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(String(req.params.id)) as any;
    if (!msg || !roomAccess(msg.room_id, user.id) || msg.seq <= roomCutoff(msg.room_id, user.id)) { res.status(404).json({ error: 'Сообщение не найдено.' }); return; }
    if (msg.author_id !== user.id && user.role !== 'admin') { res.status(403).json({ error: 'Нет прав на удаление.' }); return; }
    db.prepare('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), msg.id); res.json({ ok: true });
  });
  router.get('/files/:id', (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const file = db.prepare(
      `SELECT f.*, m.room_id, m.seq
       FROM chat_files f
       JOIN chat_messages m ON (
         m.file_id = f.id
         OR EXISTS (SELECT 1 FROM chat_message_files mf WHERE mf.message_id = m.id AND mf.file_id = f.id)
       )
       WHERE f.id = ? AND m.deleted_at IS NULL
       LIMIT 1`
    ).get(String(req.params.id)) as any;
    if (!file || !roomAccess(file.room_id, user.id) || file.seq <= roomCutoff(file.room_id, user.id)) { res.sendStatus(404); return; }
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
  router.get('/push-key', (_req, res) => res.json({ publicKey: getVapidPublicKey() }));
  router.post('/push-subscription', (req: AuthedRequest, res) => {
    if (!isPushConfigured()) { res.status(503).json({ error: 'Push-уведомления ещё не настроены на сервере.' }); return; }
    try {
      savePushSubscription(db, req.authUser!.id, req.sessionId || null, req.body);
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: 'Некорректная подписка.' });
    }
  });
  return router;
}
