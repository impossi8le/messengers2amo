# Неисправности: симптом → причина → что делать

Таблица для администратора и дежурного. Все команды выполняются на сервере в каталоге
`/opt/messengers2amo`, если не указано иное. Схема БД ниже — `messengers2amo`; если в вашей
установке `M2A_SCHEMA` другой, замените имя схемы.

Подготовка оболочки:

```bash
cd /opt/messengers2amo
set -a; . ./.env; set +a
API=https://messengers.example.com

psql_q() {
  docker compose -p messengers2amo exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -F' | ' -c "$1"
}
```

Токен метрик не печатайте в чат и не вставляйте в URL. Он передаётся только заголовком
`Authorization: Bearer`.

## Таблица

| № | Симптом | Как проверить | Что означает результат | Что делать |
|---|---|---|---|---|
| 1 | `/health/ready` отдаёт 503 | `curl -s -o /dev/null -w '%{http_code}\n' $API/health/ready` и `docker compose -p messengers2amo ps` | 503 `{"dependency":"database"}` — API жив, но не может выполнить `SELECT 1`. Контейнер `postgres` не healthy, диск переполнен или соединения исчерпаны. | Не перезапускайте API в цикле. Смотрите `docker compose logs --tail=100 postgres`, `df -h /`, `free -m`. `/health/live` при этом должен отвечать 200. Процедура — [MONITORING §2](../deploy/messengers2amo/MONITORING.md). |
| 2 | `/metrics` отдаёт 401 | `curl -s -o /dev/null -w '%{http_code}\n' $API/metrics`; затем с токеном: `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $METRICS_TOKEN" $API/metrics` | Без токена 401 — защита работает. С токеном тоже 401 — токен не совпадает или передан не в заголовке. | Проверьте `METRICS_TOKEN` в `.env` и в конфигурации Prometheus. Токен чувствителен к регистру и пробелам. После смены токена перезапустите `api`: `docker compose -p messengers2amo up -d api`. |
| 3 | `/metrics` отдаёт 503 | `curl -s -o /dev/null -w '%{http_code}\n' $API/metrics`; `curl -fsS $API/health/ready`; `docker compose -p messengers2amo exec -T api printenv DB_SCHEMA`; `grep -E '^(M2A_SCHEMA\|DB_SCHEMA)=' .env` | `/health/ready` 200, а `/metrics` 503 — чаще всего `DB_SCHEMA` не совпадает с `M2A_SCHEMA` и метрики читают пустую схему `public`. Реже — запрос метрик упал по таймауту. | Приведите `DB_SCHEMA` к `M2A_SCHEMA` (`messengers2amo`), перезапустите `api`. Оба значения в `.env` должны совпадать. |
| 4 | `/metrics` отдаёт 404 | `curl -s -o /dev/null -w '%{http_code}\n' $API/metrics` | Маршрут не зарегистрирован: `METRICS_TOKEN` пуст. Это не ошибка, а отключённая функция. | Если метрики нужны — задайте `METRICS_TOKEN` (`openssl rand -hex 24`) и перезапустите `api`. Если не нужны — оставьте пустым и не настраивайте scrape. |
| 5 | `/health/live` не отвечает, контейнер перезапускается | `docker inspect --format '{{.Name}} {{.State.Health.Status}}' $(docker ps -q --filter name=messengers2amo)`; `docker compose -p messengers2amo logs --tail=200 api` | Контейнер не проходит liveness или падает при старте. Частые причины: неверный `DATABASE_URL`, короткий `SESSION_SECRET`, ошибка конфигурации. | Сначала сохраните логи. Проверьте обязательные переменные в `.env`. Не запускайте `down -v`. После исправления — `docker compose -p messengers2amo up -d`. |
| 6 | Сообщения не приходят | `docker compose -p messengers2amo logs --since 30m api \| grep -E 'telegram.webhook\|telegram.inbox'`; `psql_q "SELECT state, count(*) FROM \"messengers2amo\".inbox_events GROUP BY state"` | Нет записей `telegram.webhook.stored` — webhook не доходит. `401 bad_secret` — не совпал `TELEGRAM_WEBHOOK_SECRET`. `404 connection_not_found` — неверный `connectionId` в URL или канал не Telegram. `503 telegram_not_configured` — не задан токен/секрет. | Сверьте URL webhook у провайдера с `/webhooks/telegram/{connectionId}`. Проверьте `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`. Если события есть в `inbox_events`, но не обрабатываются — см. строку 7. |
| 7 | Входящие зависли в `pending` или `processing` | `psql_q "SELECT state, count(*), round(max(extract(epoch FROM now()-received_at))) AS oldest_s FROM \"messengers2amo\".inbox_events WHERE state IN ('pending','processing','failed','quarantined') GROUP BY state"`; `docker compose -p messengers2amo logs --since 30m api \| grep -E 'inbox.drain_failed\|inbox.drained'` | `pending` старше 300 секунд — обработчик не разбирает очередь. `processing` старше 300 секунд — обработчик завис. `failed` — ошибка применения события. `quarantined` — payload отклонён. | Проверьте логи `telegram.inbox.drain_failed`. Не удаляйте события. Для `failed` сначала устраните причину, затем разбирайте повторно. Для `quarantined` — ручная проверка, не воспроизводите в эффекты. |
| 8 | Ответ остаётся «Принято сервером» или «В очереди» | В консоли откройте операцию; или `psql_q "SELECT state, count(*) FROM \"messengers2amo\".send_operations GROUP BY state"`; `psql_q "SELECT state, count(*), round(max(extract(epoch FROM now()-created_at))) AS oldest_s FROM \"messengers2amo\".outbox_jobs WHERE state IN ('pending','leased') GROUP BY state"` | `accepted`/`queued` — команда записана, но обработчик отправки её не забрал. Если `outbox_jobs` растёт, воркер не работает. | Проверьте сервис `worker` в `docker compose -p messengers2amo ps` и его логи; воркер запускает `apps/api/src/worker.ts` и разбирает `outbox_jobs`. Не удаляйте задания. |
| 9 | Ответ «Отправлено», но клиент не получил | `psql_q "SELECT id, state, provider_message_id, coverage FROM \"messengers2amo\".send_operations WHERE id='<operation-id>'"`; в консоли — блок статуса операции | `sent` означает подтверждение провайдера, а не доставку конкретному человеку. `provider_message_id` есть — провайдер принял сообщение. Подтверждение доставки (`deliveryEvidence`) может отсутствовать, если канал не присылает таких событий. | Проверьте чат у клиента и здоровье подключения. Если провайдер подтвердил, а клиент не видит — разбирайтесь на стороне провайдера (блокировка, другой чат, лимиты). Не отправляйте повторно тот же текст без решения администратора. |
| 10 | Задания копятся в очереди | `curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" $API/metrics \| grep -E 'm2a_outbox_(jobs\|overdue)'`; `psql_q "SELECT state, count(*), count(*) FILTER (WHERE state='leased' AND lease_until < now()) AS expired, round(max(extract(epoch FROM now()-created_at))) AS oldest_s FROM \"messengers2amo\".outbox_jobs WHERE state IN ('pending','leased','failed','unknown') GROUP BY state"` | `m2a_outbox_overdue_jobs > 0` — очередь не разбирается. `expired > 0` — обработчик умер, держа аренду. `pending` старше 300 секунд — обработчик не запущен или стоит. | Проверьте `docker compose ps` и логи. Не удаляйте строки. Просроченная аренда разбирается воркером; если воркера нет — это ограничение сборки, эскалируйте. Подробно — [MONITORING §3.2](../deploy/messengers2amo/MONITORING.md). |
| 11 | Появились операции «Результат неизвестен» | `curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" $API/metrics \| grep 'm2a_send_operations{state="unknown"}'`; `psql_q "SELECT id, created_at, deadline FROM \"messengers2amo\".send_operations WHERE state='unknown' ORDER BY created_at LIMIT 20"` | Провайдер не дал однозначного ответа: сообщение могло уйти. Это не ошибка, которую можно «повторить». | Остановитесь. Сверьте с провайдером и чатом клиента. Не повторяйте автоматически. Процедура — [ROLLBACK §5](../deploy/messengers2amo/ROLLBACK.md). |
| 12 | amoCRM не синхронизируется | `psql_q "SELECT id, state FROM \"messengers2amo\".crm_accounts"`; `psql_q "SELECT conversation_id, last_status, last_error_code, last_attempt_at FROM \"messengers2amo\".crm_sync_state ORDER BY last_attempt_at DESC LIMIT 20"`; `psql_q "SELECT state, count(*) FROM \"messengers2amo\".crm_create_intents GROUP BY state"` | `crm_accounts.state` не `active` — интеграция не авторизована. Нет строк в `crm_sync_state` — синхронизация ещё не запускалась. `crm_binding_missing` — нет привязки диалога. `crm_lead_missing` — сделка не найдена. `upstream_unavailable` — amoCRM недоступен. `creation_unknown` — сущность могла быть создана. | Для `crm_binding_missing` создайте/проверьте привязку. Для `crm_lead_missing` проверьте сделку. Для `upstream_unavailable` — доступность amoCRM и сеть. Для `creation_unknown` — сверка, не повторное создание. Ручной ресинк: `POST /api/v2/operator/crm/resync` (роль `manage`). |
| 13 | Доступ amoCRM отозван | `psql_q "SELECT id, state FROM \"messengers2amo\".crm_accounts"`; `docker compose -p messengers2amo logs --since 24h api \| grep -E 'amocrm.auth_revoked\|amocrm.oauth'` | `state='revoked'`, в логах `amocrm.auth_revoked` — приложение или пользователь отозвали доступ. Обновление токена не работает. | Повторите авторизацию: `GET /api/v2/integrations/amocrm/oauth/authorize` под ролью `admin`. Если отзыв повторяется — проверьте приложение и разрешения в amoCRM. |
| 14 | Группа не исключается из CRM | `psql_q "SELECT connection_id, crm_projection_enabled, private_import_enabled FROM \"messengers2amo\".channel_policies"`; `psql_q "SELECT connection_id, binding_epoch, external_chat_id, decision FROM \"messengers2amo\".channel_group_rules"`; `psql_q "SELECT id, chat_kind, binding_epoch FROM \"messengers2amo\".conversations WHERE external_chat_id='<chat-id>'"` | Нет строки `channel_policies` — запрещено всё, но и проекции нет. `crm_projection_enabled=false` — проекция выключена. Правило задано для другой `binding_epoch` — не применяется. `chat_kind='private'` — правило группы не используется. | Включите политику, задайте правило для текущей эпохи, проверьте `chat_kind`. Проверка функцией: `SELECT "messengers2amo".channel_crm_import_allowed('<company>','<connection>',<epoch>,'<chat-id>','group')`. Уже созданные задания/связи задним числом не отменяются. |
| 15 | Оператор не видит диалог | `psql_q "SELECT staff_id, role, workshop_id FROM \"messengers2amo\".staff_access WHERE staff_id='<staff-id>'"`; `psql_q "SELECT connection_id, workshop_id FROM \"messengers2amo\".connection_routes"`; `psql_q "SELECT workshop_id, staff_id FROM \"messengers2amo\".workshop_staff WHERE staff_id='<staff-id>'"`; `psql_q "SELECT connection_id, staff_id, can_read, can_send FROM \"messengers2amo\".channel_permissions WHERE staff_id='<staff-id>'"` | Сотрудник с `workshop_id` видит только подключения, привязанные к его мастерской. Нет маршрута — нет видимости. Нет членства или `can_read` — нет доступа. | Добавьте маршрут, членство в мастерской и право чтения. Помните: чужая мастерская и несуществующий объект выглядят одинаково (`404`), чтобы не раскрывать существование. |
| 16 | «Взять в работу» или передача отклонены | В консоли текст ошибки; `psql_q "SELECT id, state, owner_id, assignment_version FROM \"messengers2amo\".work_items WHERE id='<work-item-id>'"`; `psql_q "SELECT id, capacity, active_count FROM \"messengers2amo\".staff WHERE id='<staff-id>'"` | `VERSION_CONFLICT` — обращение уже взял другой оператор или версия изменилась. `CAPACITY_EXCEEDED` — `active_count >= capacity` или `capacity = 0`. | Нажмите «Перечитать карточку» и повторите. Для вместимости — освободите слоты или увеличьте `capacity`. Не повторяйте команду со старой версией. |
| 17 | Отправка заблокирована: «снимок устарел» | В консоли — «Диалог изменился»; `psql_q "SELECT id, assignment_version, created_at FROM \"messengers2amo\".reply_snapshots WHERE work_item_id='<work-item-id>' ORDER BY created_at DESC LIMIT 5"`; `psql_q "SELECT id, content_version, state FROM \"messengers2amo\".attention_obligations WHERE work_item_id='<work-item-id>' AND state='open'"` | Снимок относился к другой версии назначения или другому набору вопросов. Появился новый вопрос, правка или передача. | «Применить свежий снимок», проверьте новые вопросы, при необходимости выберите их. Не отправляйте со старым снимком. |
| 18 | Вложение отклонено | `psql_q "SELECT id, state, mime_type, byte_size FROM \"messengers2amo\".media_assets WHERE id='<media-id>'"` | `rejected` — тип не разрешён или не совпала контрольная сумма. `quarantined` — хранилище не подтвердило размер/хеш. `pending_upload` — файл не догружен. `413` — больше 100 МБ. `415` — тип не в allowlist. | Проверьте тип и размер. Допустимы JPEG/PNG/WebP/GIF/HEIC, PDF, TXT, CSV, MP3/OGG/WAV, MP4/WebM, DOCX/XLSX. Один файл на ответ. Для `quarantined` — разбор хранилища, не повторяйте загрузку вслепую. |
| 19 | Подключение в состоянии «Требуется авторизация» или «Сбои» | `psql_q "SELECT id, channel_mode, state, health FROM \"messengers2amo\".connections"`; в консоли — «Подключения» | `auth_required` — токен/сессия канала недействительны. `degraded` — провайдер отвечает ошибкой. `health.errorCode` показывает причину: `AUTH_REQUIRED`, `POLLING_CONFLICT`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `CONFIGURATION_REQUIRED`, `INTERNAL_ERROR`. | Для `AUTH_REQUIRED` — переавторизуйте канал. Для `POLLING_CONFLICT` — проверьте, не использует ли токен другой потребитель. Для `CONFIGURATION_REQUIRED` — проверьте `credentialRef` и настройки канала. |
| 20 | В интерфейсе «Нет связи с сервером» | `curl -s -o /dev/null -w '%{http_code}\n' $API/health/ready`; проверьте сеть браузера и вкладку Network | Сервер недоступен, истёк TLS, nginx не проксирует или проблема на стороне пользователя. | Повторите запрос. Если health тоже не отвечает — строка 1. Если health 200, а консоль нет — проверьте nginx и `VITE_API_BASE_URL`. Сохраните request id из ошибки. |
| 21 | «Сессия истекла» | `POST /api/v2/auth/login` с `companyId`, `staffId`, `password`; `docker compose -p messengers2amo exec -T api printenv SESSION_TTL_SECONDS` | Срок сессии истёк (по умолчанию 8 часов) или сессии отозваны после смены роли. | Войдите заново. Если сессия отзывается сразу после входа — проверьте `staff_access.version` и не менялась ли роль. |
| 22 | Webhook amoCRM отвечает 401 | `docker compose -p messengers2amo logs --since 30m api \| grep -i amocrm`; `psql_q "SELECT scope_id, state FROM \"messengers2amo\".amocrm_channels"` | Неверная подпись, неизвестный scope или канал не в состоянии `connected`. Одинаковый ответ на разные причины сделан намеренно, чтобы нельзя было перебором узнать scope. | Проверьте, что вебхук настроен на правильный scope и секрет канала не менялся. Если канал `disabled` — включите его. Секрет не печатайте в чат. |
| 23 | Вебхук канала отвечает 401 | `docker compose -p messengers2amo logs --since 30m api \| grep -E 'whatsapp.webhook.rejected\|max.webhook.rejected\|vk.webhook.rejected'`; `curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/webhooks/whatsapp/<connectionId>` | Подпись или секрет не совпал: проверка идёт **до** обращения к БД, поэтому 401 не зависит от существования подключения. WhatsApp — `X-Hub-Signature-256` и `WHATSAPP_APP_SECRET`; MAX — `X-Max-Bot-Api-Secret` и `MAX_WEBHOOK_SECRET`; VK — поле `secret` и `VK_SECRET`. | Сверьте секрет в `.env` с настройкой у провайдера. Для WhatsApp подпись считается по точным полученным байтам: правка тела (перекодирование, повторная сериализация) ломает проверку. После смены значения — `docker compose -p messengers2amo up -d api`. Секрет не печатайте в чат. |
| 24 | Вебхук канала отвечает 404 | `psql_q "SELECT id, channel_mode FROM \"messengers2amo\".connections WHERE id='<connectionId>'"`; в логах — `*.webhook.rejected` отсутствует, а запрос всё равно 404 | `404 connection_not_found` — подключение не найдено **или** его `channel_mode` не соответствует пути (`whatsapp` → `whatsapp_cloud`, `max` → `max_bot`, `vk` → `vk_community`). Чужой канал выглядит как отсутствующий намеренно. `409 ambiguous_connection` — несколько строк с таким id. `503 whatsapp_not_configured`/`max_not_configured`/`vk_not_configured` — блок канала не заполнен. | Сверьте `connectionId` и `channel_mode`. Для 503 проверьте обязательные переменные канала в `.env` и перезапустите `api`. Важно: 404 приходит только после успешной проверки подписи, поэтому повторить его вручную без секрета нельзя — без подписи вы увидите 401. |
| 25 | Внутренние CRM-маршруты отвечают 404 | `curl -s -o /dev/null -w '%{http_code}\n' $API/api/v2/internal/crm/bindings`; `docker compose -p messengers2amo exec -T api printenv INTERNAL_SERVICE_TOKEN \| sed 's/./*/g'` | `INTERNAL_SERVICE_TOKEN` пуст — группа маршрутов не регистрируется, поэтому оба пути (`/api/v2/internal/crm/bindings`, `/api/v2/internal/crm/outbound`) отвечают 404. Если токен задан, без заголовка будет 401. Cookie оператора здесь не действует. | Задайте `INTERNAL_SERVICE_TOKEN` (`openssl rand -hex 32`) в `.env`, перезапустите `api` и передайте то же значение адаптеру. Проверка: без заголовка 401, с `Authorization: Bearer <token>` — 200. |
| 26 | Уведомления пустые | `psql_q "SELECT count(*) FROM \"messengers2amo\".attention_obligations o JOIN \"messengers2amo\".work_items w ON w.company_id=o.company_id AND w.id=o.work_item_id WHERE o.state='open' AND w.owner_id='<staff-id>'"`; `psql_q "SELECT id, owner_id FROM \"messengers2amo\".work_items WHERE state NOT IN ('resolved','cancelled') AND owner_id='<staff-id>'"`; в консоли — счётчики `hints` | Лента строится только по вашим обращениям: открытые вопросы, просрочки старше часа, передачи вам и отправки в состоянии «неизвестно». Нет таких фактов — лента пуста, и это норма, а не сбой. `replyRequiredCount`/`overdueCount`/`unknownSendCount` = 0 подтверждают это. | Если обращение явно ждёт ответа, проверьте, что вы его ответственный (`owner_id`) и что оно в вашей мастерской. Уведомление не хранится отдельно: после исправления назначения лента пересчитывается сама. |

