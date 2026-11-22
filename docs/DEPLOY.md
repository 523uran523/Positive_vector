# Автоматическое развёртывание и чистка

Обновлено: 22.11.2026.

## Кнопка «Обновить из GitHub»

В админских настройках (вкладка «Настройки», блок для админа) есть кнопка **«Обновить из GitHub»**.
Она вызывает `POST /api/deploy/from-git`.

Сервер выполняет последовательно:

1. `git pull origin master` в `C:\PositiveVector`
2. Устанавливает зависимости: `npm ci`
3. Собирает фронтенд: `npm run build`
4. Запускает тесты: `npm test`
5. Перезапускает службу: `schtasks /run /tn CRM-Auto-Start`
6. До запуска автоматически удаляет старые кэши и бэкапы

Статус и лог можно посмотреть в `GET /api/deploy/status`.

## Автоматическая чистка

Каждые 7 дней (и перед каждым обновлением) сервер:

- удаляет файлы старше 7 дней в `C:\PositiveVector\dist\dev-dist` и `C:\PositiveVector\logs`
- удаляет старые каталоги ежедневных бэкапов в `C:\PositiveVector\data\backups`, оставляя 14 последних
- удаляет `build-bundle.zip`, если ему более 7 дней

Для ручного запуска чистки можно выполнить на сервере:

```powershell
cd C:\PositiveVector
node -e "require('tsx/cjs'); const {cleanupNow} = require('./server/services/serverCleanup.ts'); const r = cleanupNow('C:/PositiveVector'); console.log('removed', r.removed.length, 'errors', r.errors.length);"
```

> Файлы в `data/uploads` и рабочей БД `data/positive_vector.db` **не удаляются** автоматически — это рабочие данные.
