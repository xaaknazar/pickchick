# Local POS menu preview after native installation

This optional operator step makes a fresh local cashier screen reviewable using
the owner's 24 source dishes. It is **not authoritative restaurant menu publication**.
The fixed input catalog preserves RU names, categories and base prices from
`design/reference-source/mobile-v2.html.txt`, via the existing complete-catalog
source. Both source hashes and the delivered catalog hash are recorded.
No TEST branch, organization, device, token, order or payment is copied.

The proprietor has already identified the restaurant as TC Abay Plaza, Almaty,
4th microdistrict, 10B. The new local UUID still needs its future cloud registration
and legal/catalog mapping. An internal installation code does not establish that
registration. The supplied UUID must equal `EDGE_BRANCH_ID` exactly.

## Scope and safety boundaries

- Requires a fresh migrated edge DB and the private owner connection. An existing
  branch, menu, staff or order causes rejection; no overwrite, merge or resume.
- A single transaction writes the local branch with `ordering_enabled=false`,
  the local display snapshot, an expired commissioning cashier identity/terminal
  and `local.preview_prepared_unreviewed` audit. It creates no usable session.
- No cloud connection, menu.published event, inbox, outbox, order, quote, payment,
  fiscal state, fulfillment configuration or approval flag is generated.
- An exclusive private record is created before the transaction. Preserve it if
  execution fails: the audit UUID helps distinguish rollback from a lost commit
  response. Never blindly delete the record and retry over a branch.
- The existing staff CLI separately issues an eight-hour **cashier-only** session.
  Do not grant shift_manager, open ordering or accept sales during this preview.
  This is a narrow operating constraint, not a new backend approval mechanism:
  a separately authorized shift manager could change ordering in existing code.

The current foundation menu has no draft flag, so its `active_menu` serves this
local display snapshot at version 1. Its required `published_at` field records
local preview creation time only. The private record explicitly states
`content_reviewed=false` and `cloud_published=false`. Before production menu sync,
review the binding and bootstrap/version transition; a cloud v1 publication
cannot simply overwrite this immutable local snapshot. Do not rewrite migration,
inbox or outbox ledgers to force it.

The POS still displays initials instead of images and supports base SKU prices
only. Source image asset keys remain in the review catalog but are not rendered
by this installer. Included options, paid modifiers, composition and combos are
not interpreted as purchasable SKU semantics. KK is the visible placeholder
`-`; no translation or food-content approval is invented.

## Delivery and commands

Copy only `scripts/local-pos-draft.mjs` and
`infra/windows/local-pos-draft-catalog.json` into the matching paths in the
private operator copy `C:\ProgramData\PickChick\EdgeTools\<release>`.
They use packages and staff ACL helpers already present in edge-0186902.
Do not replace the runtime service or its pinned manifest.

Save a private JSON input with these exact fields, using the reserved branch UUID,
the identified restaurant name and newly assigned commissioning staff/terminal IDs:

```json
{
  "format": "pickchick-local-pos-draft-v1",
  "confirmation": "prepare_local_display_only",
  "branch": {
    "id": "<assigned branch UUID>",
    "code": "<internal local installation code>",
    "name": "<identified restaurant name>",
    "timezone": "Asia/Almaty",
    "ordering_enabled": false
  },
  "staff": {
    "staff_id": "<new commissioning cashier UUID>",
    "terminal_id": "<new cashier terminal UUID>",
    "name": "<commissioning operator label>",
    "role": "cashier"
  },
  "release_id": "<new local display snapshot UUID>"
}
```

From that operator directory, use the pinned Node executable and the owner
environment file created by the native server setup:

```powershell
& $PcNode --env-file=".\private\edge-owner.env" scripts/local-pos-draft.mjs .\private\local-pos-draft-input.json
if ($LASTEXITCODE -ne 0) { throw 'Inspect preview record and database audit before recovery' }
$pcPreview = Get-Content -LiteralPath .\.local\local-pos-draft-record.json -Raw | ConvertFrom-Json
$pcUtf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$PWD\.local\preview-cashier-setup.json", ($pcPreview.staff_setup | ConvertTo-Json), $pcUtf8)
& $PcNode --env-file=".\private\edge-owner.env" scripts/staff-setup.mjs .\.local\preview-cashier-setup.json
if ($LASTEXITCODE -ne 0) { throw 'Private staff credential issuance failed' }
```

The session file is `.local\staff-<staff UUID>.json`. Select it in PickChick POS
without reading its token into the terminal or clipboard. Before opening the POS,
review the record's `pos_config` and apply it to the current Windows user's
`%APPDATA%\PickChickPOS\config.json`, preserving any existing configuration until
reviewed. It includes category labels and the explicit branch label
`ЧЕРНОВИК, НЕ ДЛЯ ПРОДАЖ`. Restart the app to load this label.

Expected checks: readiness 200, real cashier session, 24 menu entries, closed
ordering; no order created. Cashier attempt to open ordering returns 403, and
quote returns BRANCH_UNAVAILABLE. Staff access expires in eight hours; use the
existing `staff-setup.mjs ... --renew` only when an authorized renewal is needed.

## Validation

`node --test --test-concurrency=1 tests/integration/local-pos-draft.test.mjs`
checks the pinned source projection and a real temporary PostgreSQL schema with
restricted runtime LOGIN and HTTP. It verifies transaction rollback, rejection
of existing bindings, staff login, readiness/menu, closed ordering and absence of
financial/cloud effects. This does not substitute for Windows or restaurant
acceptance.
