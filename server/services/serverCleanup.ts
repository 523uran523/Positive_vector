import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface CleanupResult {
  removed: string[];
  errors: string[];
}

/**
 * Remove files in the given directories that have not been modified for
 * `olderThanDays`. Symlinks and non-files are skipped. The top-level
 * directories themselves are kept.
 */
export function cleanOldFiles(dirs: string[], olderThanDays: number, now = new Date()): CleanupResult {
  const removed: string[] = [];
  const errors: string[] = [];
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          // Remove whole directory trees older than cutoff (e.g. old log folders).
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(full, { recursive: true, force: true });
            removed.push(full);
          }
        } else {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(full);
            removed.push(full);
          }
        }
      } catch (err) {
        errors.push(`${full}: ${(err as Error).message}`);
      }
    }
  }

  return { removed, errors };
}

export function cleanDeployBundle(bundlePath: string, olderThanDays: number, now = new Date()): void {
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  try {
    const stat = fs.statSync(bundlePath);
    if (stat.mtimeMs < cutoff) fs.rmSync(bundlePath, { force: true });
  } catch {
    // File may not exist; nothing to do.
  }
}

export function cleanupCachesAndBackups(root: string, olderThanDays: number, now = new Date()): CleanupResult {
  const dirs = [
    path.join(root, 'dist', 'dev-dist'),
    path.join(root, 'logs'),
    path.join(root, 'data', 'backups'),
  ];
  const result = cleanOldFiles(dirs, olderThanDays, now);
  // Remove only the most recent 14 completed daily backups.
  const backupsDir = path.join(root, 'data', 'backups');
  try {
    const entries = fs.readdirSync(backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const names = entries.map((e) => e.name).sort().reverse();
    for (const name of names.slice(14)) {
      const full = path.join(backupsDir, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        result.removed.push(full);
      } catch (err) {
        result.errors.push(`${full}: ${(err as Error).message}`);
      }
    }
  } catch {
    // Backups dir may not exist.
  }
  // Remove build-bundle.zip older than olderThanDays.
  cleanDeployBundle(path.join(root, 'build-bundle.zip'), olderThanDays, now);
  return result;
}

export function startWeeklyCleanup(root: string, onError?: (message: string) => void): () => void {
  const intervalMs = 7 * 24 * 60 * 60 * 1000;
  const run = () => {
    try {
      const result = cleanupCachesAndBackups(root, 7);
      const summary = `cleanup removed=${result.removed.length} errors=${result.errors.length}`;
      console.info(`[cleanup] ${summary}`);
      if (result.errors.length > 0) {
        console.error('[cleanup] errors:', result.errors.join('; '));
      }
      if (result.errors.length > 0 && onError) {
        onError(result.errors.join('; '));
      }
    } catch (err) {
      console.error('[cleanup] failed:', err);
      onError?.((err as Error).message);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function cleanupNow(root: string): CleanupResult {
  const result = cleanupCachesAndBackups(root, 7);
  return result;
}
