# CR kds-9 → integration: команда `kds-switch provision` для входа `kitchen`, заведённого после 027

Полоса: kds (ветка `codex/cutover-kds`). Адресат: integration (мастер-runbook `docs/operations/cutover-2026-11-19.md`, `infra/windows/kds-upgrade-db.mjs`), копия - client.
Основание: ревью интеграции 06.11, замечания R7 (повторить выдачу станций нечем) и R12 (`kds-stations.md:93`, `:102`).

## 1. Что сделано в полосе kds

- `infra/windows/kds-switch.mjs provision --reason "<3..300>"` (owner env, как прочие команды). В одной транзакции: проверка 027 и точки (`SCHEMA_NOT_READY`, `BRANCH_MISMATCH`), блокировка настроек KDS (`NOT_PROVISIONED`, если `kds-upgrade-db apply` не создал строку `kds_settings`), затем та же идемпотентная `provisionKdsStations(client, branchId)`, что вызывает `kds-upgrade-db apply`.
  - Нет активного общего входа `kitchen` - отказ `KITCHEN_LOGIN_MISSING`, база не меняется.
  - Добавлено хоть что-то (станция KDS или право входа `kitchen` на неё) - одна строка аудита `kds_setting_changes` (`field='provisioned'`, `value` NULL, причина оператора) и следующая версия `kds_settings`; переключатель, раскладки, прежние станции, маршруты, права и заказы не меняются.
  - Повтор ничего не добавляет и ничего не пишет (`changed:false`).
  - Ответ: `{"event":"kds_provisioned","changed","stations_added","grants_added","kitchen_login","layout_enabled","settings_version"}`.
- Тест `tests/integration/kds-switch.test.mjs` «provision: a kitchen login enrolled after 027…»: 027 и станции без входа `kitchen` (как `apply` до его заведения) → `provision` отказывает `KITCHEN_LOGIN_MISSING` и `REASON_INVALID`, ничего не пишет → вход заведён → `provision` выдаёт 6 станций, одна строка аудита, `status` - доступ 6 из 6, станции, маршруты и раскладки прежние → повтор ничего не меняет. Разбор аргументов: `provision --reason` принят, `provision` без причины и с чужим флагом - `USAGE`. Весь файл: 10 из 10.
- `docs/operations/kds-stations.md`: §3 шаг 1 - когда и как запускать `provision`; §3 шаг 3 - `enable --reason "Т9 учение KDS"` (R12); §4 - `screens` 0-2 (CR kds-7, R12); §7 - строка `KITCHEN_GRANTS_MISSING` и база отката рантайма после 027 (RC-edge с `6c0cd964`; рантайм D0 на 027 - только с возвратом копии schema026, ревью R4).

## 2. Что нужно от integration

- Мастер-runbook, шаг 3 (С4): предусловие «вход `kitchen` есть до С4» остаётся; если его не было, после `kds-upgrade-db apply` - `kds-switch provision --reason "..."` и `status` (доступ входа `kitchen` 6 из 6) до первого `enable`.
- `kds-upgrade-db.mjs` не меняется: повторный `apply` по-прежнему отказывает, выдача станций после 027 - только `provision`.
