# Доменная миграция v2: план и границы проверки

Статус: DDL создан и применяется — packages/database/migrations/001-core.sql (36 таблиц), 002-hardening.sql, 003-receipts.sql, 004-proof-guards.sql; сценарии покрыты packages/database/test/domain-postgres.test.mjs. Обновлено 22.10.2026. Target: docs/contracts/v2.ru.md и неизменные v1 DTO, повторно используемые v2. Рабочая SQLite не переносится.

## Границы

SQL миграции полностью квалифицирует все объекты через доверенный placeholder схемы; schema должна существовать. domainMigrations(schema) читает фиксированный набор migrations/001-core.sql … 004-proof-guards.sql, проверяет безопасный SQL identifier и выдаёт [{version:1,name:'core_v2',sql}, … {version:4,name:'receipt_proof_guards',sql}] (packages/database/src/domain-migrations.mjs:3-8). Не запускает адаптеры, не читает токены и не включает внешние эффекты. Runner транзакционно применяет SQL и checksum ledger.

Текстовые внутренние ID принимают непустые строки; публичный контракт не требует UUID. Каждая сущность принадлежит company scope. Все связи между сущностями защищаются составными FK с company_id, а связи диалога/сообщения/обязательства дополнительно соответствующим conversation/work-item scope. Один FK только по внешнему provider ID недопустим.

## Хранимые группы

- companies, departments, staff, staff_memberships: membership и capacity/active_count с неотрицательными CHECK и active_count <= capacity. Это примитив хранения, не реализация CAS/capacity admission из #22.
- connections: текущая binding_epoch, отдельная credentials_version, channel_mode, lifecycle state/version, capabilities JSON object, ingress/send gates, непривилегированный credential_ref. connection_identities хранит историю company+connection+epoch. Текущая epoch ссылается на identity; circular setup допускается только через deferred FK в транзакции. Изменение текущей epoch не переписывает старые разговоры.
- conversations: unique company+connection+epoch+external_chat_id, неизменяемый адресат. messages: immutable conversation/direction/provider key; внешний message ID уникален в области разговора, nullable пока неизвестен. message_versions: точная версия и JSON content, current_content_version с deferred FK на сохранённую версию. Начальное сообщение и его версия фиксируются одной транзакцией.
- work_items: canonical queued/assigned/in_progress/waiting_customer/resolved/cancelled; partial unique active work per conversation; owner/department FK в своей компании; assignment_version неотрицательна.
- attention_obligations: work-item/conversation/message/content_version, attention_seq и state. Exact composite FK версии сообщения в том же разговоре. Связь obligation ID не должна незаметно переезжать на другую версию.
- reply_snapshots + reply_snapshot_items: actor, epoch, assignment_version; элементы ссылаются на конкретные обязательства и версии того же work-item/conversation. FK не допускает добавления чужого вопроса в снимок.
- send_operations: immutable intent и адресат, snapshot nullable для controlled CRM command, actor scope, command_type, key, fingerprint, content, deadline; unique company+command_type+idempotency_key. State enum v1. coverage confirmed допустимо только при sent. unknown хранится как отдельный исход, не автоматически queued. Изменение intent после принятия отвергается; обновление состояния и provider evidence остаётся отдельным действием.
- send_attempts: уникальный attempt_no в операции, dispatch fence и результат; send_coverage: конкретная obligation/version в том же work-item/conversation. Через FK на operation state='sent' не разрешать покрытие queued/unknown. Полную доменную инвалидацию при failed delivery выполняет #5.
- inbox_events: company/connection/epoch, внутренний ID, nullable provider_event_key, payload_major=2, kind и JSON object, received/occurred, processing state; partial unique provider key в connection/epoch. Adapter сам обязан строить ключ с правильной областью (при необходимости включая kind/subevent). Исторический provenance хранится отдельно, не выводится из timestamp.
- outbox_jobs: durable intent_key, job_kind, payload, состояние, lease/fencing version. Уникальность логического намерения; уведомление не заменяет SQL строку. Правила worker/restart/unknown — #4.
- audit_events: scoped append-only намерение аудита; сырые ошибки/секреты не служат диагностическим payload. Реальный доступ, retention и redaction — последующие задачи.
- crm_accounts, crm_bindings, crm_create_intents: account scope, nullable IDs для pending/creation_unknown; bound требует реальных contact/chat IDs; creation intent с ключом и отдельным неопределённым состоянием. Никакой подстановки придуманных ID.
- media_assets: private storage reference, reservation/expiry, quarantine/ready/rejected, размер и hash; consents: purpose и channel/conversation scope. SQL не хранит байты файлов и не реализует upload security.

## TDD и что будет доказано

Статус на 22.10.2026: DDL и test/domain-postgres.test.mjs существуют; перечисленные ниже инварианты покрыты этим тестом (исполнение требует DB_TEST_ALLOW=1 и DB_TEST_URL, в CI workflow не входит).

test/domain-postgres.test.mjs сначала на реальном PG18 применяет пустой scaffold и падает на assertion отсутствующих 36 таблиц. Ошибка отсутствия подключения или синтаксиса не считается RED. Только после сохранения этого вывода создаётся DDL.

