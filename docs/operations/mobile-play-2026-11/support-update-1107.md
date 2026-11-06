# П6 - обновление существующей страницы поддержки

Владелец разрешил продолжить П6 и отдельно передал этой задаче установщик,
его проверки и `@vps/public-https/support`. Анкета Google остаётся в Android-чате.
Казахский текст страницы принят владельцем; политика отдельно не утверждена.

## Область

У `support-page-release.py` добавлены явные режимы `--update-existing` и
`--rollback-update`. Прежняя первая установка и её запреты не ослаблены.
Новый режим меняет только четыре support-файла и их записи в `.release.json`.
Остальные 174 файла, байты Caddy, public/API pointers и все контейнеры должны
сохраниться. Никакого Docker recreate, reload, SQL, смены флагов или политики.

Живой baseline проверен только чтением:

- API: `6630eb0f676350341806b735b6877a36f017c673`.
- Public: `c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da`.
- Gateway SHA-256: `c603c640458f791ad0c19430ab3fd1e344dcc9f1448fbf99357524368e5fa520`.
- Manifest SHA-256: `0513cac15a172f0292862e41acc9dcb17569a42c5b26e45ed20fa833f1b16c05`.
- Manifest: 178 файлов; support - ru.html, kk.html, en.html, style.css.
- Чужой release lock отсутствовал; перед применением проверить снова.

## Проверки и копия

Требуются чистый опубликованный SHA, все 11 Foundation jobs этого SHA и
проверенный manifest исходного пакета. Стандартный CI уже обнаруживает новый
`tests/operations/test_support_page_update.py`; workflow не меняется.

Оператор сверяет source/CI, API/public pins, gateway hash, manifest hash,
полный существующий support-блок, каждый файл manifest, HTTP baseline.
Внутри общего release lock повторяет проверки и сохраняет защищённую копию
support, исходный manifest и gateway в `/opt/pickchick-staging/support-updates/<SHA>/`.
Копия сверяется по хешам. На двух изолированных копиях репетируются обмен и откат.

Публикация - Linux `renameat2(RENAME_EXCHANGE)` целого каталога support на том
же filesystem, затем атомарная замена manifest. Неатомарного fallback нет.
Public pointer не меняется: обновление ресурсов фиксируется отдельным журналом
`result.json`, исходным SHA и хешами до/после, а не выдаётся за новый API-релиз.

## Команды

Из проверенного извлечённого пакета на VPS, с SHA его исходника и JSON-доказательством CI:

```sh
python3 infra/public-staging/support-page-release.py \
  --source-sha "$P6_SOURCE_SHA" --ci-proof "$P6_CI_PROOF" \
  --expected-api-sha 6630eb0f676350341806b735b6877a36f017c673 \
  --expected-public-sha c3a0fbeea69e3c94b4a0994f5cdee74ba98c77da \
  --expected-gateway-sha256 c603c640458f791ad0c19430ab3fd1e344dcc9f1448fbf99357524368e5fa520 \
  --expected-manifest-sha256 0513cac15a172f0292862e41acc9dcb17569a42c5b26e45ed20fa833f1b16c05 \
  --update-existing
```

После PASS повторить ту же команду с `--apply`. Любой drift - STOP, новые
пины автоматически не принимать. Контакт подставляется только из действующей
публичной политики, в Git и выводе оператора номера нет.

Проверки после: все public assets по manifest, старые API/roadmap/legal ответы,
health/readiness, `#delete-account` и точный текст RU/KK/EN, `/support/` = RU,
все контейнеры и конфигурация Caddy неизменны. Затем внешние GET с Mac и наблюдение.

## Откат

Ошибка проверки после обмена вызывает обратный атомарный обмен и восстановление
точных исходных байтов manifest. При чужом изменении отказ от перезаписи.
При любой неопределённости собственный lock остаётся для разбора.

После успешного выпуска: та же команда с `--rollback-update` вместо
`--update-existing` и `--expected-manifest-sha256` из `manifest_after_sha256`
журнала этого выпуска. Сначала без `--apply`, затем с ним. Откат отказывает,
если manifest, gateway, pointers или файлы изменились после П6. Он проверяет
копию, восстановленные хеши и HTTP. Рабочая БД и заказы не затрагиваются.

## Состояние

Локальные проверки и CI записываются в журнал П6. Подготовленный код и read-only
baseline не означают публикацию. Политика и магазины этим оператором не меняются.
