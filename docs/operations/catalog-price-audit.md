# Исправление dependency audit для catalog pilot - 6 октября 2026

Основа: release candidate `178e4ab54b968cd98031d8f263e12eb8522d55c7`.
CI `37429267604` прошла функциональные проверки, но заблокировала выпуск
на этапе dependency audit. Исправление не меняет audit, CI, исключения или
политики установки. Полная CI и повторная нативная архивация - у root.

Точечные transitive overrides и lock:

| Пакет         | Прежняя версия | Исправленная | Источник                                                                 |
| ------------- | -------------- | ------------ | ------------------------------------------------------------------------ |
| source-map-js | 1.2.1          | 1.2.2        | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| proxy-addr    | 2.0.7          | 2.0.8        | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| compression   | 1.8.1          | 1.8.2        | [GHSA-vc2v-76pw-4v95](https://github.com/advisories/GHSA-vc2v-76pw-4v95) |

npm registry подтвердил публикацию 1.2.2 30 сентября, 2.0.8 15 сентября,
1.8.2 11 сентября. Первая правка ограничивает offsets indexed source maps,
вторая исправляет доверенные IPv4-mapped IPv6 подсети, третья освобождает
zlib stream при преждевременном закрытии HTTP response. У compression добавилась
зависимость `destroy:1.2.0`, уже присутствовавшая в lock. Других обновлений нет.

Локальные проверки:

- `pnpm install --frozen-lockfile` - прошла на pnpm 11.19.0, Node 24.16.0.
- Штатный `scripts/dependency-audit.mjs` - high/critical gate прошёл;
  существующие node-forge/braces patches прошли executable validation.
  Остались 4 moderate; новых исключений не добавлялось.
- 5 тестов `braces-security.test.mjs` и `node-forge-patch.test.mjs` - прошли.
- Исполняемый smoke обновлённых пакетов: огромный source-map offset отклонён,
  обычный mapping работает; короткая mapped trust subnet не доверяет внешнему
  IPv4, корректная /104 доверяет внутреннему; gzip round-trip и освобождение
  stream после клиентского abort прошли.
- Prettier обоих YAML и staged diff check - прошли.

На этом Mac системный pnpm 11.25 не соответствует engine проекта; использован
`corepack pnpm` 11.19.0. Штатный audit запускает дочерний `pnpm`, поэтому для
него PATH временно указывал на локальный wrapper `exec corepack pnpm "$@"`.
Wrapper находится в `/tmp`, не входит в проект; проверка audit не менялась.
