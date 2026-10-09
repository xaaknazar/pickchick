# Windows cashier remote stops: edge schema018 -> 019

Prepared profile, not an installation record. Run it after the menu-sync database
phase ([native-menu-sync.md](native-menu-sync.md), ledger 018) and before
`EDGE_REMOTE_STOPS_ENABLED` / `FULFILLMENT_TRANSPORT_PROTOCOL=4` are switched on
([unified-menu-publication.md](../../docs/operations/unified-menu-publication.md)).

`remote-stops-upgrade-db.mjs` is the executable database phase. It ships in the
immutable edge runtime (`infra/windows/`) together with migration 019.

## What it changes

In one owner transaction, under a 5 s lock timeout and ACCESS EXCLUSIVE locks on
every edge table:

- applies `019_edge_remote_stops.sql` only when the ledger is exactly the reviewed
  001-018 of the candidate (a ledger at 019 resumes the grant phase only; any other
  ledger, a changed checksum or a second branch stops the run);
- grants exactly these privileges and nothing else:

  | Role                                              | Privileges                                                                                                                                                                                                     |
  | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `pickchick_edge_runtime` (edge service)           | `UPDATE(source)` on `local_stops`; `SELECT` and `UPDATE(state,result_version,applied_at)` on `remote_stop_commands`; `INSERT` on `local_stop_events`                                                           |
  | `pickchick_fulfillment_sync` (fulfillment worker) | `SELECT(version,source,updated_at)` on `local_stops`; `SELECT(command_id,branch_id,state,result_version,applied_at,reported_at)`, `INSERT(<command columns>)`, `UPDATE(reported_at)` on `remote_stop_commands` |

  These are the `remoteStops` deltas of `edge-runtime-grants.mjs` and
  `fulfillment-worker-grants.mjs` (pinned by unit tests) and follow the SQL in
  `packages/local-orders/src/remote-stops.ts`, `orders.ts` and
  `packages/fulfillment-transport/src/worker.ts`. The worker never writes
  `local_stops`, verdicts or stop history; the runtime never fills the inbox.

- proves, with `has_table_privilege`/`has_column_privilege`, the exact rights of
  both roles on `remote_stop_commands` and `local_stop_events`, that the worker reads
  exactly its reviewed `local_stops` columns and writes none, and that the services'
  own readiness probes pass;
- proves that no ACL entry of any other role (or of these roles outside the two new
  tables) changed, and that every existing row and sequence is unchanged
  (`local_stops.source` is new, defaults to `pos` and is checked separately).

No role is created and no password is set or read. Both roles must already exist,
without superuser/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS and without role
membership. A worker that already holds more than its reviewed `local_stops` rights
stops the run; such a grant is never revoked silently.

## Inputs

- Reserve `@windows/cashier`. Candidate runtime `edge-<7hex>` from an exact-SHA
  green CI, already installed and verified (same as the menu-sync step).
- A fresh backup: `backup-native-service.mjs` with the explicit schema argument,
  completed less than 6 hours ago and taken at the current ledger:

  ```text
  node.exe backup-native-service.mjs <toolsRoot> <pgBin> <runRoot> <branchId> schema018
  ```

  The helper re-checks the manifest, that `pickchick_edge.dump` next to it has the
  recorded size and SHA-256 and that its system identifier is this foundation's.

## Operator sequence

`<runtimeRoot>` is `C:\Program Files\PickChick\Edge\edge-<7hex>\app`, `<toolsRoot>`
is `C:\ProgramData\PickChick\EdgeTools\<foundation release>`. The foundation
`node.exe` runs the helper; credentials are read from the protected foundation
record and never appear in arguments or output.

1. **Inspect** (read-only, services keep running):

   ```text
   node.exe <runtimeRoot>\infra\windows\remote-stops-upgrade-db.mjs inspect <toolsRoot> <runtimeRoot> <branchId> <runRoot>\backup-manifest.json
   ```

   Expect `migrations:18`, `migrationPending:true`, `grantsVerified:false`.

2. **Quiesce.** Outside service hours stop `PickChickFulfillmentWorker`,
   `PickChickMenuSyncWorker`, `PickChickPosSync` (if installed) and `PickChickEdge`;
   wait for Stopped. Keep `PickChickPostgres` and the tunnels running.

3. **Apply** with the same arguments and `apply`. Expect `migrations:19`,
   `migrationApplied:true`, `grantsVerified:true`, `existingDataPreserved:true` and
   the same `fingerprint` as step 1. Store the sanitized JSON as evidence. Re-running
   `apply` is idempotent (`migrationApplied:false`).

4. **Restart** `PickChickEdge`, check `/health/ready`, then the workers. Keep
   `EDGE_REMOTE_STOPS_ENABLED=false` and `FULFILLMENT_TRANSPORT_PROTOCOL=2` until the
   release step that turns them on.

5. **Verify.** Take a new backup with `schema019` and run `inspect` with it: expect
   `migrations:19`, `migrationPending:false`, `grantsVerified:true`.

With the new edge binary, POS stops start writing `local_stop_events` as soon as the
grants exist; that does not depend on the flags. With
`EDGE_REMOTE_STOPS_ENABLED=true` the edge log must not show
`remote_stops_unavailable` (`SCHEMA_OR_GRANTS_MISSING`); with protocol 4 the worker
must not log the `fulfillment_remote_stops` state `edge_unavailable`.

## Failure and rollback

Any failure before COMMIT rolls back migration and grants; the CLI prints only
`remote_stops_upgrade_failed`. Restart the original services after checking their
state.

After COMMIT, **keep schema019 and its grants**. Older edge and worker binaries run
unchanged on it (POS stops default to `source='pos'`; protocol 2 ignores the inbox).
To stop the feature set `EDGE_REMOTE_STOPS_ENABLED=false` and
`FULFILLMENT_TRANSPORT_PROTOCOL=2` and restart. Do not delete stop commands or
history, drop the tables or restore a business backup over the live database.
`REVOKE` of these grants is a separately reviewed operator action.

This profile and its helper are tested against local PostgreSQL only; they do not
grant deployment authorization or claim Windows acceptance.
