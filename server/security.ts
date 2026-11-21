import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sessionSecret } from './config.ts';
import { notifyPush } from './services/push.ts';

export const ALL_PERMISSIONS = [
  'orders.create',
  'orders.edit_assigned',
  'orders.view_all',
  'clients.create',
  'clients.edit',
  'clients.view_all',
  'reports.view_others',
  'warehouse.take',
  'warehouse.receive',
  'warehouse.edit',
] as const;

export type PermissionKey = (typeof ALL_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'orders.create': 'Создавать заказы',
  'orders.edit_assigned': 'Редактировать назначенные заказы',
  'orders.view_all': 'Просматривать другие заказы',
  'clients.create': 'Добавлять клиентов',
  'clients.edit': 'Редактировать клиентов',
  'clients.view_all': 'Просматривать общую клиентскую базу',
  'reports.view_others': 'Просматривать отчёты других сотрудников',
  'warehouse.take': 'Брать материалы и инструменты',
  'warehouse.receive': 'Принимать поступления на склад',
  'warehouse.edit': 'Редактировать складские данные',
};

export interface AuthUser {
  id: string;
  login: string;
  role: 'admin' | 'employee';
  fullName: string;
  phone: string;
  position: string;
  shiftRateKopecks: number;
  isActive: boolean;
  dismissedAt: string | null;
  mustChangePassword: boolean;
  documentsAccess: boolean;
  permissions: Record<PermissionKey, boolean>;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexKey] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexKey, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function generateRandomPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export const MIN_PASSWORD_LENGTH = 10;

export function hashSessionToken(token: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(token).digest('hex');
}

export function loadUserWithPermissions(db: DatabaseSync, userId: string): AuthUser | null {
  const row = db
    .prepare(
      `SELECT id, login, role, full_name, phone, position, shift_rate_kopecks, is_active, must_change_password, dismissed_at
       FROM users WHERE id = ?`
    )
    .get(userId) as
    | {
        id: string;
        login: string;
        role: 'admin' | 'employee';
        full_name: string;
        phone: string;
        position: string;
        shift_rate_kopecks: number;
        is_active: number;
        must_change_password: number;
        dismissed_at: string | null;
      }
    | undefined;

  if (!row) return null;

  const permRows = db
    .prepare('SELECT permission_key, granted FROM user_permissions WHERE user_id = ?')
    .all(userId) as Array<{ permission_key: string; granted: number }>;

  const permissions = {} as Record<PermissionKey, boolean>;
  for (const key of ALL_PERMISSIONS) {
    permissions[key] = row.role === 'admin';
  }
  if (row.role !== 'admin') {
    for (const p of permRows) {
      if (p.permission_key in permissions) {
        permissions[p.permission_key as PermissionKey] = p.granted === 1;
      }
    }
  }

  return {
    id: row.id,
    login: row.login,
    role: row.role,
    fullName: row.full_name,
    phone: row.phone,
    position: row.position,
    shiftRateKopecks: row.shift_rate_kopecks,
    isActive: row.is_active === 1,
    dismissedAt: row.dismissed_at,
    mustChangePassword: row.must_change_password === 1,
    documentsAccess: row.role === 'admin' && permRows.find((p) => p.permission_key === 'documents.access')?.granted !== 0,
    permissions,
  };
}

export function hasPermission(user: AuthUser, perm: PermissionKey): boolean {
  return user.role === 'admin' || Boolean(user.permissions[perm]);
}

export function writeAuditLog(
  db: DatabaseSync,
  actorUserId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  details: Record<string, unknown> = {}
): void {
  db.prepare(
    `INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    actorUserId,
    entityType,
    entityId,
    action,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

export function notifyUser(
  db: DatabaseSync,
  userId: string,
  type: string,
  title: string,
  body: string,
  linkEntityType?: string,
  linkEntityId?: string
): void {
  db.prepare(
    `INSERT INTO notifications (id, user_id, type, title, body, link_entity_type, link_entity_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    crypto.randomUUID(),
    userId,
    type,
    title,
    body,
    linkEntityType || null,
    linkEntityId || null,
    new Date().toISOString()
  );

  let url = '/';
  let tag = type;
  if (linkEntityType === 'order' && linkEntityId) { url = `/?order=${encodeURIComponent(linkEntityId)}`; tag = `order:${linkEntityId}`; }
  else if (linkEntityType === 'quick_task' && linkEntityId) { url = `/?task=${encodeURIComponent(linkEntityId)}`; tag = `task:${linkEntityId}`; }
  else if (linkEntityType === 'chat_room' && linkEntityId) { url = `/?chat=${encodeURIComponent(linkEntityId)}`; tag = `chat:${linkEntityId}`; }
  else if (linkEntityType === 'salary') { url = '/?salary=1'; tag = 'salary:1'; }
  notifyPush(db, userId, { title, body, url, tag });
}

export function notifyAdmins(
  db: DatabaseSync,
  type: string,
  title: string,
  body: string,
  linkEntityType?: string,
  linkEntityId?: string,
  excludeUserId?: string
): void {
  const admins = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1")
    .all() as Array<{ id: string }>;
  for (const admin of admins) {
    if (excludeUserId && admin.id === excludeUserId) continue;
    notifyUser(db, admin.id, type, title, body, linkEntityType, linkEntityId);
  }
}

export function createSessionForUser(
  db: DatabaseSync,
  userId: string,
  userAgent: string,
  ipAddress: string
): { rawToken: string; csrfToken: string; expiresAt: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 168);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at, user_agent, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    userId,
    tokenHash,
    csrfToken,
    expiresAt,
    userAgent.slice(0, 240),
    ipAddress.slice(0, 80),
    new Date().toISOString()
  );

  return { rawToken, csrfToken, expiresAt };
}
