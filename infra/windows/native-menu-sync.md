# Windows menu-sync worker (unified menu)

Prepared profile, not an installation record. It adds one service,
`PickChickMenuSyncWorker`, that applies back-office menu publications to the
cashier edge: prices, photos, items, categories and the derived kitchen routing.
Nothing changes for the cashier until the worker is in `apply` mode **and** the
cloud flag `CATALOG_EDGE_PUBLICATION_ENABLED` is on for this branch.

## Components

| File                              | Role                                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-menu-sync-worker.mjs`     | Service entry. Pins origin `http://127.0.0.1:43100`, database `127.0.0.1:55433/pickchick_edge`, user `pickchick_menu_sync` with a hex64 password, the branch and the device. Loops `syncMenuOnce`: 2 s idle, backoff up to 60 s, JSON logs without tokens. |
| `menu-sync-worker-grants.mjs`     | Exact privilege list and its `has_table_privilege`/`has_column_privilege` proof.                                                                                                                                                                           |
| `menu-sync-upgrade-db.mjs`        | Guarded database phase (`inspect`/`apply`): edge migration 018 when pending, login role, grants, runtime `SELECT menu_media`.                                                                                                                              |
| `install-native-menu-sync.ps1`    | `Inspect`, `Prepare`, `Install`, `Verify`. Registers the WinSW service as LocalService, depending on `PickChickPostgres` and `PickChickFulfillmentTunnel`.                                                                                                 |
| `scripts/catalog-edge-parity.mjs` | Read-only price/item/option/routing gate before the first publication. Run it from a repository checkout; it is not part of the Windows runtime.                                                                                                           |

### Worker modes (`EDGE_MENU_SYNC_MODE` in `menu-sync.env`)

- `off` (generated default): no request to the cloud, no database access. The
  service stays running and logs `menu_sync_disabled` once.
- `report`: every pull reports the active edge menu (`active_release_id`,
  `active_version`) so the cloud fills `edge_menu_state`. Already committed ACKs
  are still sent. A delivered publication is **held**: no photo download and no
  apply. Each held release is logged once as `{"state":"held",...}`.
- `apply`: downloads and hash-checks photos, applies the publication in one
  transaction (snapshot, active menu, routing, ACK) or ACKs it `rejected` with a
  reason (`VERSION_NOT_NEWER`, `MEDIA_UNAVAILABLE`, `ROUTING_UNRESOLVED`,
  `INVALID_MENU`) while the cashier keeps its current menu. A photo is
  `MEDIA_UNAVAILABLE` after 3 permanent download failures (4xx, wrong hash, not
  WebP) or 30 transient ones (timeout, tunnel or 5xx, about 25 min with the 60 s
  backoff), so a short outage only delays the menu.

Changing the mode is an administrator edit of that single line in
`C:\ProgramData\PickChick\MenuSync\service\menu-sync.env`, then
`Restart-Service PickChickMenuSyncWorker`. Do not edit any other line; `Verify`
rejects a changed file.

### Database role `pickchick_menu_sync`

`LOGIN NOINHERIT`, no other attributes, no memberships, `CONNECT` on
`pickchick_edge` only. Privileges (nothing else, including no sequences):

- `SELECT`: `schema_migrations`, `branch_config`, `menu_snapshots`, `active_menu`,
  `menu_sync_state`, `inbox_messages`, `outbox_events`, `menu_media`,
  `menu_apply_results`, `fulfillment_config`, `fulfillment_routing`,
  `fulfillment_stations`.
- `INSERT`: `menu_snapshots`, `active_menu`, `menu_sync_state`, `inbox_messages`,
  `outbox_events`, `menu_media`, `menu_apply_results`, `fulfillment_routing`.
- `UPDATE` columns, exactly those `packages/menu-sync` writes:
  `active_menu(release_id)`, `menu_sync_state(last_sequence)`,
  `outbox_events(attempts, acknowledged_at)`,
  `fulfillment_config(active_routing_version)`, and `branch_config(singleton)`,
  which only backs the branch row lock (`FOR UPDATE`) and whose CHECK allows
  only `true`.

