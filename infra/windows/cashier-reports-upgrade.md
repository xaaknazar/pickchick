# Windows cashier reports: schema015 -> 016

Prepared profile, not an installation record. The target is the existing native
cashier from [connection recovery](../../docs/operations/connection-recovery.md).
Do not reuse `update-native-order-number.ps1`: the current worker has its own
immutable runtime, independent of the Edge application, and that script's CI
allowlist predates the current pipeline.

## Scope and preservation

Keep the Edge/POS binary, environment, device identity, service account, service
recovery policy, PostgreSQL, kitchen link and tunnel unchanged. Replace only the
FulfillmentWorker application after an additive schema016 migration. POS source
triggers write immutable source snapshots; worker sends protocol3 optional
reports while ordinary transport remains protocol2. Cloud schema033 and its
restricted runtime grants must be ready first. Cloud remains authoritative for
active device/binding validation. Payment/refund totals are not replicated.

`cashier-reports-upgrade-db.mjs` is the executable database phase. It requires
existing separate restricted POS/worker roles and exact migrations001-016 from
the reviewed candidate. It locks existing tables with a five-second lock timeout,
checks the single branch and migration checksums, applies016 and grants in one
transaction, then proves that every pre-existing business row and sequence is
unchanged. Backfill creates only new outbox rows, retaining original timestamps.
A verified016 ledger resumes the grant phase without repeating the backfill.
Failures roll back the database phase, with sanitized CLI errors.

The migration introduces durable outbox growth; acknowledge is not delete. Future
retention needs a separately reviewed policy. Snapshot verification scans existing
tables under maintenance locks; stop if the protected helper's 60-second timeout
is insufficient for the real database. Do not raise it silently during service.

## Release inputs

Before service changes reserve `@windows/cashier`, verify a fresh exact-source
successful CI run with **all current required jobs**, reviewed windows-x64 runtime
ZIP manifest/file hashes, protected helper/dependency hashes and a verified
backup/restore rehearsal matching current system identifier, branch and schema015.
The candidate archive must include the new worker code and unchanged migrations
001-015. Keep a protected evidence folder outside the immutable runtime.

Read the actual Worker XML to obtain its current application root; do not derive
it from the Edge release. Record original XML/hash, service/PID state, local ready
response, edge.env/worker.env/device-identity.json hashes, owner environment hash,
POS executable/config hashes and SCM recovery configuration. Never print their
contents. Use existing NTFS ACL/reparse/verified-archive functions from the native
maintenance installers, pinned to reviewed hashes. No ZIP extraction into a live
runtime. Preserve partial stages for inspection.

## Operator sequence

1. Inspect the database with the protected local owner environment, without
   copying credentials into arguments or output. The existing foundation Node
   executes the helper. `toolsRoot` supplies protected installed `pg`; `appRoot`
   contains the reviewed candidate migration files. The executable CLI is:

   ```text
   node.exe cashier-reports-upgrade-db.mjs inspect <toolsRoot> <appRoot> <branchId>
   ```

   It accepts only local PostgreSQL127.0.0.1:55433/pickchick_edge,
   pickchick_edge_owner and the matching EDGE_BRANCH_ID. Default runtime roles
   are pickchick_edge_runtime and pickchick_fulfillment_worker; verify the actual
   worker role before apply. A different role requires a reviewed invocation of
   the exported helper rather than silently replacing privileges.

2. Extract and verify the candidate worker into a new protected immutable
   directory; prepare candidate XML retaining node, env, identity, logs and
   service settings. Recheck original hashes and all release gates immediately
   before changing services. Stop only Worker and Edge during the DB phase;
   wait for stopped state and absent listeners. Keep PostgreSQL/tunnel running.
   If local kitchen callers cannot be quiesced, stop their link temporarily and
   record that deliberate restart. No restaurant financial requests are used.

3. Run the same helper with `apply`. Store its sanitized fingerprint/result.
   A successful result has migrations16 and existingDataPreserved:true. Run
   `inspect` again. Do not run ordinary broad grant reset scripts: the helper adds
   POS outbox INSERT/sequence USAGE and the reviewed worker grant union only.

4. Start unchanged Edge and verify ready plus its original runtime command path.
   Atomically switch only Worker XML to the verified new app, start Worker and
   verify the process executable/command path and worker status. Recheck all
   preserved hashes, service recovery configuration and unrelated PIDs. Restore
   a deliberately quiesced kitchen link only after Edge is ready.

5. Observe durable outbox progress/receipts and cloud projection observations
   through read-only checks. Existing historical snapshots should arrive through
   the backfill; do not create cash movements or close/open real shifts as a
   smoke test. A running service alone does not prove replication. Record pending,
   acknowledged and quarantined event counts and a real source-backed shift
   identity on the branch-scoped director screen. Coverage remains partial;
   quarantined or unacknowledged rows require explicit investigation.

## Failure and rollback

Before the DB commit, errors roll back migration and grants. Restart original
Edge/Worker only after inspecting stopped/changed service state.

After the DB commit, **retain schema016 and its grants**. Restore only the saved
Worker XML if its current content exactly matches the candidate owned by this
upgrade, and start the old worker. Restart the unchanged Edge. Existing older
migration runner accepts additional ledger entries; checksum validation of its
known migrations is unchanged. Schema016 invoker triggers still require the new
POS INSERT/sequence privileges and worker source-trigger privileges, so never
revoke them during binary rollback. Source events remain durable for the next
forward attempt. The old worker continues core protocol2 and does not report the
new outbox. No business database restore, trigger removal or outbox deletion.

Do not overwrite a concurrent XML/environment change. Failed readiness after
rollback requires operator inspection; never declare success from Start-Service.
Full unattended PowerShell orchestration still requires rehearsal against the
actual separate-runtime layout and current release gates. This profile and its
DB helper do not grant deployment authorization or claim Windows acceptance.
