# Квитанции провайдера: план миграции 003

Статус: миграция создана и применяется — packages/database/migrations/003-receipts.sql (provider_receipt_evidence, provider_receipt_links) и 004-proof-guards.sql; сценарии покрыты packages/database/test/evidence-postgres.test.mjs. Обновлено 22.10.2026. Это расширение #3, независимое от усиления существующих таблиц в 002. Основание — `schema/v2.json`: `EventEnvelope`, `EventPayloadDeliveryObserved`, `EventPayloadReadObserved`; существующая граница — `001-core.sql`.

## Факт отдельно от проекции

`delivered`, `failed` и `read` — независимые наблюдения, а не перезаписываемый статус. Повторная доставка webhook, перестановка событий и поздняя ошибка не удаляют предыдущее наблюдение. Mutable UI-проекция вычисляется отдельно; данный тест не задаёт reducer и не подтверждает отправку.

Созданы две таблицы без UPDATE/DELETE (003-receipts.sql):

| Таблица | Поля / назначение |
| --- | --- |
| `provider_receipt_evidence` | `company_id,id,connection_id,binding_epoch,external_chat_id` (nullable), `provider_message_id,kind,status,evidence_key,provider_event_key` (nullable), `occurred_at,received_at,observed_at`. Это внешние факты до нормализации. |
| `provider_receipt_links` | `company_id,evidence_id,conversation_id,message_id,operation_id,attempt_id,linked_at`. Доказанное сопоставление, PK `(company_id,evidence_id)`. Отсутствие строки означает unmatched; искусственные internal ID запрещены. |

Обязательны непустые идентификаторы, ограничения длины v2 там, где поля соответствуют v2, FK на точную identity компании/подключения/эпохи. `kind=message.delivery_observed` допускает только delivered/failed, `kind=message.read_observed` — только read. Все timestamps сохраняются отдельно; receivedAt не подменяет observedAt.

Дедупликация факта: UNIQUE `(company_id,connection_id,binding_epoch,kind,evidence_key)`. `provider_event_key` сохраняется как транспортный атрибут и не является глобальным UNIQUE: один update может содержать несколько фактов. Adapter обязан формировать стабильный evidenceKey на отдельный факт; разные delivery-статусы внутри одного update требуют разных ключей. Конфликт ключа с отличающимся содержимым нельзя молча принимать через `ON CONFLICT DO NOTHING`: ingress должен сравнить канонический fingerprint и карантинировать расхождение. Это отдельная runtime-проверка, не реализованная данным тестом. Существующий UNIQUE `inbox_provider_key` не менять молча: он относится к транспортному update, receipt evidence — к его отдельным фактам.

## Доказательство сопоставления

Перед INSERT link база должна проверить всю цепочку: evidence.company/connection/epoch/externalChat → conversation → message с тем же providerMessageId. Совпадения только providerMessageId недостаточно: в fixture этот ID повторяется в двух чатах одного connection/epoch, в другой компании, подключении и эпохе. NULL externalChat в этой первой реализации остаётся unmatched; нельзя угадывать чат по единственному текущему кандидату. Расширение на account-global ID или явное operation/attempt proof требует проверенной capability и отдельного теста.

`operation_id` и `attempt_id` nullable, как в v2. Указанная operation требует указанную attempt именно этой operation; attempt без operation допускается контрактом, но обязана через свою operation доказывать тот же company/connection/epoch/conversation/providerMessageId. Пара известных ID не даёт права игнорировать несовпадение provider ID. Если у операции/attempt providerMessageId ещё неизвестен, link с ними откладывается; nullable link на известное message допустим.

Ранний receipt сохраняется без internal message ID. После появления сообщения добавляется link, исходный факт не переписывается. Только после доказанного link можно построить v2 payload с обязательными conversationId/messageId; ранняя raw-строка сама по себе не является валидным `EventEnvelope` v2. Company — локальная tenancy-граница, её нет в самом EventEnvelope.

Первичный link неизменяем и требует авторитетного полного доказательства; подставлять предварительный кандидат нельзя. Исправление ошибочного link и позднее обогащение nullable operation/attempt требуют отдельного append-only resolution/retraction журнала со ссылкой на исходный link, причиной, доказательством и аудитом. Не делать UPDATE существующего link. Такой журнал и reducer его актуального решения пока не входят в минимальный тест 003; до реализации этого расширения автоматическая перепривязка и позднее обогащение отключены. Это явное ограничение минимальной версии, а не обещание готового reconciliation runtime.

## Что receipt не подтверждает

INSERT evidence/link не меняет `send_operations.state`, `coverage`, `attention_obligations.state`, не создаёт `send_coverage`. Даже read, связанный с attempt в unknown, не считается автоматически доказательством выполнения конкретного ответа и точного snapshot. Решение unknown и coverage выполняет отдельный обработчик с проверкой версии/снимка и транзакционным аудитом. Нельзя терять receipt только потому, что это решение ещё невозможно.

## Проверка реализации

`packages/database/test/evidence-postgres.test.mjs` запускается напрямую:

```powershell
node --test packages/database/test/evidence-postgres.test.mjs
```

Используются только уже принятые `DB_TEST_ALLOW=1` и `DB_TEST_URL`, без чтения `.env`. Только loopback PostgreSQL 18, роль и БД `wazzup_test`, URL без query/hash. Тест создаёт криптографически случайную schema `receipt_probe_<16hex>`, применяет существующий `domainMigrations` и удаляет только собственную schema в finally. Никаких production fixtures.

Первый RED должен быть assertion каталога об отсутствии **обеих новых таблиц**, а не ошибка подключения или `relation does not exist`. После зафиксированного RED родитель добавляет 003 и loader отдельным изменением. Затем проверяются unmatched → link, неоднозначность, scope дедупликации, read/delivered/failed вне порядка, nullable IDs, неверные доказательства, запрет UPDATE/DELETE и отсутствие auto-coverage. CI и существующие тесты этим изменением не редактируются. Синтаксическая проверка файла не является реальным PostgreSQL RED/GREEN.

Статус на 22.10.2026: 003-receipts.sql и 004-proof-guards.sql созданы; unmatched → link, дедупликация, read/delivered/failed, nullable IDs, запрет UPDATE/DELETE и отсутствие auto-coverage покрыты evidence-postgres.test.mjs. Исполнение требует DB_TEST_ALLOW=1 и DB_TEST_URL; в CI workflow этот файл не входит.
