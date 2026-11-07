# Передача Codex -> Claude, 07.11.2026

Статус: WIP. Публикация доступных локальных веток выполнена. Третий круг сведения на этом Mac не найден и не объявляется сохранённым или проверенным.

Владелец поручил передать сведение Claude. После публикации этой передачи Codex не меняет файлы кассы для Windows до завершения сведения Claude. `claude/project-thread-gwxhwx` не сливалась и не изменялась. Рабочие службы, VPS, Windows, базы, магазины и цены в этой задаче не менялись.

## Что удалось сохранить

- 158 локальных веток, отсутствовавших на origin по имени, опубликованы обычным атомарным push. Все 158 удалённых SHA повторно сверены с локальными после push, расхождений нет. Полный список ниже.
- `codex/handover-1107` уже опубликована: `f4b476c30abd06c037f58d03877a6c5c29c0169a`; повторная сверка подтвердила тот же SHA.
- Исходная `codex/cutover-1119` на этом Mac и на origin была `2ee4bdab9dad4578edc762f8cdf4f0ca33f709a5`. В этой передаче поверх неё добавлен только настоящий файл с WIP-коммитом. Это не коммит реализации третьего круга.
- Прочитаны рабочие копии основного репозитория. Незакоммиченных изменений номера кассы, сведения бэк-офиса или проверки оплаченного дня в них не найдено. Несвязанные незакоммиченные изменения других задач оставлены на месте.
- `pos-1107/claude-branch-for-codex.md` и отдельный файл 1107 со списком семи веток не найдены ни в доступных рабочих папках, ни в полученных Git-ветках. Вопрос о другом Mac/папке задан владельцу. Имена этих семи веток нельзя достоверно восстановить из текущего контекста; все найденные отсутствовавшие ветки опубликованы независимо от этого списка.
- Архив `Claude outputs/pickchick-cutover-1106b.bundle` проверен по refs: он содержит ту же базу `2ee4bdab` и четыре полосы pos/kds/client/cloud, а не третий круг. Архивы и другие пользовательские файлы в коммит не добавлены.

## Основные ветки

Для веток, содержащих сам этот документ, ссылка «HEAD» ведёт на актуальный последний коммит. Полный SHA собственного коммита невозможно записать в его содержимое без изменения SHA; точный проверенный код до документа указан отдельно.

