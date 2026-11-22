import type express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  hasPermission,
  hashSessionToken,
  loadUserWithPermissions,
  type AuthUser,
  type PermissionKey,
} from './security.ts';

export const SESSION_COOKIE_NAME = 'pv_session';

export interface AuthedRequest extends express.Request {
  authUser?: AuthUser;
  dismissedUser?: AuthUser;
  csrfToken?: string;
  sessionId?: string;
}

export function attachAuth(db: DatabaseSync): express.RequestHandler {
  return (req: AuthedRequest, res, next) => {
    const rawCookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (typeof rawCookie === 'string' && rawCookie.length >= 32) {
      const tokenHash = hashSessionToken(rawCookie);
      const sessionRow = db
        .prepare('SELECT id, user_id, csrf_token, expires_at FROM sessions WHERE token_hash = ?')
        .get(tokenHash) as
        | { id: string; user_id: string; csrf_token: string; expires_at: string }
        | undefined;

      if (sessionRow) {
        if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
          db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionRow.id);
        } else {
          const user = loadUserWithPermissions(db, sessionRow.user_id);
          if (user && user.isActive) {
            req.authUser = user;
            req.csrfToken = sessionRow.csrf_token;
            req.sessionId = sessionRow.id;
          } else if (user?.dismissedAt) {
            req.dismissedUser = user;
            req.csrfToken = sessionRow.csrf_token;
            req.sessionId = sessionRow.id;
          }
        }
      }
    }

    if (
      (req.authUser || req.dismissedUser) &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase()) &&
      !req.path.startsWith('/api/auth/login') &&
      !req.path.startsWith('/api/auth/setup')
    ) {
      const headerCsrf = req.get('x-csrf-token');
      if (!headerCsrf || headerCsrf !== req.csrfToken) {
        res.status(403).json({ error: 'Недействительный CSRF-токен. Обновите страницу.' });
        return;
      }
    }

    if (req.dismissedUser && req.path.startsWith('/api/') &&
        !['/api/auth/status', '/api/auth/me', '/api/auth/logout', '/api/auth/dismissal-balance'].includes(req.path)) {
      res.status(403).json({ error: 'Доступна только информация об остатке к выплате.' });
      return;
    }

    next();
  };
}

export function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: express.Response, next: express.NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  if (req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Доступ разрешён только администратору.' });
    return;
  }
  next();
}

export function requirePerm(perm: PermissionKey): express.RequestHandler {
  return (req: AuthedRequest, res, next) => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Требуется авторизация.' });
      return;
    }
    if (!hasPermission(req.authUser, perm)) {
      res.status(403).json({ error: 'Недостаточно прав для выполнения этого действия.' });
      return;
    }
    next();
  };
}

export function getCookieOptions(req?: express.Request): express.CookieOptions {
  const isHttps = Boolean(
    req && (req.secure || req.get('x-forwarded-proto') === 'https')
  );
  const inCrossSitePreview = Boolean(
    process.env.K_SERVICE ||
      (isHttps && req?.get('sec-fetch-site') === 'cross-site')
  );
  const secure = process.env.COOKIE_SECURE === 'true' || inCrossSitePreview;

  if (inCrossSitePreview) {
    return {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      partitioned: true,
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_HOURS || 168) * 3600_000,
    } as express.CookieOptions;
  }

  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Number(process.env.SESSION_TTL_HOURS || 168) * 3600_000,
  };
}
