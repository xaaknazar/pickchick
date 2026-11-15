# Кухня 0.4.5 - каталог обновлений 15.11.2026

## Статус

DEPLOYED: `kitchen-0.4.5-pos-0.5.3`, проверено 15.11 в 11:26 UTC.
По прямому поручению владельца опубликована только кухня 0.4.5 в режиме `idle`.
Оба файла кассы 0.5.3 перенесены без изменения размера и SHA-256.
Проверка кнопки на физическом моноблоке остаётся владельцу после обновления.

Пакет оператора собран из чистого опубликованного исходника
`99debacea7721a0b5e4dc4f12ab136caadb6e170`, как разрешено в задании.
Ветка протокола `codex/desktop-kitchen-045-1115` продолжает запись 0.4.4
из `fce6237046a2a284cd3aa2fb54ca8f84cdc06201` и обычным merge включает
проверенный исходник `99debace`. Код вручную не менялся; относительно этого
исходника отличаются только запись каталога и два протокола выпуска.
PR375 и ветка перехода этой задачей не менялись.

## Доказательство

- Foundation CI [43704276810](https://github.com/xaaknazar/pickchick/actions/runs/43704276810):
  точный SHA `99debace`, все 11 заданий success. Передача на VPS и публикация
  начались только после полного PASS.
- Windows Kitchen [43704275100](https://github.com/xaaknazar/pickchick/actions/runs/43704275100):
  все 3 задания success, включая Electron на экране входа, пакет и
  self-update 0.4.5 -> 0.4.6.
- Артефакт `14158310969`: ZIP 120911905 байт, SHA-256
  `e394b1663263b959ae2743a7773c7aa3a558f4e83fbee9749a06361051de6c92`.
  Digest GitHub и скачанные байты совпали.
- Установщик `PickChick-Kitchen-Setup-0.4.5-x64.exe`: 120900123 байт,
  SHA-256 `6b7d41a02d5d8f961cca1c772a5eff3fb7f4884e410d75bc8d6f00266246d3f7`.
  Совпадает с журналом сборки, проверками на Mac и VPS.
- `latest.json` исходного артефакта сохранён: `app=kitchen`, `version=0.4.5`,
  `apply=idle`. Касса также остаётся `idle`.
- Пакет `desktop-updates-99debace-1115.tar.gz`: SHA-256
  `5c04d489a6e3e5da72f85d70dacc5ad3006e69cb82f198349973d88c1174e527`,
  четыре файла оператора. Оператор не изменялся относительно выпуска 0.4.4.
- Локальный стенд `desktop-updates-published.test.mjs`: 3/3 PASS.
  Запись кассы в JSON не изменилась; форматирование и обычные дефисы проверены.
- Подготовительный каталог:
  `/opt/pickchick-staging/incoming/desktop-updates-99debace-1115`.
  SSH с проверкой host key, `pickchick-ops`, UID1000.
- Inspect до: `published_release=kitchen-0.4.4-pos-0.5.3`, блокировка отсутствует,
  маршрут и контейнер установлены, `feed_host_reaches_gateway=true`,
  план `kitchen=new`, `pos=carried`, свободно 128241 MiB.
- Проверочный publish: `status=inspected`, `validated=true`, `applied=false`.
- Apply в tmux `desktop-kitchen-045-1115`: exit0, stderr пуст. Оператор полностью
  прочитал установщики по публичному HTTPS частями, сверил хеши, проверил
  запрещённые адреса и неизменность контейнеров.
- Inspect после: `published_release=kitchen-0.4.5-pos-0.5.3`, блокировки и
  остатков неудачных выпусков нет, предыдущий выпуск сохранён.
- У кассы совпали оба файла: установщик 172279898 байт,
  SHA-256 `56ebe751915275e744b25ca2daf9ef4a1ead0ffa770c24c937c19d78682f0aa1`;
  `latest.json` 209 байт,
  SHA-256 `2b1795289e86a2d0aadb27797aaedaf9a101e10fb0d309cf6f1d117735de734b`.
- До/после совпали API `7e3120438461cbe561b01a587578060ff2cd9d3b`, публичный
  выпуск `21e95fe2dbbf8ff9abe167f8e40b6528b271fd3b` и SHA-256 шлюза
  `285423d63b91cc61ea7d1f48efdaa9fb99007502e0470b4eba4b19d203aa9128`.
  Другие сервисы, БД, платежи, устройства и магазины не менялись.

### Ответ publish

```json
{
  "action": "publish",
  "feed_release": "kitchen-0.4.5-pos-0.5.3",
  "previous_feed_release": "kitchen-0.4.4-pos-0.5.3",
  "published": { "kitchen": "0.4.5", "pos": "0.5.3" },
  "builds": {
    "kitchen": {
      "version": "0.4.5",
      "sha256": "6b7d41a02d5d8f961cca1c772a5eff3fb7f4884e410d75bc8d6f00266246d3f7"
    },
    "pos": {
      "version": "0.5.3",
      "sha256": "56ebe751915275e744b25ca2daf9ef4a1ead0ffa770c24c937c19d78682f0aa1"
    }
  },
  "status": "deployed",
  "phase": "verify",
  "journal": "/opt/pickchick-staging/desktop-updates/deployments/publish-kitchen-0.4.5-pos-0.5.3-8552e3136b6743958783ad12ea1101e1.json"
}
```

## Откат

Откат не понадобился. Предыдущий выпуск `kitchen-0.4.4-pos-0.5.3` сохранён.
Отзыв до установки - штатный `withdraw` из того же пакета:
`--package /opt/pickchick-staging/incoming/desktop-updates-99debace-1115/package
--expected-source-sha 99debacea7721a0b5e4dc4f12ab136caadb6e170
--to kitchen-0.4.4-pos-0.5.3 --expected-current kitchen-0.4.5-pos-0.5.3`,
сначала проверка без изменений, затем при отдельном решении `--apply` в tmux.
Запись каталога вернуть к отозванному выпуску и проверить снаружи.
Уже установленную кухню отзыв автоматически не понижает.

## Дальше

- [Desktop update feed check 43709114259](https://github.com/xaaknazar/pickchick/actions/runs/43709114259):
  success на коммите записи `4105d8155cc092f03fbc7b8155c162101c637168`.
  Локальный стенд и полное чтение обоих установщиков из GitHub прошли:
  версия, размер и SHA-256 совпали, запрещённые адреса отклонены, `ok=true`.
- Владелец: дождаться скачивания, закрыть и открыть кухню, проверить 0.4.5
  в заголовке и кнопку со значком полного экрана на странице входа:
  выход в оконный режим и возврат в полный экран.
- Код доступа, профиль и данные устройства не менялись. Принудительный
  перезапуск и режим `now` не применялись.