| Ветка | Последний коммит | Статус | Что передаётся |
| --- | --- | --- | --- |
| `codex/cutover-1119` | [HEAD](https://github.com/xaaknazar/pickchick/commits/codex/cutover-1119), исходник `2ee4bdab9dad4578edc762f8cdf4f0ca33f709a5` | WIP | База D0 и этот документ. Третий круг отсутствует на данном Mac. |
| `codex/handover-1107` | `f4b476c30abd06c037f58d03877a6c5c29c0169a` | готова | Опубликованный отчёт передачи; это готовность документа, не релиза. |
| `codex/cutover-pos` | `b25674d591e140816a5d766e63a7b5e89e54b99e` | WIP | Уже была на origin, SHA сверён; в этой задаче не сливалась. |
| `codex/cutover-kds` | `d7affabcdd24bd147347f8ff40abcba73584e42a` | WIP | Уже была на origin, SHA сверён; в этой задаче не сливалась. |
| `codex/cutover-client` | `f3a07859e85865906b1396459bccb2a3a38d3816` | WIP | Уже была на origin, SHA сверён; в этой задаче не сливалась. |
| `codex/cutover-cloud` | `43806cf412c1f1acb02c995de7f61cc1ed951e4c` | WIP | Уже была на origin, SHA сверён; в этой задаче не сливалась. |
| `codex/cutover-docs` | `f0eed4f8c73a73f36aa958eaf156589cb6ef864b` | WIP | Уже была на origin, SHA сверён; в этой задаче не сливалась. |
| `claude/project-thread-gwxhwx` | `48ede2122f41a85a5d0e0cb59fa7ad0f93ed190c` | не трогать | PR316. Сведение поверх cutover выполняет Claude; SHA сохранён. |
| `codex/cutover-handover-1107` | [HEAD](https://github.com/xaaknazar/pickchick/commits/codex/cutover-handover-1107) | готова | Вспомогательная ветка документа от shared `db3dfb1f9bdf0710f58e0780dce8d5e9ecd2c14e`; нужна для штатного резерва и передачи. Не сливать её целиком в cutover. |

## Два Windows-файла: порт и права

Сравнение выполнено по доступным точным вершинам: `cutover-1119@2ee4bdab9dad4578edc762f8cdf4f0ca33f709a5` и `claude/project-thread-gwxhwx@48ede2122f41a85a5d0e0cb59fa7ad0f93ed190c`. Это сравнение сохранённых версий, а не найденных правок третьего круга.

| Файл | Доступная версия cutover | Версия Claude | Что учесть при сведении |
| --- | --- | --- | --- |
| `infra/windows/install-native-pos-sync.ps1` | POS-sync использует `127.0.0.1:43100` в SSH LocalForward, env, Prepare и Verify. | Коммит `48ede212` переводит собственный POS-sync туннель на `127.0.0.1:43110`; проверяет, что listener принадлежит проверенной службе. `43100` остаётся fulfillment/menu/device-access. | Не переносить только одну строку порта: согласовать installer, worker, диагностику и оба теста. Старую конфигурацию 43100 Claude намеренно не переписывает автоматически. |
| `infra/windows/edge-runtime-grants.mjs` | Генератор сбрасывает и выдаёт свой набор прав; `--cloud-link` допускается. Проверки существующих прав роли перед reset на schema020+ нет. | Коммит `d2eb3081` запрещает `--cloud-link` и направляет к additive helper. Перед первым REVOKE на schema020+ проверяет ACL схемы, relations, колонок и функций; роль с существующими правами отвергается. Пустой роли разрешена первая установка; schema019 и ниже сохраняют прежнее поведение. | Сохранить отказ от сброса прав живой кассы. Проверить полное сохранение ACL, включая terminal access/presence/cloud-link. Не использовать общий reset для выдачи одного права. |

В PR316 всего 14 изменённых файлов. Помимо двух основных, перенос зависит от `infra/windows/native-pos-sync-worker.mjs`, `infra/windows/inspect-native-ssh.ps1`, `scripts/edge-runtime-grants.mjs`, тестов и эксплуатационных документов. Полный diff: `git diff 1a9472f1dc2a34b8ab4db7beb6f9c5616ed23f73 48ede2122f41a85a5d0e0cb59fa7ad0f93ed190c`. В этой задаче ни один из них не редактировался.

## Что осталось в третьем круге

1. Получить с правильного Mac/рабочей папки фактические незакоммиченные файлы третьего круга, записку `pos-1107/claude-branch-for-codex.md` и перечень семи веток из файла 1107. Их отсутствие здесь не означает, что работа не выполнена на другом компьютере.
2. Сохранить реальную реализацию номера кассы на экране и её проверку. В текущем checkpoint это не подтверждено.
3. Сохранить/завершить сведение бэк-офиса. Наличие отдельных полос не доказывает, что их интеграция закончена. Автоматического merge полос в этой задаче не было.
4. Получить или провести проверку оплаченного дня на изолированном стенде без интернета, с сохранением отчёта и точного SHA. Ни эта проверка, ни физическая Windows-приёмка в этой задаче не запускались.
5. Claude сводит свою ветку поверх фактической `codex/cutover-1119`, затем проверяет порт43110 и сохранение прав. До окончания сведения Codex не меняет Windows-кассу и её файлы.

## Проверки на момент публикации

| Проверка | Результат | Границы доказательства |
| --- | --- | --- |
| GitHub Foundation CI для исходника `2ee4bdab9dad4578edc762f8cdf4f0ca33f709a5` | 11/11 success, [run42109981303](https://github.com/xaaknazar/pickchick/actions/runs/42109981303) | API GitHub повторно прочитан 07.11; это CI базы D0, не третьего круга. |
| Windows POS package для того же SHA | success, [run42109981273](https://github.com/xaaknazar/pickchick/actions/runs/42109981273) | Сборка пакета не означает установку или физическую приёмку. |
| Проверка новых Git-объектов перед публикацией | 221 ранее недоступный через origin коммит; 263 новых blob, 259 текстовых проверены на типовые секреты | 12 совпадений - URL искусственных локальных/compose БД в `.env.example` и тестах. Закрытых ключей и типовых токенов не обнаружено. Это адресная проверка, не полный аудит безопасности. |
| Проверка публикации 158 веток | PASS: все удалённые SHA совпали с планом | No force, без удаления и без merge; локальные вершины сохранены. |
| Документ передачи | Проверены diff, таблицы и обычный дефис | Новый документ не меняет runtime; его публикация не переносит зелёную CI на ненайденную реализацию. |
| Оплаченный день без интернета, повторный запуск полного стенда, Windows/PowerShell-приёмка | NOT RUN | Новых успешных результатов нет; передать Claude. |

`project:check` получил свежие refs и обнаружил, что cutover не включает новые коммиты shared. Поэтому штатный claim для корневого файла выполнен в отдельной ветке `codex/cutover-handover-1107` от актуального shared; в cutover перенесён только коммит документа. Новый shared целиком в cutover не сливался. Общие status/roadmap и онлайн-пульт не обновлялись: здесь только передача WIP, без нового результата реализации/установки/приёмки.

## Все 158 опубликованных локальных веток

Статусы используются консервативно:

- «готова» - точный SHA уже является предком принятого общего среза; эта публикация сохраняет существующую ветку и не означает новый релиз.
- «WIP» - отдельная сохранённая работа; актуальная совместимость/приёмка здесь не подтверждены. Наличие старого готового коммита не заменяет новую проверку сведения.
- «не трогать» - кассовая/Windows/инфраструктурная линия или архивный checkpoint, сохранённые для Claude. Не продолжать правки Windows до окончания его сведения.

| Ветка | Последний коммит | Статус |
| --- | --- | --- |
| `claude/um-takeover-merge` | `cd7ffa66044b610cec630786bac11570851b86d1` | WIP |
| `codex/abay-plaza-content` | `aebd4107f9972cea133da4609870208802d8fb15` | WIP |
| `codex/almaty-peaks-loyalty` | `0eb7f033409b9a253de2c03e250c6352cccbef9d` | готова |
| `codex/android-play-1106-png-checkpoint` | `eb1e9e264e1b0b633d17e616d71eb607e94a3498` | не трогать |
| `codex/api-capacity` | `8e7f260c6896a6119971dc1fb007ff0f08b1f21f` | WIP |
| `codex/apple-business-kazakhstan` | `3fce27720efae753299f5dfa61946dd865c8f7e0` | WIP |
| `codex/auth-phone-ui` | `7e2806f0c498e6f202000117822331d62cbb24d7` | WIP |
| `codex/auth-profile-data` | `3d57ef89b64bb7a0f66e6a8781c7ccaa1912ec49` | WIP |
| `codex/auth-ui-tests` | `35ec99bb94b989a124d63009e2a9af08df6eaffc` | WIP |
| `codex/backoffice-catalog-ui` | `6dfde0402c9ba10119b3e8dac792a6aa9c16a2da` | WIP |
| `codex/backoffice-devices-r` | `32077fbbf2038980068817428a4c783839cdc6a5` | WIP |
| `codex/cashier-key-renewal` | `ccee42f1e37571655e81732332c80e89c72383ee` | WIP |
| `codex/catalog-add-drinks` | `2c6e16170416bdaeae3dea793b7d7f02a07fc1d0` | WIP |
| `codex/catalog-admin` | `a282f31a88f9e154180f7938dc7fb616ff7503a4` | WIP |
| `codex/catalog-auto-recovery` | `5ca54f0d5490f25b76cdce6b66cd9480f2904d0b` | WIP |
| `codex/catalog-drinks-backoffice-prices` | `b3140d6c731ecc5c0c232408b246bca44d97ca1a` | WIP |
| `codex/catalog-modifiers-backend` | `d8cdd785a4e34f402083f24a79dd918e8421a406` | WIP |
| `codex/catalog-price-native14` | `850c6fa5a39296f78e29ff56e2a8b8c78a7137cc` | готова |
| `codex/catalog-pricing` | `2c8d391ae8d65849ad799e653bf784f84f89d2be` | WIP |
| `codex/catalog-source-images` | `4692d1733474cd8f1437ce281d937fd5af0ccf87` | WIP |
| `codex/clang-probe-workaround` | `34440b80944d6adcafc5527f9e9c143526b49147` | WIP |
| `codex/commerce-catalog-bridge` | `9951971b19bb06d2aa43d051df0141b8a267c042` | WIP |
| `codex/commerce-core` | `a6a76a93ac53289350b2bdec234ab2058b60b791` | WIP |
| `codex/customer-identity` | `a3c03f332b8f923d504c7dffa995881a27f32862` | WIP |
| `codex/database-disconnect` | `376a3ea38346808cf79b3c374b42f63644e81e28` | WIP |
| `codex/demo-phone-account` | `383feaf842c27b8abcaf076bf63a3f5a9a1f39b9` | WIP |
| `codex/dependency-forge-release` | `947195e1acd8ce0a17477421eb7b085f9986aadd` | готова |
| `codex/director-browser-bounds` | `1a94b7607c6234ea026971de6af4181884b7e2f8` | WIP |
| `codex/director-ci-followup` | `a8a60c226764000fa14d2b8ab48f258b673a7812` | WIP |
| `codex/director-grants-compat` | `63972a81765c0c439b3fef84ffbf24f978f9cae5` | не трогать |
| `codex/director-manifest-writer` | `fcaa1f95cbf4cc44613cdde945771d7683a18fc3` | WIP |
| `codex/director-pinned-quote` | `25083984130020b43816dd30f1fd488e7a169963` | WIP |
| `codex/director-refresh-ready` | `ab77a6688a2a2de568a975a232686434e7291745` | WIP |
| `codex/edge-fulfillment` | `b7bb96265e883b22f7d037cd29bce495040fd575` | WIP |
| `codex/edge-fulfillment-http` | `c21404d100b7cbd5b38c22ca5b78099788ce06e9` | WIP |
| `codex/edge-release-migration` | `f0a227ac50b60bf604dafc23ff827473e4c914a0` | WIP |
| `codex/edge-station-eligibility` | `6d42a4a308a5e49968618c7b7ee449aef76fdcbc` | WIP |
| `codex/edge-status-docs` | `d13bd712804840798328a94c321b24efa27cc0cb` | WIP |
| `codex/expo-nested-clang-probe` | `9d95313fd552e56eabca574e9bc7c1872bd5eb90` | WIP |
| `codex/farm-garden-art` | `a500bb2e964c111936b847a043acd4a266039943` | WIP |
| `codex/farm-v3-review` | `f5676984583e3fdc82539472d7606092aeb7f7f7` | WIP |
| `codex/fidelity-events` | `5be948f817d8896719e23357f3f8b3ad4d9bb45b` | WIP |
| `codex/fidelity-profile` | `9825299c8ab26fde78330bc69c4edbaa269f36d9` | WIP |
| `codex/fulfillment-cloud-port` | `79e0c706831011e7e25726e965879286bb8074d8` | WIP |
| `codex/fulfillment-transport` | `0c4419110299b0610078f1bb8b6e0f0f74d278f6` | не трогать |
| `codex/game-card-backgrounds` | `d45cdec93c4e74e9448e66e2ec77fd760a3c7e48` | готова |
| `codex/identity-receipt-limit` | `e4e1da7d9279852badae095e094fe6b4131c6181` | WIP |
| `codex/ios-catalog-demo-tests` | `46d5c0fd753559eb1377828be0c1c835c1e6a1d6` | WIP |
| `codex/ios-manual-distribution` | `48de9b11b24b7036fcd8d1289e27fc01dc1d90ef` | WIP |
| `codex/ios-simulator-keychain` | `b3ddab2dd0691bfab7a5165e36ce46e167ef2104` | WIP |
| `codex/kaspi-mobile-checkout` | `28848749fc3d111d96d3258b5d9da5440b06e2bd` | WIP |
| `codex/kiosk-browse-offline` | `2debc001f3fd2aba58fb411936abfdce69d49b43` | готова |
| `codex/kiosk-build11-r` | `f2e34110b0e95bdd1aa7b54a6902d4b7b3a65314` | WIP |
| `codex/kiosk-guest-core` | `0e263a66822ecf0115af601b79529d79b3aef4a4` | WIP |
| `codex/kiosk-native-ui` | `b1ea4ebd84955787e136a49b31618592f4acf74a` | WIP |
| `codex/kiosk-recovery` | `bfc05c4cdf9dc6513976895702d9853582315c08` | WIP |
| `codex/kiosk-review-source` | `fbc745cd0002438b1e7677108dbb9b36d8a0400f` | WIP |
| `codex/kiosk-success-contrast` | `19e94e612b0867f3ffb8460fbffa557a288aa0d1` | WIP |
| `codex/kiosk-ui-tests` | `5d7b7623200304e051e9d52d7b1b6f12100df6ba` | WIP |
| `codex/kitchen-desktop` | `a3f38d9467ef1b41cc1d274582b64066a5422901` | WIP |
| `codex/kitchen-password-tls` | `13d8338cce621e55cdc7e2b89e1049de172734fd` | WIP |
| `codex/kitchen-station-tabs` | `1a73123be01bc4de0775bf750d997956c7d749dd` | WIP |
| `codex/lan-kitchen-client` | `f250ab73227d479f1cc9c4da61e90fce82547834` | WIP |
| `codex/launch-readiness` | `8375e4af3d5310d0ca4d7ffdd2d5a0c77f6efa64` | готова |
| `codex/local-pos-draft` | `371b6a8f06fa7aa8b615a7208b12c47236e1f91f` | не трогать |
| `codex/local-pos-operator-plan` | `3572ce9605fa84740792c7b25138187cb5dfca5e` | не трогать |
| `codex/local-pos-ui` | `e3aa21661d2089b40edcfce6a0861f60eaeeedd4` | не трогать |
| `codex/loyalty-browser` | `f75f6003ab51818bc25995ad7285b7462f9584c5` | WIP |
| `codex/loyalty-card-background` | `44aa8cf102486e299d53c0afb32c352865eb6b88` | WIP |
| `codex/loyalty-core` | `8497e06c55fc36fb9313cd69d66dc067b73eaae6` | WIP |
| `codex/loyalty-mountain-art` | `f758d41f7772cf121a8ebffcdac2442f0739b41b` | WIP |
| `codex/market-capacity` | `e321470834ca5dae2e3006d4e061535e052a9496` | WIP |
| `codex/market-release` | `83c8ae2b8cf3129f3bc72bbe9cf8b471f65ba97c` | WIP |
| `codex/menu-recovery-browser` | `a7e6211107e3d0831dd777e86b1e73a16e0a638c` | WIP |
| `codex/mobile-beta-instructions` | `24160a98d1ea20410e5a4a08918b5051e9d3e176` | WIP |
| `codex/mobile-catalog-recovery` | `ef3ff72d9ac2f2d9ec73877d51ee8a94312322e6` | WIP |
| `codex/mobile-catalog-ui-tests` | `f5866cc11f7939513d1decfbe96104c4cdcda53a` | WIP |
| `codex/mobile-complete-deploy-evidence` | `8c6e3a30684106f9db1c4864c8d3c471e7621078` | WIP |
| `codex/mobile-dev-config` | `242b133734540d47e107bfdbbde012b9719eb852` | WIP |
| `codex/mobile-glass-colors-1013` | `1d1414339e4b8c4b87de545d47e753b7ffb2b233` | готова |
| `codex/mobile-order-recovery` | `a273eb8c987a1895b5fc3b93720c3ba1a82e1e93` | WIP |
| `codex/mobile-testflight28-evidence` | `6c6fec0f77828e45f5c55bc4ea26b19b627504bc` | готова |
| `codex/mobizon-delivery-adapter` | `51ad5258b8cf35e662aa0bc1005a6d97ac1e71e4` | WIP |
| `codex/mockup-kiosk` | `6f258eb5ff7336812db0ec5ea3262ed22f3a7b0f` | WIP |
| `codex/mockup-operations` | `cadba6e3dfbc436eeb9417f7b7b55d80ce145b5c` | WIP |
| `codex/native-auth-input` | `ec2df749c0e397451fb83f4f685ec3f3012b2501` | WIP |
| `codex/native-cancel-input` | `3ec42b57de744826392816e5604ca714a89597b8` | WIP |
| `codex/native-cancel-recovery` | `76e043fee1a8283326870acaff4f7252bcbba5a4` | WIP |
| `codex/native-category-diagnostic` | `a477d723b9532a0bc0984607e5608ec8eb895399` | WIP |
| `codex/native-final-verification` | `90965a26bbc8c5c0bdbc5f8254a9ed806202c7a4` | WIP |
| `codex/native-mobile-screens` | `6da2885162b3cccbfdaa7f5c43a89f7fc8e33ccc` | WIP |
| `codex/native-verification-evidence` | `7333f88f7acb10077dcd4767e49e010403a9edfe` | WIP |
| `codex/operations-connected` | `244e3de047b329f3921ddd0bd16c0a53bfafad38` | WIP |
| `codex/operations-display` | `6cc53ce8a25485e8d1f90ddce1a0ac26d444435d` | WIP |
| `codex/operations-display-tests` | `24f7b7b072f6fcf3cbb066c0966ee04d24b894eb` | WIP |
| `codex/ops-alerts` | `62e2e5e2306201a199a9b5e53f781dbedf15bdd7` | WIP |
| `codex/order-status-native15` | `35b92ec3dad8c3175a0defa27ff92030b1a50968` | готова |
| `codex/permanent-test-access-tests` | `44fa7a7bc50a44d3517b75338e934638faba82f8` | WIP |
| `codex/pick-blocks-browser` | `4131a7821c6c54805563513f0ac354a6f087557f` | WIP |
| `codex/pick-blocks-controller` | `fc5df0f01c4566aacdfb5ad28d704cb92cb216d2` | WIP |
| `codex/pick-blocks-engine` | `7233e6408587751c9d430b48dc728c0701ea2810` | WIP |
| `codex/pickchick-testflight-prep` | `47879552f62d592f27a1466395a684e2e70f3475` | WIP |
| `codex/pos-cashier-ui` | `54ffd417d249e8ab0851ad050c1c334f8e8c16fd` | не трогать |
| `codex/pos-cashier-upgrade` | `907cdd7d6f4e2e3edd3c2272493185e1b3e59b6a` | не трогать |
| `codex/pos-catalog-upgrade` | `3323961d81f0fb453be0a4b5f497f7b97ccf0b52` | не трогать |
| `codex/pos-kitchen-cloud-sync` | `1b0e9ae7520514c1a1d70d6a2b6b923e2b9bc19b` | не трогать |
| `codex/pos-password-fulfillment` | `8c275c00f3ca6119d04160d3a6ab0d954357ddf8` | не трогать |
| `codex/pos-pilot-release` | `f921ea6fcdd07d62e2a0d11b9e0c9189e04ab1da` | не трогать |
| `codex/pos-shifts-modifiers` | `9ca7a87122d957a9b4cbfb87e359e477c9999467` | не трогать |
| `codex/pos-unpaid-kitchen` | `a1be6afafa9490089fab9a904ba5072f85d8a8b5` | не трогать |
| `codex/public-bundle-permissions` | `e266620a3105265cd99a99f35d9f459dd8b0e340` | WIP |
| `codex/roadmap-deploy` | `43f6b1c8aec325cfff28bdd7d9f273a025b8f87f` | WIP |
| `codex/roadmap-ui` | `48678d5521f6e7078f8fe9c852e94748be98bc1d` | WIP |
| `codex/rollback-api-compatibility` | `fd7087a3397985e7c3e76cff99714fb4326f0b35` | WIP |
| `codex/runtime-transfer-portal` | `c7c37673c9eec6924a1ae292d1f5e7e1d130dd13` | WIP |
| `codex/source-ui-polish` | `493b83dde3e950665a26cb8207c755a35fbf64db` | WIP |
| `codex/staff-password-login` | `c279b564530da510693674e4dd7188767603123a` | WIP |
| `codex/staging-catalog-smoke` | `ef0633c7d17f10d8cf2ff284dca521c84be847cf` | WIP |
| `codex/staging-grants-rollback` | `0801f09cb774a1b67c2dfa2beffb0155c72d4b90` | не трогать |
| `codex/staging-order-flow` | `fadd97a3528afe9c3ca0f3978bb4b9f0a42c4c4d` | WIP |
| `codex/system-audit-2026-10-08` | `3801c3f05d2d7a985636ff01ca0d6efa86acf98f` | WIP |
| `codex/test-session-continuation` | `c049a633eb07dfea5085f4bdc71dfa71fc7a6909` | WIP |
| `codex/tiptoppay-native13` | `86fa1cd945bed3c795bdc33ea152d70b67397c60` | WIP |
| `codex/transport-capacity` | `4050a4d488deb7d94049ebbd70dd71876af97f43` | не трогать |
| `codex/transport-maintenance-permissions` | `a963cde642eaa251fd33b321e2009d49a9fe21ef` | не трогать |
| `codex/transport-release` | `fa93719dcb2fbca09db8b82b5fc8c6639ad776f8` | не трогать |
| `codex/web-video-lifecycle` | `668ebc352626faa6d6571e6443c721afae0a80e8` | WIP |
| `codex/windows-asar-verifier` | `28d50be30a7a2be9120aa2a517ef1df0e69cd535` | не трогать |
| `codex/windows-edge-tools` | `5ab19da9764e036fccf984458573d6915b0b3526` | не трогать |
| `codex/windows-native-backup` | `0ae38241438dc7a53036218b4ab2fad969f6f6a2` | не трогать |
| `codex/windows-native-stage1` | `3e831c188ae8138988d7cc79f076951964a19a12` | не трогать |
| `codex/windows-native-state-fix` | `eeca7e5f5ade064391f07103cb1a00773f0abb07` | не трогать |
| `codex/windows-pos-desktop` | `12582c408a1f9719929b924d135d7be5d28d33a1` | не трогать |
| `codex/windows-pos-sync-services` | `2d78bb63225cfe4dd5f7bbe48385b36ff0fc8045` | не трогать |
| `codex/windows-pos-tests` | `075c0bd1aa9d095db3bf6887a6e2b17591ef1557` | не трогать |
| `codex/windows-release-evidence` | `654420781754a5d944db440c466d53b972633200` | не трогать |
| `codex/windows-service-upgrade` | `4b02060fe0db959270cf9747e53359efac6c40c3` | не трогать |
| `codex/windows-staff-acl` | `4103db2bd9df70984400fab7ed2d675cb883a23e` | не трогать |
| `codex/windows-stage1-recovery` | `f9dac8db633d466b2ffab60e8518bb383d92a9b3` | не трогать |
| `kiosk-design-i18n-r2` | `b5ec0d80ca295da878316b5b5998646af0f367ca` | готова |
| `wf-chrome-r2` | `a927f35df11c3de2cb42cbd69fa73238969dc21b` | готова |
| `wf1810-kiosk-build11` | `d9a049d4c77a15d1494dc7d2cf83fcda1fc5a5aa` | WIP |
| `wf3-kiosk-design-checkout` | `d0fab50f2cf11e7abd89a6cd832cb2a63fbe7a3c` | готова |
| `worktree-wf_1810f4dd-4d9-1` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_a01169d4-ec3-1` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_a01169d4-ec3-2` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_ad364942-d41-1` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_ad364942-d41-2` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_ad364942-d41-3` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_ad364942-d41-4` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_cabe714e-78b-1` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_cabe714e-78b-2` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_cabe714e-78b-3` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_cabe714e-78b-4` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_fe57029d-21a-1` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_fe57029d-21a-2` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_fe57029d-21a-3` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |
| `worktree-wf_fe57029d-21a-4` | `545eb31e0db83fa1a5c83a6b7e1c0ef3de6859d4` | WIP |

Все SHA в этой таблице сверены после push. Уже существующие ветки с отличающимися локальной и удалённой вершинами не перезаписывались. После публикации вспомогательной ветки и cutover следует ещё раз сверить отсутствие локальных веток без origin и сохранить результат в передаче задачи.
