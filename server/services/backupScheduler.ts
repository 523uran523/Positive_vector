import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, verifyBackup } from './backup.ts';

const managed = /^pv-daily-(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}$/;
/** Сколько последних дневных копий хранить. */
const retentionDays = 3;
/** Москва живёт в UTC+3 без перехода на летнее время. */
const moscowOffsetMs = 3 * 60 * 60 * 1000;
const moscow = (date: Date) => new Date(date.getTime() + moscowOffsetMs);
const day = (date: Date) => {
  const local = moscow(date);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
};
/** Миллисекунды до ближайших 04:00 по Москве. */
const msUntilNextRun = (now = new Date()) => {
  const local = moscow(now);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4, 0, 0, 0);
  const target = today > local.getTime() ? today : today + 24 * 60 * 60 * 1000;
  return target - local.getTime();
};

export async function runDailyBackup(dbPath: string, uploadDir: string, backupDir: string, now = new Date()) {
  const root = path.resolve(backupDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && managed.test(entry.name) && fs.existsSync(path.join(root, entry.name, '.pv-complete')))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (existing.some(entry => entry.name.startsWith(`pv-daily-${day(now)}-`))) return { created: false };
  const name = `pv-daily-${day(now)}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = path.join(root, name);
  await createBackup(dbPath, uploadDir, destination);
  verifyBackup(destination);
  fs.writeFileSync(path.join(destination, '.pv-complete'), 'positive-vector-backup-v1\n', { mode: 0o600, flag: 'wx' });
  // Remove only completed backups created by this scheduler, after a new verified copy exists.
  const completed = [name, ...existing.map(entry => entry.name)].sort().reverse();
  for (const oldName of completed.slice(retentionDays)) {
    if (!managed.test(oldName)) continue;
    const target = path.resolve(root, oldName);
    if (path.dirname(target) !== root || fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe backup retention target');
    fs.rmSync(target, { recursive: true, force: false });
  }
  return { created: true, name };
}

export function startBackupScheduler(dbPath: string, uploadDir: string, backupDir: string, onError?: (message: string) => void) {
  if (dbPath === ':memory:') return () => { };
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDailyBackup(dbPath, uploadDir, backupDir);
      if (result.created) console.log('[backup] создана копия', result.name);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Неизвестная ошибка резервного копирования');
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().then(schedule), msUntilNextRun());
    timer.unref();
  };
  // Копия за сегодня создаётся сразу после старта, дальше — ежедневно в 04:00 МСК.
  void tick();
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