No access to staff, sessions, PINs, orders, quotes, cash, stops, remote stop
commands or cashier reports. Known residual: `outbox_events` is shared with POS
order events, so the role can read their payloads (it needs the table to find
its own `menu.applied` ACKs). It cannot change them.

The edge runtime (`pickchick_edge_runtime`) receives `SELECT` on `menu_media`
only, for `GET /edge/v1/media/<sha>.webp`. `applyEdgeRuntimeGrants` includes it
automatically once migration 018 is in the ledger.

## Prerequisites

1. Cloud first: the VPS runs the unified-menu API (WP-A/WP-B, cloud migration
   045 and `infra/staging/catalog-edge-grants.mjs`). An older cloud treats a
   rejected ACK as applied.
2. The edge application release that contains this code is installed as an
   immutable runtime (`scripts/build-windows-edge-runtime.py`) with edge
   migrations 001-018 (019 may be present but is not applied here). The database
   ledger must be exactly 001-017 or 001-018 of that release.
3. `PickChickPostgres`, `PickChickFulfillmentTunnel` and the fulfillment worker
   are installed and running. The menu worker reuses
   `C:\ProgramData\PickChick\FulfillmentWorker\device-identity.json`; the
   installer checks that the fulfillment worker service runs with the same
   identity file, branch and device, and the database phase checks
   `fulfillment_config.device_id`.
4. Outside rush hours. The first activation switches the cashier menu, and
   in-flight quotes then fail with `MENU_CHANGED`.

## Operator sequence (Windows cashier PC)

Use elevated x64 Windows PowerShell 5.1. Parameters are the same in every step:

```powershell
$p=@{ReleaseName='edge-<7hex>';SourceCommit='<40hex>';BranchId='<branch uuid>';DeviceId='<fulfillment device uuid>'}
```

1. **Backup.** Run the verified backup and restore rehearsal
   (`backup-native-service.mjs ... schema017`, see `native-backup.md`; name the
   schema the cashier is at, `schema018` on a re-run). The database phase
   accepts only a `pickchick-native-service-backup-v1` manifest that is complete,
   finished less than 6 hours ago and whose ledger equals the current ledger.
   The installer also checks the PostgreSQL system identifier and the dump hash.
2. **Inspect** (read-only):
   `.\install-native-menu-sync.ps1 -Mode Inspect @p -BackupManifest <run>\backup-manifest.json`.
   Expect `migrationPending:true` (ledger 017) or `false` (018), `roleExists:false`
   on a first install.
3. **Prepare** (database phase). Stop `PickChickFulfillmentWorker` and
   `PickChickEdge` (and `PickChickMenuSyncWorker` on a re-run) so the 5 s
   maintenance locks are not contended, then run
   `.\install-native-menu-sync.ps1 -Mode Prepare @p -BackupManifest <same manifest>`.
   In one transaction it applies 018 when pending, resets and grants the role,
   adds runtime `SELECT menu_media`, proves the exact privileges and that no
   existing row, sequence or other role's ACL changed. On first run it writes
   `menu-sync.env` (mode `off`) with a generated password, creates the role from
   a pre-hashed SCRAM verifier and logs in once to verify. An existing role is
   never reset; an existing role without its env file stops the run. Start
   `PickChickEdge` and `PickChickFulfillmentWorker` again and check
   `/health/ready`.
4. **Install**: `.\install-native-menu-sync.ps1 -Mode Install @p`. The service
   starts in mode `off`; its log shows `menu_sync_disabled`.
