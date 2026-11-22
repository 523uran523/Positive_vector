# План оставшейся работы — CRM «Позитив Вектор»

**Дата:** 21.11.2026
**Основание:** 7 исходных замечаний + дополнение пользователя (по каждому монтажнику помесячное количество монтажей/смен у него и у админа + индивидуальное время начала/конца каждого дня выезда).
**Статус:** актуальный план на текущем коде. Всё, что уже сделано, отмечено отдельно от оставшегося. Выкладка на сервер и изменение VPN отложены; проверки на устройствах выполняет пользователь. `npm run build` и автотесты (`npm test`/`npm run lint` по ходу) разрешены пользователем и подтверждаются дополнительно не требуются. Подготовка `resetData` и проверки на копии рабочей базы поручены пользователем: безопасная подготовка и проверки на копии выполняются без подтверждения, фактическое удаление рабочих данных не выполнять. Запрет касается только разглашения секретов; чтение резервной копии и подключение для проверок в пределах последующих задач разрешены. Причина «вечной перезагрузки» не объявляется устранённой до проверки на iPhone.

---

## 0. Что уже реализовано в коде (проверить, не переделывать)

### 0.1. Мультимедиа и оконченные монтажи (заметка 1 — частично)
- Сервер `server/routes/orders.ts`: `ALLOWED_MIME` уже включает видео MP4/MOV/WebM, `diskStorage` + `MAX_UPLOAD_BYTES` (0 = без лимита), `res.sendFile` в `GET /attachments/:id` (Range работает через Express).
- Клиент `src/views/OrderModals.tsx`: `input[type=file]` уже с `multiple`, `accept="image/*,video/*"`; список вложений рендерит `<video controls>` и фото/ссылки; `handleFileUpload` — последовательный цикл с `skipOfflineQueue: true` (файлы не уходят в офлайн-очередь IndexedDB — вероятный источник «вечного ребута» на iPhone устранён; окончательное устранение подтверждается только проверкой на iPhone).
- Загрузка после завершения заказа уже работает: `POST /attachments` не проверяет статус заказа (проверка только доступа), UI не скрывает блок «Файлы» при `completed`.
- **Осталось:** прогресс по файлу, лимит 3 попыток + кнопка «Повторить» (сейчас ошибка просто присоединяется к `failures` и показывается в `setError`), просмотрщик фото, таймауты Node на `server.ts` (`requestTimeout`/`headersTimeout`), Wake Lock на время загрузки.

### 0.2. Push — только чат, только `chat_push_subscriptions`
- `server/routes/chat.ts`: VAPID-ключи читаются, `broadcast()` отправляет push на новые сообщения чата, `POST /push-subscription` валидирует endpoint.
- **Осталось:** общий сервис `server/services/push.ts`, общий роутер `server/routes/push.ts`, таблица `push_subscriptions` (миграция), push из `notifyUser` для задач/заказов/зарплаты, `tag`/`url` в payload, кнопка в `SettingsView`, deep links `?task=`/`?order=` в `App.tsx`.

### 0.3. Документы и права
- Сервер `server/routes/documents.ts`: `diskStorage`, `MAX_UPLOAD_BYTES`, категории `acts`/`drawings`, `PATCH`/`DELETE`/`GET /download`; `router.use(requireAdmin)` + проверка `documentsAccess`.
- Миграции: `014_document_categories.sql` (колонка `category`), `017_documents.sql` (переименование `accounting_documents` → `documents`, право `documents.access`).
- Клиент `src/views/DocumentsView.tsx`: две вкладки, загрузка, поиск, сортировка, скачивание, перемещение, удаление. `src/components/AppShell.tsx`: пункт «Документы» по `documentsAccess`.
- Старая папка `accounting` совместима и сохраняет существующие файлы: её переименование — не требование пользователя. Если предлагать перенос в `documents` — только с безопасной миграцией и проверкой архивов, не как обязательную недоделку.

### 0.4. Ответ/Enter/превью в чате
- Миграция `015_chat_reply.sql` (`reply_to_id`). Сервер принимает `replyToId`, отдаёт `reply_body`/`reply_author`.
- Клиент `src/views/ChatView.tsx`: поле «Ответить», цитата с переходом к родительскому, Enter/Shift+Enter + `isComposing`, превью фото/видео/аудио в сообщении, локальный превью в композиторе (`previewUrl`), видео в белом списке `chat.ts` + проверка сигнатуры, `diskStorage` для сообщений, Range в `GET /files/:id` (подтверждено тестом `tests/chatRules.test.ts`: HTTP 206).
- **Осталось:** просмотрщик фото/видео во весь экран (клик по превью), `accept="image/*,video/*,audio/*"` в input композитора.

