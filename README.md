<div align="center">

# Messengers2amo

### Мессенджеры и amoCRM в одном рабочем процессе

Собственный шлюз сообщений: каналы связи → надёжная обработка → штатные чаты amoCRM.

[![CI](https://github.com/impossi8le/messengers2amo/actions/workflows/api.yml/badge.svg)](https://github.com/impossi8le/messengers2amo/actions/workflows/api.yml)
[![Security](https://github.com/impossi8le/messengers2amo/actions/workflows/security.yml/badge.svg)](https://github.com/impossi8le/messengers2amo/actions/workflows/security.yml)
![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)

[Возможности](#возможности) · [Каналы](#каналы) · [Запуск](#запуск) · [Архитектура](#архитектура) · [Документация](#документация)

</div>

## Зачем нужен проект

Messengers2amo — самостоятельно размещаемая интеграция мессенджеров с amoCRM и административная консоль для команды. Менеджеры работают с клиентами в штатных чатах CRM; шлюз принимает события, сохраняет сообщения, связывает диалоги с CRM и контролирует обработку обращений.

Проект разрабатывается как собственная альтернатива внешнему сервису интеграции мессенджеров для одной компании. Репозиторий включает API, фоновые обработчики, веб-интерфейс, SQL-миграции, тесты и инструкции по эксплуатации.

## Возможности

| Область | Функциональность |
| --- | --- |
| **Диалоги и обращения** | Очередь обращений, карточка диалога, история сообщений, учёт ожидания ответа и непрочитанного |
| **Работа команды** | Назначение и передача обращений, доступность сотрудников, ограничения нагрузки и маршруты мастерских |
| **amoCRM** | OAuth, обновление токенов, справочники сотрудников и воронок, связи с контактами и сделками, проекция сообщений и обработка ответов |
| **Вложения** | Обработка файлов, метаданных и аватаров, S3-совместимое хранилище, проверка типов и SHA-256 |
| **Подключения** | Управление подключениями, настройка Telegram, каталог каналов и возможностей, состояние и диагностика интеграций |
| **Доставка** | Сохраняемые inbox/outbox, дедупликация, идемпотентные команды, блокировки обработчиков и контроль устаревших привязок |
| **Контроль отправки** | Режимы `off`, `pilot` и `all`; ограничение пилота компанией, подключением и диалогом |
| **Доступ и аудит** | Серверные сессии, роли и области доступа, хеширование паролей, отзыв сессий и журналирование действий |
| **Эксплуатация** | Health/readiness, защищённые метрики, алерты, Grafana, резервное копирование и репетиция восстановления |

Прочтение сообщения само по себе не закрывает ожидание ответа. Неопределённый результат отправки (`unknown`) обрабатывается отдельно, чтобы избежать слепых повторов и дубликатов.

## Каналы

| Канал | Что есть в исходниках |
| --- | --- |
| **Telegram Bot** | Настройка бота, webhook/polling, обработка входящих, отправка, вложения и связка с amoCRM |
| **WhatsApp Cloud API** | Проверка webhook, адаптер входящих и исходящих сообщений |
| **MAX Bot** | Адаптер канала и проверка webhook |
| **VK Community** | Callback API, подтверждение подключения и адаптер сообщений |
| **Другие режимы и провайдеры** | Расширяемый каталог: Telegram Personal/Business, WhatsApp QR, Viber, Instagram, Facebook, LINE, Slack, Teams, email и другие |

Запись в каталоге не означает готовое подключение. Возможности отправки и приёма остаются неподтверждёнными, пока их не подтвердит конкретный runtime-адаптер. Для каждого канала нужны собственные доступы, настройка провайдера и сквозная проверка.

## Архитектура

```mermaid
flowchart LR
    T[Telegram] --> I[Webhook / polling]
    W[WhatsApp Cloud] --> I
    M[MAX / VK] --> I
    I --> Q[(PostgreSQL: inbox)]
    Q --> P[Обработчики и доменная логика]
    P <--> C[amoCRM: чаты, контакты, сделки]
    C --> O[(PostgreSQL: outbox)]
    O --> S[Контроль отправки и worker]
    S --> T
    S --> W
    S --> M
    A[React-консоль] <--> API[Fastify API]
    API <--> Q
    P <--> F[S3: вложения]
```

**Сервер:** Node.js 24, TypeScript, Fastify 5, PostgreSQL 18, Zod и Pino. **Интерфейс:** React 18, Vite, Redux Toolkit / RTK Query, React Router и SCSS. **Проверки:** Node test runner, Vitest, Testing Library, TypeScript и GitHub Actions. **Развёртывание:** Docker Compose, Nginx и S3-совместимое хранилище.

## Запуск

### Локальная демонстрация

Нужен **Node.js 24**. Демостенд работает без внешних доступов, npm-зависимостей и Docker:

```bash
git clone https://github.com/impossi8le/messengers2amo.git
cd messengers2amo/local-telegram
node --env-file=.env.demo src/server.mjs
```

Откройте **http://127.0.0.1:3211**. Это отдельный локальный Telegram-стенд с SQLite и синтетическими сообщениями. Основное приложение и интеграция amoCRM запускаются отдельно. Подробнее — [инструкция стенда](local-telegram/README.md).

### Основной контур через Docker Compose

```bash
cd ops/deploy/messengers2amo
cp .env.example .env
# Заполните .env: PostgreSQL, SESSION_SECRET и нужные интеграции.
docker compose up -d --build
```

Compose поднимает PostgreSQL, применяет миграции, запускает API и worker. API доступен на **http://127.0.0.1:18767**. Настройка HTTPS, интерфейса, хранилища и внешних каналов описана в [руководстве развёртывания](ops/deploy/messengers2amo/DEPLOY-RUNBOOK.md). Исходящая отправка требует явного включения и выбора режима.

### Разработка

У каждого приложения и пакета собственный `package.json` и lockfile. Команды выполняются из корня репозитория:

```bash
npm --prefix apps/api ci
npm --prefix apps/web ci
npm --prefix apps/api run typecheck
npm --prefix apps/web run build
npm --prefix apps/web test

# API-тестам нужна отдельная локальная PostgreSQL 18.
# TEST_DATABASE_URL по умолчанию:
# postgres://testuser:testpass@127.0.0.1:55440/m2a
npm --prefix apps/api test

# Автономный Telegram-стенд
npm --prefix local-telegram test
```

Для общих пакетов выполните `npm ci` и `npm test` в нужном каталоге `packages/*`. Проверки доменной БД включаются отдельно; команды описаны в [документации БД](docs/database/README.ru.md).

Для локального интерфейса: `npm --prefix apps/web run dev`. Настройте `VITE_API_BASE_URL` по [примеру](apps/web/.env.example) и обеспечьте общий origin с API через reverse proxy для сессионных cookie.

## Структура проекта

```text
apps/
  api/                  HTTP API, интеграции, worker, миграции и тесты
  web/                  Консоль операторов и администраторов
packages/
  contracts/            JSON-схемы и контракты API
  database/             Доменная схема, миграции и проверки БД
  amocrm-protocol/       Протокол интеграции amoCRM
  observability/        Контракты событий и безопасного логирования
local-telegram/         Автономный Telegram-стенд и демонстрация
docs/                   Архитектура, требования и сценарии приёмки
ops/                    Compose, Nginx, мониторинг, backup и runbooks
.github/workflows/      CI, проверки зависимостей и поиск секретов
```

## Документация

- [Каталог документации](docs/README.ru.md)
- [Архитектура платформы](docs/messenger-platform-architecture.ru.md) и [доменная логика](docs/messenger-domain-logic.ru.md)
- [Контракты API](docs/contracts/README.ru.md) и [протокол amoCRM](docs/amocrm/protocol.ru.md)
- [Файлы и вложения amoCRM](docs/amocrm/inbound-files.ru.md)
- [Условия включения каналов](docs/channels/integration-gates.ru.md)
- [Руководство оператора](ops/runbooks/operator-guide.ru.md) и [администратора](ops/runbooks/admin-guide.ru.md)
- [Диагностика](ops/runbooks/troubleshooting.ru.md), [мониторинг](ops/deploy/messengers2amo/MONITORING.md) и [восстановление](ops/deploy/messengers2amo/BACKUP-RESTORE.md)
- [Правила разработки](CONTRIBUTING.md) и [сообщения об уязвимостях](SECURITY.md)

## Статус и состав публикации

Это снимок разрабатываемого проекта на **29 октября 2026 года**, включая текущие локальные изменения. Рабочие адреса инфраструктуры заменены примерами. Локальные ключи, `.env` с настройками, сессии, базы, переписка, дампы и временные каталоги не включены. История исходного рабочего репозитория в этот снимок не переносится.

Исторические документы отражают состояние на указанные в них даты. Актуальный результат проверок смотрите в [Actions](https://github.com/impossi8le/messengers2amo/actions); доступность внешних интеграций проверяется отдельно.

Репозиторий опубликован для ознакомления. Лицензия на использование и распространение пока не установлена.