Перед DDL написаны SQL-проверки scope/FK, immutable recipients/intent, provider dedup, versions, one active WorkItem, owner/capacity bounds, snapshot membership, idempotency/confirmed coverage, inbox epoch/major, CRM creation_unknown и rollback message+version+audit+outbox. Первоначальный catalog RED не выдаётся за уже выполненные проверки всех этих инвариантов: они исполняются в domain-postgres.test.mjs после появления таблиц. Любой найденный дефект исправляется после сохранённого падающего теста; SQL lint и protocol doubles реальную БД не заменяют.

Отдельно остаются CAS admission, права, согласия/preflight, проверка snapshot subset и актуальных версий, immutable audit в рамках ролей, классификация исходов провайдера и replay/outbox handlers. Наличие таблиц не означает выполнение #4–#6/#22 и не доказывает готовность смены Wazzup.

## Дополнение из пользовательского amoCRM-ТЗ до DDL

Использован только структурный смысл требований; реальные домены аккаунта, адреса мастерских и идентификаторы пользователей в fixtures/CLI-подсказки не включаются. Исходное ТЗ не публикуется этим пакетом.

- workshops — отдельная бизнес-единица. department_id не является workshop_id. В одной company допустимы несколько мастерских и независимые отделы.
- connection_routes — versioned row company+connection → workshop_id, crm_account_id, funnel_id (строка без потери точности), default_owner_id, technical_source_id. Составной FK запрещает source из другого CRM account. default owner не подменяет assignee WorkItem.
- crm_sources описывает только technical_chat source с external_id и origin_code. Рекламное происхождение контакта/сделки не переносится в этот столбец и не перезаписывается из подключения. Отдельные CRM field updates реализуются только в задаче интеграции с whitelist; SQL-схема сама не вызывает REST API.
- channel_permissions: can_read/can_send по конкретному staff/connection, default false, company-scoped FK. Membership отдела не даёт неявный доступ к подключению.
- channel_policies: crm_projection_enabled default false, private_import_enabled default true, group_default строго deny, unknown kind всегда deny. Отсутствующая строка policy запрещает CRM-проекцию.
- channel_group_rules: PK company+connection+epoch+external_chat_id; decision allow_crm/exclude/archive_only. Один row не допускает конфликтующих allow/exclude. Display name можно менять, ключ внешней группы неизменяем. channel_crm_import_allowed(company,connection,epoch,external_chat_id,chat_kind) — стабильный SQL predicate: false без policy, false для unknown, group true только при allow_crm, exclude/archive_only false. Потребители обязаны применять его до любого контакта, сделки, binding или сообщения CRM; наличие функции не выдаётся за уже реализованный pipeline. Разрешения отправки/удаления в группах по умолчанию false и требуют отдельного действия.
- conversations получает chat_kind private/group/unknown; внешний адресат не меняется при переименовании.
- attachments — собственный индекс, а не таблица чужого плагина. Поля: company/id, message_id/conversation_id, connection_id/epoch, external_chat_id/external_message_id, amo_chat_id/amo_message_id/contact_id, s3_key, original_name, mime_type, byte_size, sha256, storage_state и archive_status. Неизвестные внешние IDs остаются NULL, не выдумываются. group_archive_only запрещает CRM IDs.
- storage_state pending/stored/verified/failed отделено от archive_status pending/index_pending/indexed/unknown/failed. indexed требует verified object, SHA/S3 key и index_ack_ref. Строка reference сама не доказывает реальное S3 или внешний ACK; подлинность проверяет адаптер.
- attachment_lead_links и conversation_leads дают M:N, с сохранением состояний active/deleted/merged и original IDs. Внешний merge не должен удалять историю; replacement IDs фиксируются отдельно, не заменяют исходные provider keys.
- archive_handoff_jobs — own durable handoff, delivery_enabled default false и contract_ref NULL до согласования интерфейса. Включение без contract_ref отклоняется. Ни прямых подключений к БД плагина, ни его таблиц/credentials в миграции нет.
- crm_entity_tombstones хранит deleted/merged наблюдения и optional replacement_external_id. Удаление/слияние CRM не каскадирует на messages, attachments, lead links или S3.
- cleanup_policies: crm_cleanup_enabled, messenger_cleanup_enabled, archive_cleanup_enabled default false; CHECK первого релиза запрещает включение. Автоматические очистители отсутствуют. Открыть их можно только отдельным согласованным изменением политики/реализации.

К обязательным 24 таблицам добавлены 12: workshops, connection_routes, channel_permissions, channel_policies, channel_group_rules, crm_sources, attachments, attachment_lead_links, archive_handoff_jobs, conversation_leads, cleanup_policies, crm_entity_tombstones. Поле s3_key и индекс принадлежат нашему хранилищу; существующий archive plugin contract остаётся UNKNOWN до проверки.

Дополнительные SQL-тесты написаны до DDL: две мастерские в одной company, неверный CRM source account, deny/read/send defaults, group allow/exclude/archive_only и rename, attachment IDs/M:N/index pending, отключённый handoff, CRM tombstone/merge без потери originals, cleanup false. Никаких внешних CRM/мессенджер/S3 операций эти тесты не делают.
