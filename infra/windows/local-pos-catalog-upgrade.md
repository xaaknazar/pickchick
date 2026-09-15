# Local POS preview catalog v1 to v2

This explicit operator step enriches the installed 24-item local preview with the
owner's existing product photos and source modifiers. It preserves the original
product/variant/category UUIDs, base prices, RU labels and KK `-` placeholders.
Modifiers preserve group minimum/maximum selected quantities and each option's
price delta, maximum/default quantity and availability. IDs are deterministic per
product/group/option source key. It creates no approved menu, pricing decision or
new combo semantics. The source content remains unreviewed for sales.

The source projection is pinned to the existing `complete-catalog.ts` and original
`mobile-v2.html.txt` hashes. `build-local-pos-catalog-v2.mjs` reproducibly builds the
catalog and photo inventory only after checking both hashes. All 23 delivered
photo references use actual owner assets under `/assets/menu/`; the original shot
uses `shot.jpg`. Piko's source key `generic-drink` has no actual original image,
so Piko intentionally has no `image_url`. No other product photo is substituted.

## Preconditions and transaction

Install the reviewed runtime with the modifier/quantity contracts, migration
`010_edge_cash_shifts.sql` and its explicit runtime grants first. The CLI uses the
existing native owner env and requires local mode, loopback port 55433, exact
`pickchick_edge` database/owner, and disabled fulfillment/transport/order sync.

The existing private `.local/local-pos-draft-record.json` is preserved and must
prove the original unreviewed v1 source, checksum, branch and commissioning audit.
The database must still have that exact active immutable v1 payload with ordering
closed and no cloud/menu sync/fulfillment binding or subsequent snapshot. An
existing session, stop or quote is retained. A transaction locks the branch and
sync guards, inserts immutable v2, switches the active pointer, and writes
`local.preview_catalog_upgraded_unreviewed` audit. It never changes ordering,
staff/session credentials, stops, quotes/orders, inbox/outbox or old snapshots.

The exclusive private `.local/local-pos-catalog-upgrade-v2-record.json` starts as
`prepared_not_committed`, then records the new/previous checksums, audit UUID,
source hashes and unreviewed flags after commit. A failed or uncertain response
requires record/audit inspection. There is no automatic retry, pointer rollback,
snapshot deletion or overwrite; the old v1 record remains available.

## Delivery and Windows command

Copy the ZIP's files to their matching `scripts` and `infra/windows` paths in the
new private operator runtime copy. Keep the original `.local` preview record and
protected owner env. The desktop installer separately packages the 23 photo
files listed in `local-pos-photo-inventory-v2.json`, including their exact hashes.
Do not copy private credentials or database backups into the desktop package.

Prepare one JSON input in the protected operator `private` directory. Values for
the previous release and checksum come from the preserved v1 record; the new
release UUID is newly assigned for this local upgrade.

```json
{
  "format": "pickchick-local-pos-upgrade-v2",
  "confirmation": "upgrade_local_display_only",
  "branch_id": "<assigned native branch UUID>",
  "previous_release_id": "<v1 record release_id>",
  "expected_menu_checksum": "<v1 record menu_checksum>",
  "release_id": "<new local v2 release UUID>"
}
```

```powershell
& $PcNode --env-file=".\private\edge-owner.env" scripts/local-pos-catalog-upgrade.mjs .\private\local-pos-catalog-upgrade-v2.json
if ($LASTEXITCODE -ne 0) { throw 'Inspect the private upgrade record and database audit; do not retry automatically' }
```

Expect 24 products, 23 image URLs and 31 modifier groups, with ordering and
content approval still false. Refresh the POS menu after installing the matching
desktop/runtime. Financial acceptance, bank/KKM, inventory and cloud registration
remain independent work; no payment is enabled by this menu upgrade.

## Validation

Three focused tests compare source modifiers/defaults/availability, stable v1
identities and all photo hashes; `priceCart` prices every source default selection
and repeated add-on quantities, rejecting duplicates/excess quantities. A fresh
isolated PostgreSQL 18.6 test verifies atomic rollback, rejection of open ordering
and sync state, v1 retention and unchanged staff/session/stop/quote rows after v2.
The integration suite has no default database URL and was not run against the
shared Mac development database. Physical Windows catalog upgrade remains a
separate operator step.
