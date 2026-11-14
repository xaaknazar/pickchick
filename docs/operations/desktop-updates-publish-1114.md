# Касса 0.5.3 и кухня 0.4.3 - каталог обновлений 14.11.2026

## Статус

DEPLOYED: `kitchen-0.4.3-pos-0.5.3`. Явное поручение владельца от 14.11 выполнено штатным `publish`, режим обоих manifest `idle`. Установка на моноблоках ещё не подтверждена.

Исходник обеих сборок и пакета: `dec8b48cd899fe015baee17a3853affbe7eee774` (PR367). Отдельная чистая копия, исходники не менялись. `project-sync check` PASS, shared `8f2abe2dae32471fd7b0424fba1c60ede4063dc2` входит в исходник. Протокол и запись каталога публикуются отдельной веткой `codex/desktop-publish-1114` без изменения ветки перехода.

## Доказательство

- Foundation CI [43237506018](https://github.com/xaaknazar/pickchick/actions/runs/43237506018): точный SHA, 11/11 success.
- Касса [43237666441](https://github.com/xaaknazar/pickchick/actions/runs/43237666441), артефакт 13952817697: 172279898 байт, SHA-256 `56ebe751915275e744b25ca2daf9ef4a1ead0ffa770c24c937c19d78682f0aa1`.
- Кухня [43237506039](https://github.com/xaaknazar/pickchick/actions/runs/43237506039), артефакт 13953437511: 120898889 байт, SHA-256 `7dde525e77f25cece30a14a2a39ac0d7a9f65db099ada6d71bf89e6c8fa72b7c`.
- Задания Windows self-update обеих сборок success. Размеры и хеши повторно сверены с журналами сборок и скачанными файлами. SHA-256 ZIP совпал с digest GitHub; manifest без изменений, `apply: idle`.
- Пакет `/private/tmp/desktop-updates-dec8-1114.tar.gz`: SHA-256 `b80c38f0ea31c0335a948187c6e56ddcefcb07c181560f56af33a94c0148a4f0`, сверён после передачи.
- Linux Python3.12.3: 59/59 изолированных тестов `test_desktop_updates_release.py` PASS, включая процессы и сигналы. Тестовый каталог отдельно от рабочего, Docker и БД не использовались. Дополнительный Mac-прогон Python3.9 не засчитан: несовместимость HTTPError.close в тесте редиректа; стандартный временный каталог Mac также требовал явного TMPDIR=/private/tmp. Исходники тестов и оператора не менялись.
- Локальные тесты записи каталога: 3/3 PASS. Внешний published-check с Mac: ok=true, кухня скачана 29 частями, касса 42 частями; SHA-256 совпали, HTTP200/no-store, запрещённые пути и POST дают404.
- Подготовительный каталог VPS: `/opt/pickchick-staging/incoming/desktop-updates-dec8-1114/`. SSH с BatchMode и StrictHostKeyChecking, пользователь pickchick-ops UID1000.
- Inspect до: `published_release=kitchen-0.4.0-pos-0.5.0`, `deployment_lock_present=false`, `feed_host_reaches_gateway=true`, `next_step=publish`.
- Dry-run: `status=inspected`, `validated=true`, `applied=false`. Применение в tmux `desktop-publish-1114`, код выхода 0, stderr пуст.
- Оператор полностью прочитал установщики по HTTPS частями, сверил хеши, проверил запрещённые пути и неизменность всех контейнеров.
- Итоговый inspect: `published_release=kitchen-0.4.3-pos-0.5.3`, блокировка снята, остатков неудачных выпусков нет. Прежний каталог сохранён. API, публичный выпуск и хеш gateway совпали с baseline. Caddy, БД, платежи и устройства не менялись; магазины не затронуты.

### Ответ publish

```json
{
  "action": "publish",
  "feed_release": "kitchen-0.4.3-pos-0.5.3",
  "previous_feed_release": "kitchen-0.4.0-pos-0.5.0",
  "published": {
    "kitchen": "0.4.3",
    "pos": "0.5.3"
  },
  "builds": {
    "kitchen": {
      "version": "0.4.3",
      "sha256": "7dde525e77f25cece30a14a2a39ac0d7a9f65db099ada6d71bf89e6c8fa72b7c"
    },
    "pos": {
      "version": "0.5.3",
      "sha256": "56ebe751915275e744b25ca2daf9ef4a1ead0ffa770c24c937c19d78682f0aa1"
    }
  },
  "status": "deployed",
  "phase": "verify",
  "journal": "/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.3-pos-0.5.3-369ac928a45d441da4feb80e00845556.json"
}
```

## Откат

Отзыв до установки выполняется тем же проверенным пакетом: `withdraw --package /opt/pickchick-staging/incoming/desktop-updates-dec8-1114/package --expected-source-sha dec8b48cd899fe015baee17a3853affbe7eee774 --to kitchen-0.4.0-pos-0.5.0 --expected-current kitchen-0.4.3-pos-0.5.3`, сначала без `--apply`, затем с ним в tmux. Вернуть запись `desktop-updates-published.json` к прежнему каталогу и пройти внешнюю проверку. Уже установленные версии отзыв не понижает. Откат не понадобился.

## Дальше

- [Desktop update feed check43594561849](https://github.com/xaaknazar/pickchick/actions/runs/43594561849): success на коммите записи `5a00840337ad051ef9e3650b422583d0ab811f4c`. Все шаги прошли, включая полное чтение обоих установщиков модулем обновления с GitHub.
- Владелец проверяет один моноблок: после штатного перезапуска в заголовке кассы 0.5.3 или кухни 0.4.3. Факт публикации не заменяет эту приёмку.
