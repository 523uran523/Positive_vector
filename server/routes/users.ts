import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import { requireAdmin, requireAuth, type AuthedRequest } from '../middleware.ts';
import {
  ALL_PERMISSIONS,
  generateRandomPassword,
  hashPassword,
  loadUserWithPermissions,
  MIN_PASSWORD_LENGTH,
  PERMISSION_LABELS,
  writeAuditLog,
  type PermissionKey,
} from '../security.ts';

export function createUsersRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  // Basic active employee directory for order assignment dropdowns
  router.get('/directory', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT id, full_name, role, position, is_active
         FROM users
         WHERE is_active = 1
         ORDER BY role ASC, full_name ASC`
      )
      .all() as Array<{
      id: string;
      full_name: string;
      role: string;
      position: string;
      is_active: number;
    }>;
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        role: r.role,
        position: r.position,
      })),
    });
  });

  // Full list with rates & permissions (Admin only)
  router.get('/', requireAdmin, (_req, res) => {
    const rows = db
      .prepare('SELECT id FROM users ORDER BY role ASC, full_name ASC')
      .all() as Array<{ id: string }>;
    const users = rows
      .map((r) => loadUserWithPermissions(db, r.id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u));
    res.json({
      users,
      permissionLabels: PERMISSION_LABELS,
    });
  });

  router.post('/', requireAdmin, (req: AuthedRequest, res) => {
    const {
      login,
      fullName,
      phone,
      position,
      role,
      shiftRateKopecks,
      password,
      permissions,
      chatHistory,
    } = req.body as {
      login?: string;
      fullName?: string;
      phone?: string;
      position?: string;
      role?: 'admin' | 'employee';
      shiftRateKopecks?: number;
      password?: string;
      permissions?: Partial<Record<PermissionKey, boolean>>;
      chatHistory?: boolean;
    };

    const cleanLogin = (login || '').trim();
    const cleanName = (fullName || '').trim();
    if (cleanLogin.length < 3 || !cleanName) {
      res.status(400).json({ error: 'Укажите ФИО и логин (от 3 символов).' });
      return;
    }

    const exists = db
      .prepare('SELECT id FROM users WHERE login = ? COLLATE NOCASE')
      .get(cleanLogin);
    if (exists) {
      res.status(409).json({ error: 'Пользователь с таким логином уже существует.' });
      return;
    }

    if (password !== undefined && password.trim().length > 0 && password.trim().length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов.`,
      });
      return;
    }

    const tempPassword =
      password && password.trim().length >= MIN_PASSWORD_LENGTH
        ? password.trim()
        : generateRandomPassword(12);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const targetRole = role === 'admin' ? 'admin' : 'employee';
    const rate = Math.max(0, Math.round(Number(shiftRateKopecks ?? 300000)));

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO users (id, login, password_hash, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
      ).run(
        userId,
        cleanLogin,
        hashPassword(tempPassword),
        targetRole,
        cleanName,
        (phone || '').trim(),
        (position || (targetRole === 'admin' ? 'Администратор' : 'Монтажник')).trim(),
        rate,
        now,
        now
      );

      if (chatHistory === false) {
        const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_messages').get() as { seq: number };
        db.prepare('UPDATE users SET chat_history_after = ? WHERE id = ?').run(last.seq, userId);
      }

      const permStmt = db.prepare(
        'INSERT INTO user_permissions (user_id, permission_key, granted) VALUES (?, ?, ?)'
      );
      for (const perm of ALL_PERMISSIONS) {
        const granted = targetRole === 'admin' ? 1 : permissions?.[perm] ? 1 : 0;
        permStmt.run(userId, perm, granted);
      }

      writeAuditLog(db, req.authUser!.id, 'user', userId, 'user_created', {
        login: cleanLogin,
        role: targetRole,
        shiftRateKopecks: rate,
      });
    });

    res.status(201).json({
      user: loadUserWithPermissions(db, userId),
      temporaryPassword: tempPassword,
    });
  });

  router.post('/:id/dismiss', requireAdmin, (req: AuthedRequest, res) => {
    const targetId = String(req.params.id), existing = loadUserWithPermissions(db, targetId);
    if (!existing) { res.status(404).json({error:'Сотрудник не найден.'}); return; }
    if (existing.dismissedAt) { res.json({user:existing}); return; }
    if (existing.role === 'admin' && existing.isActive) {
      const other = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1 AND id!=?").get(targetId) as {n:number};
      if (!other.n) { res.status(400).json({error:'Нельзя уволить единственного активного администратора.'}); return; }
    }
    withTransaction(db, () => {
      const now = new Date().toISOString();
      db.prepare('UPDATE users SET is_active=0,dismissed_at=?,updated_at=? WHERE id=?').run(now,now,targetId);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
      writeAuditLog(db,req.authUser!.id,'user',targetId,'user_dismissed',{});
    });
    const activeShift = Boolean(db.prepare("SELECT 1 FROM workshop_shifts WHERE user_id=? AND status='active'").get(targetId));
    res.json({user:loadUserWithPermissions(db,targetId),activeShift});
  });
  router.post('/:id/restore', requireAdmin, (req: AuthedRequest, res) => {
    const targetId = String(req.params.id), existing = loadUserWithPermissions(db,targetId);
    if (!existing) { res.status(404).json({error:'Сотрудник не найден.'}); return; }
    if (!existing.dismissedAt) { res.status(400).json({error:'Сотрудник не находится в разделе уволенных.'}); return; }
    withTransaction(db, () => {
      db.prepare('UPDATE users SET is_active=1,dismissed_at=NULL,must_change_password=1,updated_at=? WHERE id=?').run(new Date().toISOString(),targetId);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
      writeAuditLog(db,req.authUser!.id,'user',targetId,'user_restored',{});
    });
    res.json({user:loadUserWithPermissions(db,targetId)});
  });

  router.patch('/:id', requireAdmin, (req: AuthedRequest, res) => {
    const targetId = String(req.params.id);
    const existing = loadUserWithPermissions(db, targetId);
    if (!existing) {
      res.status(404).json({ error: 'Сотрудник не найден.' });
      return;
    }
    if (existing.dismissedAt && req.body.isActive === true) {
      res.status(400).json({error:'Сначала восстановите уволенного сотрудника.'}); return;
    }

    const {
      login,
      fullName,
      phone,
      position,
      role,
      shiftRateKopecks,
      isActive,
      permissions,
    } = req.body as {
      login?: string;
      fullName?: string;
      phone?: string;
      position?: string;
      role?: 'admin' | 'employee';
      shiftRateKopecks?: number;
      isActive?: boolean;
      permissions?: Partial<Record<PermissionKey, boolean>>;
      documentsAccess?: boolean;
    };

    const nextLogin = login !== undefined ? login.trim() : existing.login;
    if (nextLogin.length < 3) {
      res.status(400).json({ error: 'Логин должен быть не короче 3 символов.' });
      return;
    }
    const dup = db
      .prepare('SELECT id FROM users WHERE login = ? COLLATE NOCASE AND id != ?')
      .get(nextLogin, targetId);
    if (dup) {
      res.status(409).json({ error: 'Логин уже используется.' });
      return;
    }

    // Prevent locking out the last active admin
    if (
      existing.role === 'admin' &&
      (isActive === false || role === 'employee')
    ) {
      const otherAdmins = db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
        .get(targetId) as { cnt: number };
      if (otherAdmins.cnt === 0) {
        res.status(400).json({ error: 'Нельзя заблокировать или понизить единственного активного администратора.' });
        return;
      }
    }

    const nextRole = role === 'admin' || role === 'employee' ? role : existing.role;
    const documentsAccess = req.body.documentsAccess;
    if (documentsAccess !== undefined && typeof documentsAccess !== 'boolean') {
      res.status(400).json({ error: 'Некорректное значение доступа к бухгалтерии.' }); return;
    }
    const nextActive = isActive !== undefined ? (isActive ? 1 : 0) : existing.isActive ? 1 : 0;
    const nextRate =
      shiftRateKopecks !== undefined
        ? Math.max(0, Math.round(Number(shiftRateKopecks)))
        : existing.shiftRateKopecks;

    withTransaction(db, () => {
      if (typeof documentsAccess === 'boolean' && nextRole === 'admin') {
        db.prepare(`INSERT INTO user_permissions (user_id, permission_key, granted) VALUES (?, 'documents.access', ?)
          ON CONFLICT(user_id, permission_key) DO UPDATE SET granted = excluded.granted`).run(targetId, documentsAccess ? 1 : 0);
      }
      db.prepare(
        `UPDATE users
         SET login = ?, full_name = ?, phone = ?, position = ?, role = ?, shift_rate_kopecks = ?, is_active = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        nextLogin,
        fullName !== undefined ? fullName.trim() || existing.fullName : existing.fullName,
        phone !== undefined ? phone.trim() : existing.phone,
        position !== undefined ? position.trim() : existing.position,
        nextRole,
        nextRate,
        nextActive,
        new Date().toISOString(),
        targetId
      );

      if (permissions && nextRole !== 'admin') {
        const upsertPerm = db.prepare(
          `INSERT INTO user_permissions (user_id, permission_key, granted)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, permission_key) DO UPDATE SET granted = excluded.granted`
        );
        for (const perm of ALL_PERMISSIONS) {
          if (perm in permissions) {
            upsertPerm.run(targetId, perm, permissions[perm] ? 1 : 0);
          }
        }
      }

      if (nextActive === 0) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      }

      writeAuditLog(db, req.authUser!.id, 'user', targetId, 'user_updated', {
        role: nextRole,
        isActive: nextActive === 1,
        shiftRateKopecks: nextRate,
      });
    });

    res.json({ user: loadUserWithPermissions(db, targetId) });
  });

  // Generate / reset temporary password
  router.post('/:id/reset-password', requireAdmin, (req: AuthedRequest, res) => {
    const targetId = String(req.params.id);
    const existing = loadUserWithPermissions(db, targetId);
    if (!existing) {
      res.status(404).json({ error: 'Сотрудник не найден.' });
      return;
    }

    const { customPassword } = req.body as { customPassword?: string };
    if (
      customPassword !== undefined &&
      customPassword.trim().length > 0 &&
      customPassword.trim().length < MIN_PASSWORD_LENGTH
    ) {
      res.status(400).json({
        error: `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов.`,
      });
      return;
    }
    const tempPassword =
      customPassword && customPassword.trim().length >= MIN_PASSWORD_LENGTH
        ? customPassword.trim()
        : generateRandomPassword(12);

    withTransaction(db, () => {
      db.prepare(
        `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?`
      ).run(hashPassword(tempPassword), new Date().toISOString(), targetId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      writeAuditLog(db, req.authUser!.id, 'user', targetId, 'password_reset', {});
    });

    res.json({
      temporaryPassword: tempPassword,
      user: loadUserWithPermissions(db, targetId),
    });
  });

  return router;
}