## Пояснения к отдельным строкам

### Сообщения не приходят, но webhook отвечает 200

Webhook только сохраняет событие в `inbox_events`. Превращение события в диалог, сообщение и
ожидание ответа делает фоновый разбор. Если `inbox_events` в `pending`, а логов
`telegram.inbox.drained` нет, смотрите `telegram.inbox.drain_failed`: разбор падает на
конкретном событии. Не удаляйте событие — сначала устраните причину, иначе оно потеряется.

### «Отправлено» и подтверждение доставки

`sent` — это успех по контракту адаптера, а не факт, что клиент увидел сообщение.
`delivery_observed` и `read_observed` — отдельные свидетельства. Если канал не поддерживает
подтверждения, их не будет, и это не ошибка. Для диагностики используйте номер операции:
`GET /api/v2/operator/send-operations/{id}`.

### Очередь не разбирается

Обработчик отправки — сервис `worker` в `docker-compose.yml` (команда
`node apps/api/src/worker.ts`, рядом с `api`, `postgres` и одноразовым `migrate`).
Проверьте, что он запущен (`docker compose -p messengers2amo ps`) и смотрите его логи
и `lease_until`. Если воркер не развёрнут в вашей установке, рост `outbox_jobs` ожидаем
и требует развёртывания воркера, а не «починки» БД.

