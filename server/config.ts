import crypto from 'node:crypto';

/**
 * Centralised runtime configuration with production safety checks.
 * Secrets are never logged.
 */
export const isProduction = process.env.NODE_ENV === 'production';

export function assertProductionConfig(): void {
  if (!isProduction) return;
  const secret = process.env.SESSION_SECRET || '';
  const weak =
    !secret ||
    secret.length < 32 ||
    secret === 'replace_with_random_64_char_secret' ||
    secret.includes('dev-secret');
  if (weak) {
    throw new Error(
      'SESSION_SECRET не задан или слишком короткий (нужно >= 32 случайных символов). ' +
        'Сгенерируйте секрет: openssl rand -hex 32 и пропишите его в .env.'
    );
  }
}

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET || '';
  if (secret) return secret;
  if (isProduction) {
    throw new Error('SESSION_SECRET обязателен в production.');
  }
  // Deterministic development-only fallback so local sessions survive restarts.
  return crypto.createHash('sha256').update('pozitiv-vektor-local-dev-only').digest('hex');
}

export function resolveHost(): string {
  return (process.env.HOST || '0.0.0.0').trim();
}

export function resolvePort(): number {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
  }
  return port;
}

export function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}
