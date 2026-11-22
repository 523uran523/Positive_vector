# Техническая документация — CRM «Позитив Вектор»

## Стек технологий

### Фронтенд
- **React 19** + **TypeScript** + **Vite** (vite v8)
- **Tailwind CSS** (стाइलização)
- **lucide-react** (иконки)
- **vite-plugin-pwa** (PWA, сервис-воркер, Workbox)
- **IndexedDB** (`pv_offline_db`) — офлайн-очередь операций
- **node:sqlite** (WAL-режим, внешние ключи, транзакции BEGIN IMMEDIATE)

### Бэкенд
- **Node.js v22.23.2** + **Express**
- **node:sqlite** (встроенная SQLite, без нативной компиляции)
- **multer** (загрузка файлов, diskStorage, MAX_UPLOAD_BYTES)
- **web-push** (VAPID-ключи, push-уведомления)
- **cookie-parser** (HttpOnly сессии `pv_session`)
- **crypto.scryptSync** (хеширование паролей)
- **CSRF-токены** (X-CSRF-Token)

### Архитектура сервера
```
server.ts              — точка входа, запуск Express, таймауты загрузок
server/app.ts          — создание Express-приложения, монтирование роутов
server/middleware.ts   — аутентификация, CSRF, сессии, безопасность cookie
server/security.ts     — RBAC, права, уведомления (notifyUser → notifyPush)
server/db.ts           — инициализация SQLite, транзакции, WAL
server/config.ts       — конфигурация, секреты
server/routes/         — API роутеры (orders, chat, finance, salaries, push, documents и др.)
server/services/       — push-сервис, backup, Yandex OAuth
server/migrations/     — SQL-миграции (001_init … 019)
server/scripts/        — resetData, migrate, create-admin, seed:demo
```

### Аутентификация и права
- 2 роли: **Администратор** и **Сотрудник**
- 10 гранулярных разрешений (orders.create, orders.edit_assigned, orders.view_all, clients.create, clients.edit, clients.view_all, reports.view_others, warehouse.take, warehouse.receive, warehouse.edit)
- Сессии: HttpOnly cookie `pv_session`, SameSite=None; Secure на HTTPS, Lax на локальном HTTP
- CSRF-токены через `X-CSRF-Token`
- Блокировка при подборе пароля (`login_attempts`)
- Аудит действий (`audit_log`)

## API эндпоинты (основные)
- `POST /api/auth/setup` — первичная настройка администратора
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/status`
- `GET /api/health` — проверка состояния сервера
- `GET/POST /api/orders`, `PATCH /api/orders/:id` — заказы
- `GET/POST /api/finance/overview`, `POST /api/finance/payments`, `POST /api/finance/expenses`
- `POST /api/finance/orders/:orderId/cost-override` — корректировка себестоимости
- `GET/POST /api/push/key`, `POST/DELETE /api/push/subscription` — push-уведомления
- `GET/POST/DELETE /api/documents`, `DELETE /api/documents/:id` — документы
- `GET /api/export/finance.xlsx` — XLSX-экспорт

## Переменные окружения (.env)
- `DB_PATH` — путь к SQLite БД (по умолчанию `./data/pozitiv_vektor.sqlite`)
- `UPLOAD_DIR` — папка для загруженных файлов (по умолчанию `./data/uploads`)
- `SESSION_SECRET` — секрет для подписи сессий (обязательно заменить в продакшене)
- `COOKIE_SECURE` — `true` для HTTPS, `false` для локального HTTP
- `SESSION_TTL_HOURS` — время жизни сессии (по умолчанию 168 = 7 дней)
- `MAX_UPLOAD_BYTES` — лимит размера загружаемого файла (0 = без лимита)
- `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` — VAPID для push