### 0.5. Размер файлов
- Лимит 12 МБ удалён из `orders.ts`, `chat.ts` (messages), `documents.ts`; везде `diskStorage` + `MAX_UPLOAD_BYTES` (0 = без лимита).
- **Осталось:** текст ошибки `LIMIT_FILE_SIZE` в `server/app.ts` не учитывает `MAX_UPLOAD_BYTES`, `server.ts` не отключает таймауты Node для больших загрузок.

### 0.6. Финансы / сводки / долги / журналы
- Миграция `018_remove_payment_methods.sql` (удаление `payment_method` из `salary_payouts`, `client_payments`, `expenses`). В роутах `finance.ts`, `salaries.ts` поля больше нет.
- `server/routes/salaries.ts`: `GET /summary` с разбивкой `visitAccruedKopecks`/`shiftAccruedKopecks`/`manualAccruedKopecks`/`totalAccruedKopecks`/`totalPaidKopecks`/`remainingKopecks`/`overpaidKopecks` + поле `activity` (помесячные `visits`/`shifts`), `GET /ledger` с фильтрами `from`/`to`, `GET /monthly` с разбивкой по сотрудникам. Тест `tests/salaryLedger.test.ts` проверяет всё это.
- Клиент `src/views/EmployeesView.tsx`: «Сводка по сотрудникам», «Сводка по месяцам», «Общий долг» в карточке, журнал операций (модалка), форма выплаты без выбора способа.
- **Осталось:** удаление неиспользуемого `PAYMENT_METHOD_LABELS` из `src/lib/api.ts` (осталось только как экспорт, нигде не импортируется).
- Время/счётчики: помесячные счётчики монтажей/смен уже отображаются в коде в `EmployeeSalaryView` и `EmployeesView` — отражено как кодовая реализация; осталось выполнить необходимую проверку (автотесты разрешены, не требуют подтверждения).

### 0.7. Доступ из РФ без VPN (заметка 5) — отложен
- Инфраструктурная работа отложена: выкладка на сервер и изменение VPN отложены; проверки на устройствах выполняет пользователь. В репозитории есть `.cloudflared/` и `deployment/`; текущая схема — Cloudflare Tunnel.

### 0.8. Миграции 014–019 и тесты — созданы; проверки на копии поручены
- `014_document_categories.sql`, `015_chat_reply.sql`, `017_documents.sql`, `018_remove_payment_methods.sql`, `019_visit_work_times.sql` (таблица `visit_work_times`).
- Тесты `documentsMigration.test.ts`, `salaryLedger.test.ts`, `chatRules.test.ts` (reply, видео, Range), `visitWorkTimes.test.ts` (индивидуальное время каждого монтажника + просмотр у админа).
- **Поручено пользователем:** подготовка проверок на копии рабочей БД; безопасные проверки выполняются без подтверждения, фактическое удаление рабочих данных не выполнять.

---

## 1. Оставшаяся работа — P0

### 1.1. Мультимедиа: прогресс, повторы, просмотрщик, таймауты
- [ ] `src/lib/upload.ts` — новый модуль `uploadWithRetry` (прямой XHR, `attempts: 3`, `onProgress`, `UploadError`), `getCsrfToken()` экспортируется из `src/lib/apiTransport.ts`.
- [ ] `src/views/OrderModals.tsx` — переписать `handleFileUpload` на `uploadWithRetry`; состояния `uploadItems`/`failedUploads`; прогресс-бары; кнопка «Повторить неудачные»; фото — просмотрщик по клику.
- [ ] `server.ts` — `server.requestTimeout = 0` (или `UPLOAD_REQUEST_TIMEOUT_MS`), `server.headersTimeout = 60_000`, `server.timeout = 0`.
- [ ] Опционально: Screen Wake Lock на время загрузки (`navigator.wakeLock?.request('screen')`).
- **Критерии:** прогресс по каждому файлу; ошибка одного не блокирует остальные; «Повторить» отправляет только упавшие файлы; фото открывается во весь экран; в IndexedDB `pv_offline_db` нет записей с `File` для загрузок.

