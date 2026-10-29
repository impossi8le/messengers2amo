# Задачи размещения messengers2amo

Дата: 21.10.2026. Все карточки созданы и добавлены в «Заведена» на [доске проекта](https://github.com/users/impossi8le/projects/7/views/1?filterQuery=DEP).
Родительский этап [#9](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/9) и [план #23](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/23) уточнены.

| Задача | Результат | Условия начала |
|---|---|---|
| [#27 DEP01](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/27) | Review и публикация безопасного комплекта в Git | Сейчас; без ключей, ACCESS, known_hosts, env и данных |
| [#28 DEP02](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/28) | Проверка VPS, DNS, vhost, сертификата, порта и ресурсов | Инструкция DEP01; runtime не требуется |
| [#29 DEP03](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/29) | Production-образы API/worker и Compose | #3/#4/#6/#10; параметры DEP02 |
| [#30 DEP04](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/30) | Выкладка за nginx и корректный HTTPS | DEP01–DEP03 приняты |
| [#31 DEP05](https://github.com/lenremont2/analog_whatsapp-for-amocrm/issues/31) | Мониторинг, backup/restore и rehearsal отката | DEP04; готовность проверяемых интеграций |

Наблюдение внутреннего браузера: целевой домен сообщил `ERR_CERT_COMMON_NAME_INVALID`.
Исправление и проверка SAN/SNI входят в DEP02/DEP04; проверка TLS не отключалась.

Инструкция и шаблоны подготовлены локально, в том числе в checkout `D:/wazzup/repository`.
Коммит/push, запуск VPS, изменение DNS/сертификатов и переключение каналов в рамках
этой адаптации не выполнялись. Публикация комплекта — отдельная задача DEP01.

Обновление на 22.10.2026: выкладка состоялась — `https://messengers.example.com/health/live`
и `/health/ready` отвечают `200` (`{"status":"ok"}` и `{"status":"ready"}`). Фактические
статусы карточек DEP01–DEP05 нужно сверить в issue; эта таблица их не подтверждает.
Шаблон nginx требует настоящего `nginx -t` в целевой/одноразовой среде; локальный
запуск Docker не выполнен из-за ограничения списка разрешённых команд LeanCTX.
