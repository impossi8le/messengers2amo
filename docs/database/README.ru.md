# Основа миграций PostgreSQL 18

Статус: инфраструктурная часть #3; доменная схема создана и применяется — packages/database/migrations/001-core.sql (36 таблиц), 002-hardening.sql, 003-receipts.sql, 004-proof-guards.sql. Она опирается на принятые v2-контракты #2. Переноса SQLite и доступа к рабочим подключениям нет. Обновлено 22.10.2026.

## Пакет и команды

Пути: packages/database/src/migrate.mjs, test/runner.test.mjs, test/postgres.test.mjs. Node.js 24, точная зависимость pg 8.23.1 (проверена через npm registry), lockfile включён. Установка: npm --prefix packages/database ci --ignore-scripts. Unit: npm --prefix packages/database test. Реальный PostgreSQL: npm --prefix packages/database run test:integration. Изолированный backup/restore в CI: npm --prefix packages/database run test:backup.

runMigrations принимает {pool, migrations, schema}, где migrations — возрастающий список {version, name, sql}. pool предоставляет node-postgres pool.connect; один выделенный клиент используется для lock, ledger и всех транзакций. Функция возвращает {applied:[версии]}, не печатает DSN, SQL, параметры или исходные ошибки драйвера.

## Контракт исполнения

- schema — заранее созданная доверенная схема с идентификатором a-z/0-9/_ до 63 символов. Runner не создаёт её и не меняет search_path. Каждый доменный SQL-файл обязан явно квалифицировать имена таблиц либо осознанно задать SET LOCAL search_path внутри своей транзакции. Передача schema меняет область ledger, а не неявную область пользовательского SQL.
- SQL миграций — доверенный проверенный код. Только транзакционный SQL, без собственного BEGIN/COMMIT/ROLLBACK, управления advisory locks, CREATE INDEX CONCURRENTLY и иных операций вне транзакции. Runner не является SQL-песочницей и не принимает SQL от пользователя/провайдера.
- Session advisory lock один для миграционного протокола во всех схемах этого пакета. pg_try_advisory_lock при занятости немедленно возвращает MIGRATION_LOCK_BUSY; автоматического неограниченного ожидания/повтора нет.
- Ledger schema_migrations хранит номер, имя и SHA-256 точных UTF-8 байтов SQL. Применённая история должна быть неизменным префиксом локального списка. Изменение, исчезновение и перестановка применённой миграции отклоняются до новых транзакций.
- Каждая новая миграция и её запись ledger фиксируются одной транзакцией. Полная пачка не атомарна: предыдущие успешные миграции остаются после ошибки следующей. Повтор без новых файлов — no-op.
- Сбой SQL вызывает ROLLBACK. Неопределённый COMMIT возвращает MIGRATION_COMMIT_UNKNOWN, не ложный success; потенциально повреждённая/заблокированная сессия уничтожается через release(error). Перед повтором сверять ledger: запрос commit мог исполниться.
- Ошибки представлены фиксированными кодами. Исходный message/cause/параметры драйвера не возвращаются и не логируются. Ошибка unlock/release не подменяет существующую безопасную ошибку сырым исключением. Runtime-логирование commit/rollback ещё предстоит связать с #25; сам ledger не заменяет доменный аудит.

Миграционная роль отделена от будущей runtime-роли. Объектам и пользователям эта библиотека не выдаёт права автоматически. Ротация секретов, публичная сеть, создание боевых БД и запуск адаптеров не входят в этот срез.

## Доказательства TDD

Реальные unit/protocol циклы до соответствующих исправлений: 9 тестов / 0 pass / 9 fail → 9/9; 11 / 9 / 2 → 11/11; 14 / 11 / 3 → 14/14. Сырой вывод сохранён локально в work/database-*-{red,green}.log, не предназначен для Git. Это работа с protocol double, не доказательство PostgreSQL.

Протокольные тесты проверяют lock до BEGIN, same-client порядок, no-op, checksum drift/missing history, rollback без success ledger, discard при ошибках rollback/lock ACK/unlock, uncertain commit, safe release и ошибки без секретного текста. Удаление вызовов транзакций/ledger или возврат сырой ошибки делает эти тесты падающими.