### Группа и эпоха привязки

Правило группы привязано к `binding_epoch`. После переподключения канала или смены привязки
эпоха увеличивается, и старое правило перестаёт действовать. Это не ошибка: так исключается
применение старого решения к новой внешней идентичности. Правило нужно задать заново для
новой эпохи.

### Оператор не видит диалог

Порядок проверки: роль → область (`workshop_id`) → маршрут подключения → членство в
мастерской → право `can_read`. Если сотрудник с областью мастерской запрашивает чужой объект,
сервер отвечает `404`, а не `403`: существование объекта не раскрывается. Это ожидаемое
поведение, а не потеря данных.

### Вебхуки каналов WhatsApp, MAX и VK

Пути и рукопожатия:

| Канал | Приём | Рукопожатие |
|---|---|---|
| WhatsApp | `POST /webhooks/whatsapp/{connectionId}` | `GET /webhooks/whatsapp/{connectionId}` с `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` |
| MAX | `POST /webhooks/max/{connectionId}` | нет |
| VK | `POST /webhooks/vk/{connectionId}` | `GET /webhooks/vk/{connectionId}?type=confirmation` |

Порядок обработки важен для диагностики: сначала проверяется подпись/секрет, потом ищется
подключение, потом тело разбирается и сохраняется. Отсюда правила чтения кодов:

