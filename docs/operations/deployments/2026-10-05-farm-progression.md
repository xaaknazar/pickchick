# PICK FARM protocol 2 - подготовка API для TestFlight 12

5 октября 2026 проверен установленный baseline:

- API `14bbd28d25975bfa0d888a1bf5f3d733ff679434`.
- Public pointer `331d663a1002fb180334f6e8206afa7e8b553067`.
- Gateway SHA-256 `1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51`.
- API compose SHA-256 `c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2`.
- Public manifest base source `e236824b80ee315eae48c371d722f4f6459aac8c`.

`release-farm-update.py` закреплён на этих версиях. До установки требуется
полностью зелёная CI всех 11 jobs для точного опубликованного SHA.
Инструмент сохраняет immutable API image, owned maintenance/deployment lock,
CAS указателя, проверку всех 38 миграций, ACL, данных, runtime flags,
публичных файлов, кухни и банковского worker. Во время apply проверяет
зашифрованную копию через восстановление в отдельную временную БД.
Миграции, grants и provision не запускаются; live dump автоматически не восстанавливается.

Protocol 2 согласован с новым клиентом: старый клиент фермы получает требование
обновиться до изменения persistence. Коммерческие платежи не вызываются.
Одиночный игровой цикл и совместимость хранения проверены в исходном этапе;
публикация TestFlight и приёмка физического клиента выполняются отдельно.

Адресные проверки подготовки: `python3 -m unittest discover -s tests/operations
-p 'test_farm_update.py'` и `test_farm_release.py`.
## Установка подтверждена

API установлен из `f39863718f074e923ae24ffecf37d8bf36987cdf`, ветка
`codex/testflight-12`. [CI 37344732404](https://github.com/xaaknazar/pickchick/actions/runs/37344732404)
завершилась успешно: все 11 заданий для точного SHA. 12 адресных update и
20 pilot tests прошли при подготовке.

5 октября, 17:25 UTC: повторный guarded apply завершился успешно на bundled
Python 3.12.14. Первый apply остановился после успешной резервной копии и до
запуска нового API: Apple Python 3.9 не разобрал пять цифр дробной части
`observed_at` PostgreSQL. Штатный rollback с исходным owner UUID на Python 3.12
восстановил baseline, проверил данные/ACL и открыл ingress, затем новый apply
прошёл все исходные guards. Для следующих запусков использовать Python 3.12;
инварианты heartbeat не ослаблялись. Production dump не восстанавливался.

Итоговая зашифрованная копия:
`cloud-transport-20261005T172536Z-e5478f54.dump.age`, SHA-256
`7a9808b4be590eed95163d8a55b00108f0348adb18eb3475ea66a42eae83bc8d`.
Восстановление в отдельную временную БД прошло; временная БД удалена.

Подтверждены API pointer на release SHA, schema 038, FARM_ENABLED=1,
неизменность migration ledger, данных, ACL, runtime flags, immutable image,
банковского worker, публичных файлов и policy. Public pointer остался
`331d663a1002fb180334f6e8206afa7e8b553067`; gateway SHA-256 совпал с baseline.
Capabilities HTTP 200: phone_auth=true, checkout/payments/fiscal/loyalty=false.
Kitchen health HTTP 200: `b8821d5dcc8f10b7cf590c728340967a3934517a`,
edgeConnected=true. Защищённые farm GET/POST возвращают 401 без авторизации.
Ingress open, deployment lock снят, phase complete.

Полные prepared/before/backup/result/CI proofs сохранены приватно под
`.local/farm-update-release/<release SHA>`; общая память результата - этот
документ и GitHub. Токены, резервные данные и ACL-содержимое сюда не перенесены.
Реальных банковских вызовов не выполнялось.

Следующий этап - завершение обработки TestFlight 12 и приёмка одиночного цикла
на физическом устройстве, включая сообщение об обновлении для старого клиента.