5. **Report mode.** Set `EDGE_MENU_SYNC_MODE=report`, restart the service.
   Logs show nothing (idle) or one `held` line.
   - On the VPS (read-only), the branch must have no stale publication:
     `SELECT event_id, producer_sequence, aggregate_version, attempts FROM outbox_events WHERE branch_id=$1 AND event_type='menu.published' AND acknowledged_at IS NULL;`
     must return no rows. A `held` log or a row here means an old publication
     would be applied first: stop and resolve it before continuing.
   - `SELECT device_id, active_release_id, active_version, observed_at FROM edge_menu_state WHERE branch_id=$1;`
     must show the fulfillment device and `active_version = 2` (the installed
     local menu) with a recent `observed_at`.
6. **Parity gate.** Republish the approved prices in the back-office (mobile
   only while the cloud flag is off). Export, without credentials in files:
   - the catalog: back-office `GET /v1/admin/catalog/branches/<branch>` response;
   - the edge menu: `GET http://127.0.0.1:<EDGE_PORT>/edge/v1/menu` on the PC;
   - optionally routing, as the edge owner:
     `SELECT json_build_object('routing', r.payload, 'stations', (SELECT json_agg(json_build_object('id', id, 'kind', kind)) FROM fulfillment_stations)) FROM fulfillment_config c JOIN fulfillment_routing r ON r.branch_id=c.branch_id AND r.version=c.active_routing_version;`

   Then, in a repository checkout:
   `node scripts/catalog-edge-parity.mjs --catalog catalog.json --edge edge-menu.json --routing routing.json`.
   Exit code 0 is required. Exit 1 lists `PRICE_CHANGED`, `OPTION_PRICE_CHANGED`,
   `ITEM_REMOVED`, `OPTION_REMOVED`, `GROUP_REMOVED`, `PROJECTION_FAILED` or
   `ROUTING_UNRESOLVED`. Warnings (`ITEM_ADDED`, `NAME_CHANGED`, `IMAGE_CHANGED`,
   `ROUTE_DERIVED_ON_APPLY`, ...) must be reviewed but do not block.

7. **Apply mode.** Set `EDGE_MENU_SYNC_MODE=apply`, restart. Still idle: nothing
   is published to the edge yet.
8. **Cloud flag (VPS).** Through a guarded cloud release, not
   `release-kiosk-checkout.py`: `CATALOG_EDGE_PUBLICATION_ENABLED=true` and
   `CATALOG_EDGE_PUBLICATION_BRANCH_ID=<branch>`. Publish once from the
   back-office. Expect the worker log `{"state":"applied"}`, back-office delivery
   status `applied`, and `GET /edge/v1/menu/version` on the PC showing version 3.

`-Mode Verify @p` re-checks files, ACLs, the env file and the service at any
time. Database grants are re-proved by `Inspect` (it needs a fresh backup).

## Rollback

- Stop applying: set `EDGE_MENU_SYNC_MODE=off` and restart the service. New
  publications stay pending in the cloud. Turn the cloud flag off as well.
- The applied menu, routing, photo cache and apply results are immutable rows;
  never delete them. To restore old prices, publish them again from the
  back-office.
- Removing the service: `PickChickMenuSyncWorker.exe stop` and `uninstall` from
  `C:\Program Files\PickChick\MenuSyncWorker`. The role and env file stay for
  inspection. `REVOKE`/`DROP ROLE` is a separately reviewed operator action.

## Limits

- `backup-native-service.mjs` accepts exactly the reviewed edge schemas 014-019
  (`native-edge-backup-ledger.json`). A later edge migration needs its own
  reviewed allowlist entry before a backup at that schema is possible.
- Edge migration 019 (remote stops) is applied by its own guarded helper after
  this one: [remote-stops-upgrade.md](remote-stops-upgrade.md).
- All LocalService services can read each other's env files, as for the other
  native workers; the database role is what limits this worker.
- One edge per branch: the cloud ignores edge state from another device, so a
  replacement edge needs an operator reset of `edge_menu_state` on the VPS.
- `kitchen_route` changes in the back-office only route products that have no
  route yet; existing products keep their station.