- `401` — подпись неверна; до БД дело не дошло, поэтому 401 ничего не говорит о подключении;
- `404` — подпись верна, но подключения нет или оно другого канала;
- `409` — подпись верна, но строк с таким `id` несколько (аномалия данных, не исправляйте
  удалением);
- `400` — тело не разобрано. У VK невалидный JSON отсекается ещё до проверки секрета; у
  WhatsApp и MAX — после проверки подписи;
- `503` — блок канала не сконфигурирован, маршрут фактически выключен;
- `413` — тело больше 1 МиБ.

Рукопожатие WhatsApp при неверном `hub.verify_token` отвечает `403`, без `hub.challenge` —
`400`. Рукопожатие VK при `type=confirmation` отвечает `200` и кодом из
`VK_CONFIRMATION_CODE`; любой другой `GET` — `403`.

Важно: успешный ответ API означает, что маршрут и секрет в порядке, но **не** доказывает, что
подписка у провайдера включена и указывает на этот адрес. Это проверяется в кабинете
провайдера и по `health.lastInboundAt` подключения.

### Внутренние CRM-маршруты и уведомления

- Внутренние маршруты `/api/v2/internal/crm/*` — отдельная identity. Пустой
  `INTERNAL_SERVICE_TOKEN` = группа не зарегистрирована = 404. Заданный токен без заголовка =
  401. Операторская cookie здесь не действует.
