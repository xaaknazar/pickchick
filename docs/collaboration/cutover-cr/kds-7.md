# CR kds-7 → integration: две поправки контракта по факту KDS-2 и KDS-5

Полоса: kds (ветка `codex/cutover-kds`). Адресат: integration (владелец `docs/architecture/cutover-2026-11-contracts.md`, §4.1), копия - lead и client.
Основание: замечание m3 ревью полосы kds; оба отступления описаны в ADR-0016 (решения 9 и 12), но обязательный контракт не исправлен.

## 1. §5.4: `screens` в ответе `GET /edge/v1/fulfillment/layout` - 0..2, а не 1..2

Что: терминал, которого нет в раскладке (экран начальника смены, запасной моноблок, экран табло в режиме кухни), получает `enabled:true` с пустым `screens`. Требовать 1..2 значит отвечать такому терминалу ошибкой или `{enabled:false}`, и он не узнал бы, что раскладка включена (виды KDS по функции станции нужны и начальнику смены).

Поведение клиента при `screens: []`: прежний переключатель станций, виды KDS по функции выбранной станции (ADR-0016, решение 9). Реализовано: `packages/contracts/src/kds.ts` `FulfillmentLayoutSchema` (`screens: z.array(uuid).max(2)`), `apps/kitchen/src/model.ts` (`tabs`), тесты `tests/integration/kds-http.test.mjs`, `apps/kitchen/tests/kds.test.mjs`.

Точный diff контракта (§5.4, строка `GET /edge/v1/fulfillment/layout`):

```diff
-`{enabled:false}` или `{enabled:true, layoutVersion, mode, stations:[{id, function, name, kind}], screens:[stationId] /* станции этого терминала, 1..2 */}`; 404 на старом edge
+`{enabled:false}` или `{enabled:true, layoutVersion, mode, stations:[{id, function, name, kind}], screens:[stationId] /* станции этого терминала, 0..2; 0 - терминал вне раскладки */}`; 404 на старом edge
```

## 2. §1.2 KDS-5: версия PickChick Kitchen - 0.4.0, а не 0.2.0

Что: в D0 `apps/kitchen-desktop/package.json` уже `0.3.0`, а 0.2.0 выпущена раньше. Установщик не должен понижать версию, поэтому пакет с экранами KDS - `0.4.0` (коммит `8e3dc259`). В нём же исправлен пакет D0: не хватало трёх модулей экрана (`restore-review.js`, `demo.js`, `ticket-view.js`), это проверяет `apps/kitchen-desktop/tests/security.test.mjs`.

Точный diff контракта (§1.2, строка KDS-5):

```diff
-... вкладки при двух станциях на терминале (утро до 14:00); kitchen-desktop 0.2.0 (`security.mjs` ASSETS, verify-package) - к 13.11
+... вкладки при двух станциях на терминале (утро до 14:00); kitchen-desktop 0.4.0 (в D0 уже 0.3.0; `security.mjs` ASSETS, verify-package) - к 13.11
```

## 3. Совместимость

- Ни одна правка не меняет ответов установленных клиентов: `screens` есть только при `enabled:true`, а его читает только kitchen 0.4.0; версия пакета - метаданные установщика.
- Мастер-runbook и `install-kitchen-client.ps1` (client, CL-5) должны ссылаться на 0.4.0.