### 1.2. Push-уведомления (заметка 2)
- [ ] Миграция `013_push_subscriptions.sql` (таблица `push_subscriptions`, перенос из `chat_push_subscriptions`; старую таблицу удаляет `017`-подобная часть или отдельная миграция).
- [ ] `server/services/push.ts` — `sendPushToUser`, `sendPushToRoom`, `notifyPush` (setImmediate, чтобы не отправлять внутри незакоммиченной транзакции); очистка подписок при 404/410.
- [ ] `server/routes/push.ts` — `GET /key`, `POST /subscription`, `DELETE /subscription`; монтируется в `server/app.ts` как `/api/push`.
- [ ] `server/security.ts` — `notifyUser` вызывает `notifyPush` с `url` (deep link) и `tag`.
- [ ] `server/routes/chat.ts` — `broadcast()` использует `sendPushToRoom`; убрать прямые обращения к `webpush` и `chat_push_subscriptions`.
- [ ] `public/chat-push.js` — `tag`, `data.url`, `notificationclick` с `clients.matchAll` (фокус уже открытого окна или `openWindow`).
- [ ] `src/lib/push.ts` — `enablePushNotifications()` (HTTPS-проверка, `PushManager.subscribe`, `applicationServerKey`).
- [ ] `src/views/SettingsView.tsx` — кнопка «Включить push-уведомления» (в текущем коде кнопки нет).
- [ ] `src/App.tsx` — обработка `?task=` и `?order=` (сейчас только `?chat=`).
- **Известное ограничение:** push и офлайн-повторы не умеют отправлять «прогресс» — каждое уведомление/повтор — отдельная попытка; ограничение повторов/прогресса отправки не реализовано в текущем коде и не закрывается этим пунктом.
- **Критерии:** push приходит на Chrome и Safari при закрытом приложении; клик открывает нужный раздел; повторное включение не создаёт дубли; просроченная сессия не отключает подписку.

### 1.3. Документы: папка и `backup.ts` (опционально)
- Старая папка `accounting` совместима и сохраняет существующие файлы; её переименование — не обязательная недоделка и не требование пользователя.
- [ ] `server/routes/documents.ts` — `folder()` использует `'documents'` вместо `'accounting'` (строка 12: `path.resolve(..., 'accounting')`) — только как предложенная безопасная миграция.
- [ ] `server/services/backup.ts` — читать и копировать `uploads/documents/`, а не `uploads/accounting/`; имя файла в `files` — `uploads/documents/<uuid>` (сейчас строка 52: `files['uploads/accounting/...']`) — только в рамках той же миграции.
- [ ] `tests/backupRules.test.ts` — проверить, что тест ожидает ту же папку, что и реализация (сейчас тест прописан под `uploads/accounting`) — согласовать после выбора варианта.
- **Критерии:** перед переносом — безопасная миграция и проверка архивов (`rg -n "accounting" src server tests public` учитывает оставленные в истории `server/migrations/007`, `014`, `017`); при отказе от переноса — папки и тесты согласованы.

### 1.4. Размер файлов: `server/app.ts` и `server.ts`
- [ ] `server/app.ts` — текст ошибки `LIMIT_FILE_SIZE` использует `MAX_UPLOAD_BYTES`: `const limitMb = Math.round(Number(process.env.MAX_UPLOAD_BYTES || 0) / 1024 / 1024)`; при `limitMb > 0` — `«Размер файла превышает лимит N МБ.»`, иначе — `«Размер файла превышает допустимый лимит.»`.
- [ ] `server.ts` — см. 1.1 (таймауты).
- **Критерии:** при `MAX_UPLOAD_BYTES=300000000` ошибка говорит про 286 МБ; при `MAX_UPLOAD_BYTES=0` (без лимита) ошибка не возникает.

### 1.5. Миграции на копии рабочей БД (поручено, без подтверждения)
- [ ] Скопировать рабочую БД в тестовую (не на живой сервер).
- [ ] Применить `013`–`019` на копии; проверить, что `documents` существует, `accounting_documents` нет, `payment_method` нет в трёх таблицах, `push_subscriptions` существует.
- [ ] `PRAGMA integrity_check = ok`, `PRAGMA foreign_key_check` пуст.
- **Поручено пользователем:** безопасные проверки на копии выполняются без подтверждения; фактическое удаление рабочих данных не выполнять.

---

## 2. Оставшаяся работа — P1

### 2.1. Чат: просмотрщик и input
- [ ] `src/views/ChatView.tsx` — просмотрщик фото/видео во весь экран (клик по превью в сообщении): модалка с `max-h-[85vh]`, закрытие по клику на фон.
- [ ] `src/views/ChatView.tsx` — input композитора: `accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"`.
- **Критерии:** кликнул по фото — открылось во весь экран; видео — плеер с перемоткой; input в чате принимает видео.