- Уведомления (`GET /api/v2/operator/notifications`) — не журнал, а проекция текущего
  состояния. Пустая лента при нулевых счётчиках `hints` — норма. Ничего не «потерялось»:
  лента пересчитывается при каждом чтении.

## Что не делать

- Не выполнять `docker compose down -v` и не удалять том `messengers2amo_pgdata`.
- Не удалять строки `outbox_jobs`, `inbox_events`, `send_operations` «чтобы очередь
  пошла».
- Не повторять `unknown`-отправку «на всякий случай»: это дубль у клиента.
- Не пересоздавать сущность CRM в состоянии `creation_unknown` без сверки.
- Не включать `log_statement`/`log_min_duration_statement`: в журнал попадут тексты и
  параметры сообщений.
- Не перезапускать зависимость, не сохранив её логи: причина исчезнет вместе с состоянием.
- Не публиковать токены, телефоны, тексты переписки и ID клиентов в заявках и чатах.

## Связанные документы

- [Руководство оператора](operator-guide.ru.md)
- [Руководство администратора](admin-guide.ru.md)
- [Мониторинг: метрики, SQL, алерты](../deploy/messengers2amo/MONITORING.md)
- [Откат и unknown](../deploy/messengers2amo/ROLLBACK.md)
- [Развёртывание](../deploy/messengers2amo/DEPLOY-RUNBOOK.md)
- [Резервное копирование](../deploy/messengers2amo/BACKUP-RESTORE.md)
