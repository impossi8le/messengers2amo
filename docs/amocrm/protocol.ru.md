# Подпись протокола amoCRM Chats

Ограниченный исполняемый срез задачи #10: packages/amocrm-protocol, только встроенные модули Node.js 24. Пакет не выполняет HTTP, не регистрирует OAuth/Chats, не читает окружение или файлы, не получает секреты и ничего не логирует. Вся #10 и подключение рабочего аккаунта этим не завершены.

## Команды

    npm --prefix packages/amocrm-protocol ci --ignore-scripts
    npm --prefix packages/amocrm-protocol test

Runtime/dev-зависимостей нет. Exports: signChatsRequest(options) и verifyChatsWebhook(options).

## Наш backend → Chats API

signChatsRequest принимает method, urlPath, date, rawBody, channelSecret; optional contentType допускает только application/json. Возвращает заголовки Date, Content-Type, Content-MD5, X-Signature. Тело, секрет и canonical string не возвращаются.

    checksum = lowercase_hex(MD5(raw_body_bytes))
    canonical = UPPERCASE_METHOD + LF + checksum + LF + application/json + LF + Date + LF + URL_PATH_WITHOUT_QUERY
    X-Signature = lowercase_hex(HMAC-SHA1(channel_secret, canonical))

Content-MD5 — hex, не base64. Caller сериализует JSON один раз до вызова и передает rawBody как Buffer/Uint8Array; будущий HTTP-клиент обязан отправить те же байты. После подписи не менять тело и не сериализовать JSON заново. Пробелы, newline и бинарные байты входят в MD5 без преобразования UTF-8 туда-обратно. Uint8Array учитывается в границах view, без лишних байтов backing buffer; исходный массив не меняется.

Метод нормализуется в верхний регистр; допустимы GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Это возможность вычисления подписи, не утверждение доступности метода на конкретном endpoint. GET использует пустое тело: rawBody может отсутствовать, непустое значение отклоняется. Для остальных методов byte array обязателен; явное пустое тело передается Buffer.alloc(0).

urlPath — уже закодированный относительный путь с одиночным начальным slash. Полный URL, fragment, backslash, whitespace/control characters отвергаются. Query удаляется из canonical path; percent-encoding не декодируется. Функция не строит URL: caller должен передать фактический pathname транспорта, проверить ожидаемый host/scope и использовать TLS. По протоколу query не подписан, поэтому это не подпись всех параметров HTTP-запроса.

Date передается явно в строгом UTC-виде, который формирует Date.toUTCString(), например Wed, 21 Oct 2026 12:00:00 GMT. Проверяются календарь и weekday без trim/исправления. Это поддерживаемое RFC 2822-совместимое подмножество, не parser произвольных локалей и offset-форматов. 15-минутное окно платформы и синхронизация часов проверяются будущим HTTP-клиентом; чистая функция принимает историческую дату для воспроизводимых векторов.

Content-Type фиксирован как application/json. Другой MIME или дополнительный charset не нормализуются молча. Пакет проверяет байты, не валидность JSON и не бизнес-поля: это отдельный этап.

## Chats webhook → наш backend

verifyChatsWebhook принимает rawBody, signature и channelSecret. Здесь HMAC-SHA1 считается только от raw body. Исходящие Date/path/MD5 не добавляются; подпись исходящего запроса не подходит вместо webhook signature.

Принимается ровно 40 ASCII hex-символов; регистр hex эквивалентен. Отсутствующее/нестроковое значение, неправильная длина, не-hex, prefix sha1=, внешние пробелы/newline дают false. Заголовок не trim-ится и не усекается. После проверки формата два 20-байтовых digest сравниваются crypto.timingSafeEqual. Это постоянновременной примитив сравнения валидных digest, не обещание одинакового полного времени для любого malformed запроса.

rawBody должен быть Buffer/Uint8Array, не объект и не строка. Чужие toJSON/toString не вызываются. Пустой/неподдерживаемый ключ и неправильный тип тела дают TypeError с безопасным постоянным сообщением. channelSecret — непустая строка с точными UTF-8 байтами без trim/base64-декодирования либо непустой Uint8Array. Входные значения не включаются в ошибки. Options формирует доверенный код обычным объектом; библиотека не является sandbox для произвольных proxy/getter в разрешенных полях.

Официальный PHP-пример применяет trim, тогда как описание говорит о подписи тела. Наш вариант намеренно не использует trim-fallback. До production нужен настоящий подписанный fixture платформы, особенно с whitespace/newline. Синтетические векторы проверяют нашу строгую интерпретацию, не live interoperability.

Валидная подпись не проверяет account_id/scope/ACL и не защищает от replay. Следующий слой сверяет подписанный account с выбранным trusted scope, фиксирует inbox/dedup атомарно и только после commit подтверждает webhook; бизнес-обработка выполняется отдельно. Не рассчитывать на повторную доставку вместо durable приема.

## Векторы и TDD

Ожидаемые значения рассчитаны отдельным reference-скриптом Node crypto до реализации и сохранены литералами в тестах; код production signer не используется для получения expected. Все key/account/scope/body синтетические, не реальные секреты и не vendor fixtures.

Для test-channel-secret, POST, Date Wed, 21 Oct 2026 12:00:00 GMT, пути /v2/origin/custom/scope-test и тестового JSON с UTF-8 текстом:

| Значение | Литерал |
|---|---|
| MD5 raw JSON | 9d113919e3b4233fab1d74a844e4c7c8 |
| Outbound canonical HMAC-SHA1 | 4e09a625b5e627599cb2ffc128e3b03d666009a4 |
| Webhook raw-body HMAC-SHA1 | 5288aebcc894ebb76e644f1ef104014eebbb14b4 |

Тесты различают Date/метод/path/body, query exclusion, encoded path, signed whitespace, GET empty, invalid input, raw binary/view offsets, wrong key, равную длину неверной подписи и malformed signature. Они проверяют реальный crypto-код без моков.

До реализации были только неработающие exports. Итоговый assertion-only RED: 14 tests / 0 pass / 14 fail, затем GREEN 14/14. Первоначальный запуск npm из неверного cwd и property-access failures stubs не учитываются как окончательный RED. Полные реальные выводы сохранены локально в work/amocrm-protocol-red.log и work/amocrm-protocol-green.log; в пакет не включаются.

## Источники и оставшаяся #10

Основание — отдельная первичная проверка API от 21.10.2026. Официальные страницы: [регистрация и подпись](https://www.amocrm.ru/developers/content/chats/chat-start), [методы](https://www.amocrm.ru/developers/content/chats/chat-api-reference), [webhook](https://www.amocrm.ru/developers/content/chats/chat-webhooks).

Не реализованы HTTP/TLS client/server, OAuth refresh/revoke, установка интеграции/канала, account-scope binding, raw-body middleware limits, replay/dedup, durable inbox/ack, retries или доставка сообщений. Отзыв OAuth с HMAC-SHA256 — другой протокол и другой секрет. До live теста нужны зарегистрированный channel/scope, согласованный тестовый аккаунт и реальный подписанный fixture. Регистрации, переписка с поддержкой и принятие условий пакет не выполняет и не разрешает.