## Реальные PG18 integration tests: PASS в CI, локально не запускались

Отдельный test:integration не скрывает отсутствующую среду через skip. Нужны DB_TEST_ALLOW=1 и DB_TEST_URL на одноразовый локальный/CI сервис: hostname 127.0.0.1/localhost/::1, база и роль wazzup_test, без URL query/hash. Пароль для одноразового сервиса задаёт CI, в GitHub Secrets или пользовательский .env он не требуется. URL в лог не выводить.

Сервис должен быть именно PostgreSQL 18; тест проверяет server_version_num, current_database и current_user. Каждый случай создаёт отдельную случайную схему test_runner_<hex> и удаляет только её; production-подобные цели не допускаются. Тесты: migration/no-op/drift; rollback DDL без ledger-успеха; два runner с детерминированным блокирующим advisory gate и единственная запись/эффект (без случайного sleep).

Сами integration fixtures написаны после unit-реализации для независимой проверки реальной семантики; первоначальный RED на реальном PostgreSQL не заявляется. Проверка синтаксиса файла выполнена. Ошибка настройки подключения не считается TDD RED.

Для CI: postgres:18 service с healthcheck; job на runner, порт 5432, Node24, npm ci, unit и test:integration. Parent добавляет workflow и подтверждает run отдельно. Фактический foundation CI: [run39585030998](https://github.com/lenremont2/analog_whatsapp-for-amocrm/actions/runs/39585030998), commit af5141cf54fcd45cacf1793e729a10e0f2392644 — 21 unit и 3 реальных PG18 integration теста прошли.

## Изолированный backup/restore rehearsal: PASS в CI, локально не запускался

src/backup-rehearsal.mjs исполняется только при GITHUB_ACTIONS=true, DB_TEST_ALLOW=1 и DB_RESTORE_CONTAINER, равном 64-символьному hex ID одноразового сервиса из job.services.postgres.id. Script не использует DATABASE_URL и не берёт произвольные имена баз, роли, файлов или SQL из окружения. Цель фиксирована: база/роль wazzup_test. До DDL проверяется реальная identity и версия PG18.

В контейнере создаётся только схема backup_probe_<случайный hex> с синтетическими строками, ledger и constraints. pg_dump того же контейнера создаёт custom archive только этой схемы; схема удаляется, pg_restore --exit-on-error восстанавливает её, затем сравниваются строки/ledger/определения ограничений. В конце удаляется только созданная тестовая схема. Архив остаётся в /tmp одноразового контейнера до его уничтожения CI. Не считать это проверкой полного production-backup, ролей, extensions, PITR или восстановления медиа.

Процессы запускаются через argv execFile без shell; raw stderr/SQL/ошибки команды в отчёт не попадают. Скрипт сообщает только фиксированный код ошибки или JSON итог с количествами. Неопределённый/ошибочный dump не приводит к ложному успешному restore. Тесты протокола выполняются через injected command executor и не запускают Docker локально. Реальные RED: 20 / 14 / 6 → 20/20; регрессия JSON identity SELECT — 21 / 20 / 1 → 21/21. Общая локальная unit suite сейчас 21/21. Реальное выполнение подтверждено тем же foundation CI: восстановлены 2 синтетические строки, 1 запись ledger и 4 определения constraints. Это проверка изолированной синтетической схемы, не production backup.

Источники backup CLI: [pg_dump18](https://www.postgresql.org/docs/18/app-pgdump.html), [pg_restore18](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Что остаётся для #3

Доменная схема и её constraints созданы: 001-core.sql (36 таблиц), 002-hardening.sql, 003-receipts.sql, 004-proof-guards.sql. Остаются миграции данных, атомарность inbox/message/audit/outbox, scope ключей, конкурентные транзакции и backup/restore rehearsal в изолированном окружении. pg_dump/pg_restore изолированной синтетической схемы прошли в CI; восстановление полной production-базы, ролей, расширений, S3 и PITR не проверялось. #3 не закрывать по unit 14/14.

Источники: [node-postgres transactions](https://node-postgres.com/features/transactions), [pool clients](https://node-postgres.com/apis/pool), [PG18 advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS), [GitHub PostgreSQL service](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers).
