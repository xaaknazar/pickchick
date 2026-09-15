# Explicit local POS service without payment

Migration 012 supports an owner-authorized operational mode for the cashier and
local kitchen. It does not implement or confirm a bank payment, fiscal receipt,
cash receipt, inventory write-off or loyalty award. Commercial order state stays
`awaiting_payment`; payment/fiscal states stay `not_started`/`not_requested`.
The POS shows the separately owned kitchen status as the operational status.

Install migrations, the restricted runtime grants with `--fulfillment`, the
reviewed menu, active manager/kitchen identities and the host's fulfillment
configuration first. Prepare a private JSON file with these exact fields:

```json
{
  "format": "pickchick-local-pos-service-v1",
  "confirmation": "owner_authorized_unpaid_service",
  "branch_id": "<installed branch UUID>",
  "menu_release_id": "<current reviewed local menu UUID>",
  "operator_staff_id": "<existing active shift_manager UUID>",
  "expected_ordering_version": 1,
  "fulfillment": {
    "organizationId": "<organization UUID>",
    "branchId": "<same installed branch UUID>",
    "deviceId": "<installed edge device UUID>",
    "producerId": "<bound cloud producer UUID>",
    "stations": [
      { "id": "<prep UUID>", "kind": "prep", "name": "Приготовление" },
      { "id": "<assembly UUID>", "kind": "assembly", "name": "Сборка и выдача" }
    ],
    "routing": {
      "version": 1,
      "assemblyStationId": "<assembly UUID>",
      "routes": [
        { "productId": "<actual menu product UUID>", "stationId": "<prep UUID>", "kind": "prep" }
      ]
    }
  },
  "station_grants": [
    { "staff_id": "<existing active kitchen UUID>", "station_id": "<prep UUID>" },
    { "staff_id": "<same kitchen UUID>", "station_id": "<assembly UUID>" }
  ]
}
```

Replace placeholders with reviewed bindings, use the current closed ordering
version, and provide an explicit route for every menu product. Drinks or packed
items can route to assembly with `kind: "assembly_item"`. Each station needs an
assigned kitchen employee. The same employee can switch between both stations.
The file contains no password or session token; the CLI nevertheless requires a
private directory/file using the existing Unix or Windows NTFS checks.

From the new operator release, use the existing protected owner environment:

```powershell
& '<existing node.exe>' --env-file='<private owner.env>' scripts/local-pos-service.mjs prepare '<private setup.json>'
& '<existing node.exe>' --env-file='<private owner.env>' scripts/local-pos-service.mjs enable '<same private setup.json>'
```

The CLI requires `APP_ENV=local`, the installed branch and the dedicated owner
connection at `127.0.0.1:55433/pickchick_edge`. The explicit enable invocation also
requires `EDGE_FULFILLMENT_ENABLED=true` in its host configuration. The running
service must separately use that flag, the same `EDGE_DEVICE_ID`, and the kitchen
runtime grants. These commands do not edit environment files, create passwords,
publish a menu, configure network access or start/restart services.

`prepare` is atomic: it validates the active menu, identities and route coverage,
creates stations/routing/grants plus a hashed preparation record and audit, and
leaves ordering closed in `payment_required` mode. `enable` requires the same file
and unchanged binding, then explicitly changes mode to `unpaid_service` and opens
ordering. Replays do not duplicate configuration/audit. After a later closure or
configuration change, replay refuses to reopen ordering automatically. This is a
bounded first-activation tool; subsequent reconfiguration needs separate review.

The cashier still opens its own shift and obtains a server quote. It submits
`POST /edge/v1/orders` with `{quote_id, kitchen_admission: "unpaid"}` and its durable
idempotency key. The order, kitchen number, tasks, audit and both outboxes commit
together. A missing route, disabled mode/host or closed shift creates no partial
order. Retry the exact same command after an unknown response, then read the order
to refresh its current kitchen status. The saved original command result is stable.

Cancellation is atomic only while every task remains queued. Once preparation
starts, the cashier receives `ORDER_IN_PRODUCTION`; the kitchen continues and no
false cancellation is recorded. Preparation, assembly and handoff use existing
station grants and optimistic versions. Cloud-origin admission/release and its
worker reject local-origin orders; a separate observational sync consumes their
fulfillment events. This local module alone does not deploy that cloud sync.

Portable and real PostgreSQL tests cover atomic admission/replay, HTTP kitchen to
handoff, modifier quantities, cancellation/start concurrency, injected rollback,
legacy migration preservation, restricted runtime LOGIN and prepare/enable guards.
Actual Windows rollout, password entry, TLS, two-device and WAN-loss acceptance
remain separate installation checks.
