import crypto from 'node:crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db.ts';
import {
  getCookieOptions,
  requireAuth,
  SESSION_COOKIE_NAME,
  type AuthedRequest,
} from '../middleware.ts';
import {
  ALL_PERMISSIONS,
  createSessionForUser,
  generateRandomPassword,
  hashPassword,
  loadUserWithPermissions,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  writeAuditLog,
} from '../security.ts';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;

function publicSessionUser(user: NonNullable<AuthedRequest['dismissedUser']>) {
  return { ...user, role: 'employee' as const, phone: '', position: '', shiftRateKopecks: 0, permissions: {} };
}

export function createAuthRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  router.get('/status', (req: AuthedRequest, res) => {
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    const needsSetup = countRow.cnt === 0;
    res.json({
      needsSetup,
      authenticated: Boolean(req.authUser || req.dismissedUser),
      user: req.authUser || (req.dismissedUser ? publicSessionUser(req.dismissedUser) : null),
      csrfToken: req.csrfToken || null,
    });
  });

  // One-time initial admin creation when database has zero users.
  // The zero-users check is repeated inside BEGIN IMMEDIATE to close the setup race.
  router.post('/setup', (req: AuthedRequest, res) => {
    const { login, password, fullName, autoGenerate } = req.body as {
      login?: string;
      password?: string;
      fullName?: string;
      autoGenerate?: boolean;
    };

    const cleanLogin = (login || 'admin').trim();
    if (cleanLogin.length < 3 || cleanLogin.length > 50) {
      res.status(400).json({ error: 'Логин должен содержать от 3 до 50 символов.' });
      return;
    }

    const rawPassword = autoGenerate ? generateRandomPassword(12) : (password || '').trim();
    if (rawPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Пароль администратора должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`,
      });
      return;
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      withTransaction(db, () => {
        const countRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
        if (countRow.cnt > 0) {
          throw new Error('SETUP_ALREADY_DONE');
        }

        db.prepare(
          `INSERT INTO users (id, login, password_hash, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', ?, '', 'Руководитель', 300000, 1, ?, ?, ?)`
        ).run(
          userId,
          cleanLogin,
          hashPassword(rawPassword),
          (fullName || 'Администратор').trim(),
          autoGenerate ? 1 : 0,
          now,
          now
        );

        const permStmt = db.prepare(
          'INSERT INTO user_permissions (user_id, permission_key, granted) VALUES (?, ?, 1)'
        );
        for (const perm of ALL_PERMISSIONS) {
          permStmt.run(userId, perm);
        }
        writeAuditLog(db, userId, 'user', userId, 'initial_admin_setup', { login: cleanLogin });
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'SETUP_ALREADY_DONE') {
        res.status(409).json({ error: 'Первоначальная настройка уже выполнена.' });
        return;
      }
      throw err;
    }

    const session = createSessionForUser(
      db,
      userId,
      req.get('user-agent') || '',
      req.ip || ''
    );
    res.cookie(SESSION_COOKIE_NAME, session.rawToken, getCookieOptions(req));

    const user = loadUserWithPermissions(db, userId);
    res.status(201).json({
      user,
      csrfToken: session.csrfToken,
      generatedCredentials: autoGenerate
        ? { login: cleanLogin, temporaryPassword: rawPassword }
        : null,
    });
  });

  router.post('/login', (req: AuthedRequest, res) => {
    const { login, password } = req.body as { login?: string; password?: string };
    const cleanLogin = (login || '').trim();
    const rawPassword = password || '';

    if (!cleanLogin || !rawPassword) {
      res.status(400).json({ error: 'Введите логин и пароль.' });
      return;
    }

    const attemptKey = `${req.ip || 'local'}:${cleanLogin.toLowerCase()}`;
    const attemptRow = db
      .prepare('SELECT attempts, locked_until FROM login_attempts WHERE key_id = ?')
      .get(attemptKey) as { attempts: number; locked_until: string | null } | undefined;

    if (attemptRow?.locked_until) {
      const lockExpiry = new Date(attemptRow.locked_until).getTime();
      if (lockExpiry > Date.now()) {
        const waitSec = Math.ceil((lockExpiry - Date.now()) / 1000);
        res.status(429).json({
          error: `Слишком много неудачных попыток входа. Повторите через ${waitSec} сек.`,
        });
        return;
      }
    }

    const userRow = db
      .prepare('SELECT id, password_hash, is_active, dismissed_at FROM users WHERE login = ? COLLATE NOCASE')
      .get(cleanLogin) as { id: string; password_hash: string; is_active: number; dismissed_at: string | null } | undefined;

    const valid = userRow ? verifyPassword(rawPassword, userRow.password_hash) : false;
    if (!userRow || !valid) {
      const nextAttempts = (attemptRow?.attempts || 0) + 1;
      const lockedUntil =
        nextAttempts >= MAX_LOGIN_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MS).toISOString()
          : null;
      db.prepare(
        `INSERT INTO login_attempts (key_id, attempts, locked_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
      ).run(attemptKey, nextAttempts, lockedUntil, new Date().toISOString());

      res.status(401).json({ error: 'Неверный логин или пароль.' });
      return;
    }

    if (userRow.is_active !== 1 && !userRow.dismissed_at) {
      res.status(403).json({ error: 'Аккаунт заблокирован администратором.' });
      return;
    }

    db.prepare('DELETE FROM login_attempts WHERE key_id = ?').run(attemptKey);

    const session = createSessionForUser(
      db,
      userRow.id,
      req.get('user-agent') || '',
      req.ip || ''
    );
    res.cookie(SESSION_COOKIE_NAME, session.rawToken, getCookieOptions(req));

    const user = loadUserWithPermissions(db, userRow.id);
    res.json({ user: user && user.dismissedAt ? publicSessionUser(user) : user, csrfToken: session.csrfToken });
  });

  router.post('/logout', (req: AuthedRequest, res) => {
    if (req.sessionId) {
      db.prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(req.sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    }
    const { maxAge: _maxAge, ...clearOpts } = getCookieOptions(req);
    res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
    res.json({ ok: true });
  });

  router.get('/me', (req: AuthedRequest, res) => {
    if (!req.authUser && !req.dismissedUser) { res.status(401).json({error:'Требуется авторизация.'}); return; }
    res.json({ user: req.authUser || publicSessionUser(req.dismissedUser!), csrfToken: req.csrfToken });
  });

  router.get('/dismissal-balance', (req: AuthedRequest, res) => {
    if (!req.dismissedUser) { res.status(403).json({error:'Раздел доступен только уволенному сотруднику.'}); return; }
    const row = db.prepare(`SELECT
      COALESCE((SELECT SUM(amount_kopecks) FROM salary_accruals WHERE user_id=?),0) AS accrued,
      COALESCE((SELECT SUM(amount_kopecks) FROM salary_payouts WHERE user_id=?),0) AS paid`).get(req.dismissedUser.id,req.dismissedUser.id) as {accrued:number;paid:number};
    const pending = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM workshop_shifts WHERE user_id=? AND status='active') OR
      EXISTS(SELECT 1 FROM visit_assignees va JOIN order_visits ov ON ov.id=va.visit_id
        WHERE va.user_id=? AND va.wage_kopecks IS NULL AND ov.status!='cancelled') AS pending`).get(req.dismissedUser.id,req.dismissedUser.id) as {pending:number};
    res.json({remainingKopecks: row.accrued-row.paid, settlementPending: Boolean(pending.pending)});
  });

  // Employee or admin self-service profile / login / password update
  router.patch('/profile', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.authUser!.id;
    const { login, fullName, phone, currentPassword, newPassword } = req.body as {
      login?: string;
      fullName?: string;
      phone?: string;
      currentPassword?: string;
      newPassword?: string;
    };

    const existing = db
      .prepare('SELECT id, login, password_hash, full_name, phone FROM users WHERE id = ?')
      .get(userId) as
      | { id: string; login: string; password_hash: string; full_name: string; phone: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Пользователь не найден.' });
      return;
    }

    const nextLogin = login !== undefined ? login.trim() : existing.login;
    if (nextLogin.length < 3) {
      res.status(400).json({ error: 'Логин должен быть не короче 3 символов.' });
      return;
    }

    const duplicate = db
      .prepare('SELECT id FROM users WHERE login = ? COLLATE NOCASE AND id != ?')
      .get(nextLogin, userId);
    if (duplicate) {
      res.status(409).json({ error: 'Этот логин уже занят другим сотрудником.' });
      return;
    }

    let nextPasswordHash = existing.password_hash;
    let nextMustChange = req.authUser!.mustChangePassword ? 1 : 0;

    if (newPassword && newPassword.trim()) {
      if (!currentPassword || !verifyPassword(currentPassword, existing.password_hash)) {
        res.status(400).json({ error: 'Текущий пароль указан неверно.' });
        return;
      }
      if (newPassword.trim().length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: `Новый пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов.`,
        });
        return;
      }
      nextPasswordHash = hashPassword(newPassword.trim());
      nextMustChange = 0;
    }

    db.prepare(
      `UPDATE users
       SET login = ?, full_name = ?, phone = ?, password_hash = ?, must_change_password = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      nextLogin,
      fullName !== undefined ? fullName.trim() || existing.full_name : existing.full_name,
      phone !== undefined ? phone.trim() : existing.phone,
      nextPasswordHash,
      nextMustChange,
      new Date().toISOString(),
      userId
    );

    writeAuditLog(db, userId, 'user', userId, 'profile_updated', {
      loginChanged: nextLogin !== existing.login,
      passwordChanged: Boolean(newPassword && newPassword.trim()),
    });

    // A password change revokes every other session of this user.
    if (newPassword && newPassword.trim() && req.sessionId) {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND (session_id IS NULL OR session_id != ?)').run(userId, req.sessionId);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, req.sessionId);
    }

    res.json({ user: loadUserWithPermissions(db, userId) });
  });

  return router;
}
