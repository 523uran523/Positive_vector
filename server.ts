import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server/app.ts';
import { assertProductionConfig, isProduction, resolveHost, resolvePort } from './server/config.ts';
import { openDatabase, runMigrations } from './server/db.ts';
import { cleanDeletedFiles } from './server/services/fileCleanup.ts';
import { startBackupScheduler } from './server/services/backupScheduler.ts';
import { notifyAdmins } from './server/security.ts';
import { createYandexOAuth } from './server/services/yandexOAuth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  assertProductionConfig();

  const db = openDatabase();
  const applied = runMigrations(db);
  if (applied.length > 0) {
    console.log(`[DB] Применены миграции: ${applied.join(', ')}`);
  }

  const yandex=createYandexOAuth(db);
  const app = createApp(db,yandex);
  const httpServer = http.createServer(app);
  const uploadRequestTimeoutMs = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS ?? 0);
  httpServer.requestTimeout =
    Number.isFinite(uploadRequestTimeoutMs) && uploadRequestTimeoutMs >= 0 ? uploadRequestTimeoutMs : 0;
  httpServer.headersTimeout = 60_000;
  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 61_000;
  let lastBackupAlert='';
  const stopBackups=startBackupScheduler(process.env.DB_PATH || './data/pozitiv_vektor.sqlite',process.env.UPLOAD_DIR || './data/uploads',process.env.BACKUP_DIR || './data/backups',message=>{
    console.error('[backup]',message);
    const today=new Date().toISOString().slice(0,10);
    if(today!==lastBackupAlert){
      lastBackupAlert=today;
      try {notifyAdmins(db,'backup_error','Не создана резервная копия','Проверьте свободное место и доступность хранилища.');} catch { /* Logging still records the failure. */ }
    }
  },()=>yandex.cloud());
  const maintain = () => {
    try { cleanDeletedFiles(db,process.env.UPLOAD_DIR || './data/uploads'); }
    catch(error) { console.error('[maintenance]',error instanceof Error ? error.message : 'failed'); }
    db.prepare('DELETE FROM mutation_receipts WHERE created_at < ?').run(new Date(Date.now()-45*24*3600_000).toISOString());
  };
  maintain();
  const maintenanceTimer=setInterval(maintain,60_000);
  maintenanceTimer.unref();

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true' || Boolean(process.env.K_SERVICE);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: disableHmr ? false : { server: httpServer },
        hmr: !disableHmr,
        watch: disableHmr ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      throw new Error(
        'Каталог dist не найден. Соберите фронтенд командой npm run build перед production-запуском.'
      );
    }
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (
            filePath.endsWith('index.html') ||
            filePath.endsWith('sw.js') ||
            filePath.endsWith('manifest.webmanifest')
          ) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = resolvePort();
  const host = resolveHost();
  const server = httpServer.listen(port, host, () => {
    console.log(`[Позитив Вектор] Сервер запущен на http://${host}:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Позитив Вектор] Порт ${port} уже занят другим процессом.`);
    } else {
      console.error('[Позитив Вектор] Ошибка HTTP-сервера:', err.message);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(maintenanceTimer);
    stopBackups();
    console.log(`[Позитив Вектор] Получен ${signal}, останавливаем сервер...`);
    const forceTimer = setTimeout(() => {
      console.error('[Позитив Вектор] Принудительное завершение по таймауту.');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(() => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // Checkpoint is best-effort.
      }
      try {
        db.close();
      } catch {
        // Ignore double-close.
      }
      clearTimeout(forceTimer);
      console.log('[Позитив Вектор] Сервер остановлен.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error('[Позитив Вектор] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Позитив Вектор] Uncaught exception:', err);
  process.exit(1);
});

startServer().catch((err) => {
  console.error('[Позитив Вектор] Ошибка запуска:', err instanceof Error ? err.message : err);
  process.exit(1);
});
