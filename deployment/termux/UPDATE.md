# Обновление рабочей версии на телефоне

Порядок проверен 20.11.2026 при переходе `de78dff` → `461cb14` на TECNO AD11 (Termux, `~/pv`).

Обновление выполняется **in-place**: файлы кода заменяются, рабочие данные остаются на месте. Домен, туннели и вход сотрудников не меняются.

## Что нельзя перезаписывать

При замене файлов сохраняются:

- `.env`, `.env.*` — рабочие секреты и параметры (`DB_PATH`, `UPLOAD_DIR`, `PORT`, ключи Web Push);
- `.console_cred` — пароль веб-консоли ttyd;
- `data/` — БД `pozitiv_vektor.sqlite`, вложения `data/uploads/`, резервные копии;
- `.cloudflared/` — конфигурация и credentials туннеля;
- `ttyd`, `cloudflared-arm64` — бинарники;
- `stack.sh`, `launch-stack.sh` — скрипты супервизора и запуска.

## Как устроен стек

`~/pv/stack.sh` — супервизор. Раз в 30 секунд он проверяет процессы и поднимает отсутствующие: `node server.ts`, ttyd (7681), sshd (8022, loopback), сайт `~/pv-site` (4173), cloudflared. После трёх неудачных проверок `/api/health` он перезапускает node.

Из этого следуют два правила:

1. На время замены файлов супервизор нужно остановить, иначе он поднимет node со старым кодом или перезапустит сервер посреди копирования.
2. Node нужно останавливать по `SIGTERM`. Сервер закрывает HTTP и вызывает `db.close()`, SQLite схлопывает WAL. Жёсткое `kill -9` может оставить несохранённые данные в `-wal`.

## 1. Подготовить релиз

На ПК или в отдельном каталоге телефона:

```bash
git checkout <commit>
npm ci
npm run build
npm test
```

В каталог релиза должны попасть: `server/`, `dist/`, `public/`, `src/`, `deployment/`, `tests/`, `docs/`, `server.ts`, `package.json`, `package-lock.json`, `index.html`, `tsconfig.json`, `vite.config.ts`, `metadata.json`, `node_modules/`.

Важно:

- `dist/` обязателен. Production-сервер отдаёт статику из `dist/` и без него не стартует с ошибкой «Каталог dist не найден».
- `node_modules` должен быть собран на Linux/Android (`npm ci` в Termux или на Linux). Копировать его с Windows нельзя: нативные модули несовместимы. Если на телефоне есть сеть, зависимости можно поставить прямо там (шаг 5).
- Сверьте `package.json` нового релиза с текущим: новые зависимости должны быть в `node_modules` (например, `web-push`).

Доставьте каталог на телефон рядом с рабочим, не внутрь `~/pv`. Проще всего через adb, без оболочечных кавычек:

```bash
adb push pv-release /data/local/tmp/pv-release
adb shell run-as com.termux rm -rf /data/data/com.termux/files/home/pv-release-<hash>
adb shell run-as com.termux cp -a /data/local/tmp/pv-release /data/data/com.termux/files/home/pv-release-<hash>
```

Остальные команды ниже выполняются внутри Termux (веб-консоль, SSH или `adb shell run-as com.termux` с `PATH=/data/data/com.termux/files/usr/bin:$PATH`).

## 2. Сделать резервную копию

Снимок БД можно делать на работающем сервере: скрипт использует SQLite backup API, проверяет `integrity_check` и контрольные суммы.

```bash
cd ~/pv
npm run backup -- create ~/pv-backups/before-<hash>-$(date -u +%Y%m%d-%H%M%S)
```

В каталоге появятся `database.sqlite`, `uploads/` и `manifest.json`. Команда сама печатает `Backup verified`.

Дополнительно сохраните текущий код:

```bash
ts=$(date -u +%Y%m%d-%H%M%S)
mkdir -p ~/pv-backups/code-before-<hash>-$ts
cd ~/pv
tar -czf ~/pv-backups/code-before-<hash>-$ts/code.tar.gz \
  --exclude=node_modules --exclude=data --exclude='*.log' --exclude='*.out' \
  server src public dist deployment tests server.ts package.json package-lock.json \
  index.html tsconfig.json vite.config.ts metadata.json
tar -tzf ~/pv-backups/code-before-<hash>-$ts/code.tar.gz | wc -l
```

Проверьте свободное место: `df -h $HOME`. Для копии `node_modules` нужно около 250 МБ.

## 3. Остановить супервизор и сервер

```bash
pgrep -af "bash .*pv/stack.sh"
kill <pid супервизора>
pgrep -af "bash .*pv/stack.sh" || echo "supervisor stopped"
```

Затем штатно остановите node и дождитесь выхода:

```bash
kill -TERM $(pgrep -f "node server.ts")
for i in $(seq 1 30); do pgrep -f "node server.ts" >/dev/null || break; sleep 1; done
pgrep -af "node server.ts" || echo "node stopped"
```

Проверьте, что WAL схлопнулся:

```bash
ls -l ~/pv/data/pozitiv_vektor.sqlite*
```

Файлы `-wal` и `-shm` должны исчезнуть, а размер основного файла — вырасти. Если `-wal` остался, повторите `SIGTERM` и подождите: возможно, сервер ещё закрывает соединения.

ttyd, сайт на 4173 и cloudflared останавливать не нужно: они не зависят от кода CRM и переживут замену файлов.

## 4. Заменить файлы