### 2.2. Финансы: убрать `PAYMENT_METHOD_LABELS`
- [ ] `src/lib/api.ts` — удалить `PAYMENT_METHOD_LABELS` (строка 84; в других файлах нигде не импортируется).
- **Критерии:** `rg -n "PAYMENT_METHOD" src` — пустой вывод.

### 2.3. Дополнение пользователя: помесячное количество монтажей/смен + индивидуальное время
- Время/счётчики уже отображаются в коде: помесячные счётчики монтажей/смен выводятся в `EmployeeSalaryView` и `EmployeesView` (помесячные `visits`/`shifts` из `GET /summary`), индивидуальное время — `server/routes/orders.ts` `PUT /work-time` + `GET /work-times` (таблица `visit_work_times`, миграция `019`, тест `visitWorkTimes.test.ts`), UI `VisitWorkTime` в `OrderModals.tsx` (строки 2931–2959): форма «Моё время работы» + список записей по дате.
- **Необходимая проверка:** автотесты (`npm test`) и `npm run build` разрешены пользователем и не требуют подтверждения; проверить, что `EmployeeSalaryView` и `EmployeesView` корректно отображают помесячные счётчики у конкретного сотрудника и у админа.
- **Критерии:** в карточке сотрудника видна помесячная таблица; у каждого монтажника можно записать индивидуальное время начала/конца каждого дня выезда; админ видит все записи по выезду.

---

## 3. Оставшаяся работа — P2 / не начинать

- [ ] **Доступ из РФ без VPN (заметка 5):** отложен. Не менять DNS, не настраивать VPS/Caddy/Tailscale/WireGuard без явного поручения; проверки на устройствах выполняет пользователь.
- [ ] **Выкладка на сервер / публикация:** отложены по прямому указанию. `npm run build` разрешён пользователем и не требует подтверждения.
- [ ] **Очистка данных (`reset:data`):** скрипт не создан; план исходного документа предполагал `server/scripts/resetData.ts`. Пользователь поручил подготовить `resetData` и проверить на копии: безопасная подготовка и проверки на копии выполняются без подтверждения, фактическое удаление рабочих данных не выполнять.

---

## 4. Таблица сверки 7 исходных замечаний + дополнение

| # | Замечание | Реализовано в коде | Осталось |
|---|---|---|---|
| 1 | Мультимедиа и оконченные монтажи | `multiple`, `accept="image/*,video/*"`, `skipOfflineQueue`, `diskStorage`, `MAX_UPLOAD_BYTES`, `<video controls>` в списке, загрузка после `completed` работает | прогресс по файлу, `uploadWithRetry` (3 попытки), кнопка «Повторить», просмотрщик фото, `server.ts` таймауты, опц. Wake Lock; окончательное устранение «вечного ребута» подтверждается проверкой на iPhone |
| 2 | Push Safari/Chrome | `chat.ts` VAPID + `broadcast()`, `push-key`/`push-subscription`, `public/chat-push.js` (открывает окно) | общий сервис `push.ts`, роутер `/api/push`, миграция `013`, `notifyUser` → push, `tag`/`url`, `SettingsView` кнопка, `?task=`/`?order=` в `App.tsx`; ограничение: прогресс/повторы push не реализованы |
| 3 | Документы и права | `documents.ts` (diskStorage, категории, `documentsAccess`), `DocumentsView.tsx` (вкладки Акты/Чертежи), `014`/`017` миграции, `AppShell.tsx` «Документы»; старая папка `accounting` совместима и сохраняет существующие файлы | переименование папки — не требование пользователя; если предлагать перенос — только с безопасной миграцией и проверкой архивов; согласовать `backup.ts` и `tests/backupRules.test.ts` |
| 4 | Ответ/Enter/превью чата | `015_chat_reply`, сервер `replyToId` + `reply_body`/`reply_author`, `ChatView.tsx` (кнопка Ответить, цитата, Enter/Shift+Enter + `isComposing`, превью фото/видео/аудио, `previewUrl` локальный), видео в `chat.ts` + сигнатура, Range в `GET /files/:id` (тест 206) | просмотрчик во весь экран, `accept` в input композитора |
| 5 | Доступ из РФ без VPN | отложен — не менять VPN/инфраструктуру; проверки на устройствах выполняет пользователь | VPS/Caddy/Tailscale/DNS — только после явного поручения |
| 6 | Размер файлов | `diskStorage` + `MAX_UPLOAD_BYTES` в `orders.ts`, `chat.ts` (messages), `documents.ts`; лимит 12 МБ удалён | текст ошибки `LIMIT_FILE_SIZE` в `server/app.ts` не учитывает `MAX_UPLOAD_BYTES`; таймауты Node в `server.ts` не отключены |
| 7 | Финансы/сводки/долги/журналы | `018` (удаление `payment_method`), `salaries.ts` `/summary` (разбивка + `activity`), `/ledger`, `/monthly`, `EmployeesView.tsx` (сводка, долг, журнал, месяцы), `paymentMethod` из `finance.ts`/`salaries.ts` удалён; помесячные счётчики монтажей/смен отображаются в `EmployeeSalaryView` и `EmployeesView` (кодовая реализация) | убрать `PAYMENT_METHOD_LABELS` из `src/lib/api.ts`; необходимая проверка отображения `activity` (автотесты разрешены) |
| D | Помесячное # монтажей/смен + индивидуальное время | время/счётчики уже отображаются в коде: `EmployeeSalaryView` и `EmployeesView` (помесячные счётчики), `visit_work_times` + `019`, `PUT/GET /work-time` (тест `visitWorkTimes.test.ts`), `VisitWorkTime` в `OrderModals.tsx` | необходимая проверка: автотесты и `npm run build` разрешены, не требуют подтверждения |

