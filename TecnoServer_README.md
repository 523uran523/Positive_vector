# Positive_vector CRM — серверные настройки для Android + Termux

Этот репозиторий содержит конфигурацию развёртывания CRM «Позитив Вектор» на Android-устройстве (TECNO AD11) через Termux с публикацией по HTTPS через Cloudflare Tunnel.

## Структура

```
TecnoServer/
├── .cloudflared/
│   ├── config.yml          # Конфигурация Cloudflare Tunnel (ingress)
│   └── README.md           # Инструкция по туннелю
├── termux/
│   ├── setup-services.sh   # Настройка службы CRM в Termux (runit/termux-services)
│   ├── install-termux.sh   # Установка зависимостей Termux (nodejs, cloudflared)
│   └── OPERATIONS.md       # Инструкции по развёртыванию и эксплуатации
├── env/
│   └── .env.example        # Пример переменных окружения (без секретов)
├── health/
│   └── health_check.sh     # Скрипт проверки состояния сервера
├── dns/
│   └── dns_records.md      # DNS-записи Cloudflare (CNAME crm, dev, business)
└── README.md               # Этот файл
```

## Адреса

| Сервис | Адрес | Назначение |
|--------|-------|------------|
| CRM | `https://crm.gulya-studio.ru` | Основная CRM-система |
| SSH/консоль | `https://dev.gulya-studio.ru` | Разработка и администрирование |
| Бизнес-сайт | `https://business.gulya-studio.ru` | Корпоративный сайт (репозиторий MeWeb) |

## Настройка

### 1. Подготовка телефона (Termux)
- Установить Termux, Termux:Boot, termux-services
- Установить `pkg install nodejs cloudflared`
- Скопировать исходники проекта в `~/pv/`
- Создать приватный `.env` (не коммитить в Git!)

### 2. Cloudflare Tunnel
- Создать named tunnel в Cloudflare Dashboard или через `cloudflared tunnel create`
- Настроить CNAME-записи:
  - `crm.gulya-studio.ru` → `[TUNNEL_ID].cfargotunnel.com` (proxied)
  - `dev.gulya-studio.ru` → `[TUNNEL_ID].cfargotunnel.com` (proxied)
  - `business.gulya-studio.ru` → `[TUNNEL_ID].cfargotunnel.com` (proxied)
- Настроить ingress в `.cloudflared/config.yml`

### 3. Запуск CRM
```bash
cd ~/pv
NODE_ENV=production npm start
```

### 4. Автозапуск
Настроить через termux-services (runit):
```bash
sv up pv-crm
sv up pv-tunnel
```

## Безопасность

- `.env` с `SESSION_SECRET` и другими секретами НЕ коммитится в Git
- Рабочая база данных (`data/*.sqlite`) НЕ коммитится
- Вложения пользователей (`data/uploads/`) НЕ коммитится
- Все секреты хранятся только на устройстве

## Статус развёртывания

- CRM сервер: работает на `127.0.0.1:3000` (проверен `/api/health` → 200 OK)
- Cloudflare Tunnel: настроен, ID `d032763f-1d59-44e5-ac5c-09c6b778de63`
- DNS `crm.gulya-studio.ru`: CNAME запись создана в Cloudflare
- Публичный HTTPS: подтверждён через `/api/health` → 200 OK
- dev.gulya-studio.ru: требует настройки
- business.gulya-studio.ru: требует настройки
- Автозапуск: требует настройки termux-services

## Требования к доступу

Для продолжения настройки требуется:
1. Разблокировка экрана телефона TECNO AD11 и подтверждение USB-отладки
2. API-токен Cloudflare с правами на зону `gulya-studio.ru` (для DNS-записей dev и business)
3. GitHub Personal Access Token (для создания репозитория и пуша настроек)