```bash
REL=~/pv-release-<hash>
cd ~/pv

for d in server dist public src deployment tests docs; do
  [ -d "$REL/$d" ] && rm -rf "$d" && cp -a "$REL/$d" .
done

for f in server.ts package.json package-lock.json index.html tsconfig.json \
         vite.config.ts metadata.json bun.lock README.md HANDOFF_TO_CODEX.md \
         TecnoServer_README.md; do
  [ -f "$REL/$f" ] && cp -a "$REL/$f" .
done
```

Каталоги заменяются целиком, а не поверх: иначе в `dist/assets` останутся файлы старой сборки с другими хешами.

## 5. Обновить зависимости

Если в релизе подготовлен `node_modules`:

```bash
cp -a "$REL/node_modules/." ~/pv/node_modules/
```

Если сети нет и готового каталога нет, установка на телефоне:

```bash
cd ~/pv && npm ci
```

Не используйте `--omit=dev`: скрипты `migrate`, `backup`, `create-admin` запускаются через `tsx` из devDependencies.

Проверка ключевых пакетов:

```bash
for p in tsx web-push express ws multer dotenv @google/genai xlsx; do
  [ -f ~/pv/node_modules/$p/package.json ] && echo "OK $p" || echo "MISSING $p"
done
```

## 6. Запустить и проверить

```bash
cd ~/pv
setsid nohup node server.ts >> server.log 2>&1 &
```

Дождитесь ответа health:

```bash
for i in $(seq 1 60); do
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health)" = "200" ] && break
  sleep 1
done
curl -s http://127.0.0.1:3000/api/health
curl -s -o /dev/null -w "root=%{http_code}\n" http://127.0.0.1:3000/
tail -20 server.log
```

В `server.log` должны быть строка `[DB] Применены миграции: ...` (при первом старте новой версии) и `Сервер запущен`. Миграции применяются автоматически при старте, отдельный `npm run migrate` не нужен.

Проверьте данные, не выводя секретов:

```bash
cat > /tmp/pv-db-check.cjs <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/pv/data/pozitiv_vektor.sqlite', { readOnly: true });
console.log('migrations', db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c);
console.log(db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all());
db.close();
EOF
node /tmp/pv-db-check.cjs
```

Сверьте число миграций и пользователей с ожидаемым. Проверьте локальные сервисы:

```bash
curl -s -o /dev/null -w "console=%{http_code}\n" http://127.0.0.1:7681/   # 401 — basic-auth
curl -s -o /dev/null -w "site=%{http_code}\n" http://127.0.0.1:4173/      # 200
```

Проверьте новый функционал релиза. Например, наличие маршрута Web Push: `401` значит «маршрут есть, нужен вход», `404` — «маршрута нет».

## 7. Вернуть супервизор

```bash
bash ~/pv/launch-stack.sh
pgrep -af "bash .*pv/stack.sh"
```

Публичные проверки:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://crm.gulya-studio.ru/api/health   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://crm.gulya-studio.ru/             # 200
curl -s -o /dev/null -w "%{http_code}\n" https://business.gulya-studio.ru/        # 200
curl -s -o /dev/null -w "%{http_code}\n" https://dev.gulya-studio.ru/             # 401
```

Первый запрос после переключения может истечь по таймауту, пока туннель переустанавливает соединение. Повторите 3–5 раз: устойчивые 200 — норма.

Проверьте, что публичная страница ссылается на новый бандл:

```bash
curl -s https://crm.gulya-studio.ru/ | grep -o 'assets/index-[^"]*'
```

Имя файла должно совпадать с `~/pv/dist/assets/`.

## Откат

Если новая версия не проходит проверки:

```bash
SPID=$(pgrep -f "bash .*pv/stack.sh"); [ -n "$SPID" ] && kill "$SPID"
kill -TERM $(pgrep -f "node server.ts")

# код
tar -xzf ~/pv-backups/code-before-<hash>-<ts>/code.tar.gz -C ~/pv

# БД и вложения: восстановление всегда в новый каталог
cd ~/pv
npm run backup -- restore ~/pv-backups/before-<hash>-<ts> ~/pv-restore-<ts>

# остановленный сервер: подменить данные
cp ~/pv-restore-<ts>/pozitiv_vektor.sqlite data/pozitiv_vektor.sqlite
rm -rf data/uploads && cp -a ~/pv-restore-<ts>/uploads data/uploads

bash ~/pv/launch-stack.sh
```

Сначала проверьте восстановленный каталог, и только потом подменяйте рабочую БД. Перед подменой сервер должен быть остановлен, иначе SQLite и WAL останутся от новой версии.

## Если что-то пошло не так

- **`node` не стартует.** Смотрите `tail -50 ~/pv/server.log`. Частые причины: нет `dist/index.html`, отсутствует новый пакет в `node_modules`, занят порт 3000.
- **Супервизор поднял старый процесс.** Проверьте `pgrep -af "node server.ts|pv/stack.sh"` и время старта. Остановите лишние процессы и повторите шаг 3.
- **Публичный адрес отдаёт 502/1033.** Проверьте локальный `/api/health`, затем туннель и `PV-Relay` на ПК (см. `OPERATIONS.md`).
- **`console=401`, `dev=401`.** Это норма: ttyd закрыт basic-auth.
- **После отката кода БД осталась с новыми миграциями.** Старые версии обычно переносят лишние таблицы, но надёжный путь — восстановить БД из копии, снятой до обновления (см. «Откат»).

## Коммит изменений

Документация и код лежат в одном репозитории. После правок:

```bash
git status
git diff
git add <файлы>
git commit -m "docs: ..."     # или "fix: ...", "feat: ..."
```

Правила: не коммитить `.env`, `data/`, `dist/`, `node_modules`, логи и резервные копии (они в `.gitignore`); не делать force push; перед push проверить `git log --oneline origin/master..HEAD`, чтобы не отправить чужую работу.