---

## 5. Порядок и правила

1. Сначала P0 (1.1 → 1.5), затем P1 (2.1 → 2.3). Отложенные пункты (VPN, выкладка) — только после явного поручения; проверки на устройствах выполняет пользователь.
2. `npm run lint`, `npm test` и `npm run build` разрешены пользователем и подтверждаются дополнительно не требуются; коммиты делать после прохождения автотестов.
3. Подготовка `resetData` и проверки на копии рабочей БД поручены пользователем: безопасные проверки выполняются без подтверждения, фактическое удаление рабочих данных не выполнять.
4. Git: изменения разрешены; коммиты делать после прохождения автотестов.
5. Не разглашать секреты; чтение резервной копии и подключение для проверок в пределах последующих задач разрешены.

---

## 6. Ключевые пути

| Файл | Роль в остатке |
|---|---|
| `src/lib/upload.ts` | новый: `uploadWithRetry` (XHR, 3 попытки, прогресс) |
| `src/lib/apiTransport.ts` | экспорт `getCsrfToken()` |
| `src/views/OrderModals.tsx` | `handleFileUpload` → `uploadWithRetry`, `uploadItems`/`failedUploads`, просмотрщик фото |
| `server.ts` | `requestTimeout`/`headersTimeout`/`timeout` |
| `server/services/push.ts` | новый: общий push-сервис |
| `server/routes/push.ts` | новый: `/api/push` |
| `server/security.ts` | `notifyUser` → `notifyPush` |
| `server/routes/chat.ts` | `broadcast()` через `sendPushToRoom`, убрать `webpush` |
| `public/chat-push.js` | `tag`, `data.url`, `notificationclick` с `clients.matchAll` |
| `src/lib/push.ts` | новый: `enablePushNotifications` |
| `src/views/SettingsView.tsx` | кнопка «Включить push» |
| `src/App.tsx` | `?task=` / `?order=` |
| `server/routes/documents.ts` | `folder()` → `'documents'` (опциональная безопасная миграция) |
| `server/services/backup.ts` | `uploads/documents/` вместо `uploads/accounting/` (только в рамках миграции) |
| `tests/backupRules.test.ts` | согласовать ожидаемую папку |
| `server/app.ts` | текст `LIMIT_FILE_SIZE` с `MAX_UPLOAD_BYTES` |
| `src/lib/api.ts` | удалить `PAYMENT_METHOD_LABELS` |
| `src/views/EmployeesView.tsx` / `EmployeeSalaryView` | помесячные счётчики уже отображаются — необходимая проверка автотестами |
| `server/scripts/resetData.ts` | подготовка поручена; фактическое удаление рабочих данных не выполнять |
| `server/migrations/013_push_subscriptions.sql` | новая миграция |

---

## 7. Что сознательно не делать сейчас

- Не менять VPN/инфраструктуру (заметка 5 отложена); проверки на устройствах выполняет пользователь.
- Не выкладывать на сервер (отложено по указанию); `npm run build` разрешён и не требует подтверждения.
- Не применять миграции на рабочей БД без поручения; подготовка `resetData` поручена, фактическое удаление рабочих данных не выполнять.
- Не делать несколько файлов в одном сообщении чата (нужна отдельная таблица `chat_message_files`).
- Не делать chunked/resumable upload (прямой multipart + 3 попытки + «Повторить» — финальная схема этого релиза).
