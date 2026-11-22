import cookieParser from 'cookie-parser';
import express from 'express';
import multer from 'multer';
import type { DatabaseSync } from 'node:sqlite';
import { attachAuth } from './middleware.ts';
import { replaySafeMutations, versionResponses } from './sync.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createClientsRouter } from './routes/clients.ts';
import { createExportRouter } from './routes/export.ts';
import { createFinanceRouter } from './routes/finance.ts';
import { createNotificationsRouter } from './routes/notifications.ts';
import { createReportsRouter } from './routes/reports.ts';
import { createOrdersRouter } from './routes/orders.ts';
import { createSalariesRouter } from './routes/salaries.ts';
import { createSettingsRouter } from './routes/settings.ts';
import { createShiftsRouter } from './routes/shifts.ts';
import { createUsersRouter } from './routes/users.ts';
import { createWarehouseRouter } from './routes/warehouse.ts';
import { createChatRouter } from './routes/chat.ts';
import { createQuickTasksRouter } from './routes/quickTasks.ts';
import { createDocumentsRouter } from './routes/documents.ts';
import { createYandexOAuth } from './services/yandexOAuth.ts';
import { createYandexIntegrationRouter } from './routes/yandexIntegration.ts';
import { createPushRouter } from './routes/push.ts';
import { createDeployRouter } from './routes/deploy.ts';

export function createApp(db: DatabaseSync,oauth=createYandexOAuth(db)): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);

  // Conservative security headers. CSP is production-only so Vite HMR keeps working.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!process.env.K_SERVICE) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
          "manifest-src 'self'",
        ].join('; ')
      );
    }
    if (process.env.COOKIE_SECURE === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(attachAuth(db));
  app.use((req, res, next) => {
    const user = (req as import('./middleware.ts').AuthedRequest).authUser;
    if(user) res.setHeader('X-PV-User',user.id);
    next();
  });
  app.use(versionResponses(db));
  app.use(replaySafeMutations(db));

  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/chat', createChatRouter(db));
  app.use('/api/quick-tasks', createQuickTasksRouter(db));
  app.use('/api/documents', createDocumentsRouter(db));
  app.use('/api/integrations/yandex', createYandexIntegrationRouter(db,oauth));
  app.use('/api/users', createUsersRouter(db));
  app.use('/api/clients', createClientsRouter(db));
  app.use('/api/reports', createReportsRouter(db));
  app.use('/api/orders', createOrdersRouter(db));
  app.use('/api/shifts', createShiftsRouter(db));
  app.use('/api/salaries', createSalariesRouter(db));
  app.use('/api/warehouse', createWarehouseRouter(db));
  app.use('/api/finance', createFinanceRouter(db));
  app.use('/api/notifications', createNotificationsRouter(db));
  app.use('/api/push', createPushRouter(db));
  app.use('/api/settings', createSettingsRouter(db));
  app.use('/api/export', createExportRouter(db));
  app.use('/api/deploy', createDeployRouter(db));

  app.use('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API маршрут не найден.' });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const limitMb = Math.round(Number(process.env.MAX_UPLOAD_BYTES || 0) / 1024 / 1024);
          res.status(400).json({
            error:
              limitMb > 0
                ? `Размер файла превышает лимит ${limitMb} МБ.`
                : 'Размер файла превышает допустимый лимит.',
          });
          return;
        }
        res.status(400).json({ error: 'Некорректная загрузка файла.' });
        return;
      }
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({ error: 'Некорректный JSON в запросе.' });
        return;
      }
      const message = err instanceof Error ? err.message : '';
      if (message.includes('SQLITE_CONSTRAINT')) {
        res.status(409).json({ error: 'Данная запись уже существует или нарушает ограничения.' });
        return;
      }
      console.error('[API] Необработанная ошибка:', message || err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  );

  return app;
}
