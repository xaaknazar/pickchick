# Native Windows edge setup tools

These tools prepare the dedicated edge database and protect staff credential files.
They do not install PostgreSQL, Node, Windows services or device tunnels. Use the
repository's supported Node version and build the workspace packages first.

## Database installation

Provision a separate loopback PostgreSQL database named `pickchick_edge`, an owner
connection for setup and a dedicated runtime LOGIN role. The runtime role must not
be superuser, create databases/roles, bypass RLS, replicate, inherit memberships or
own database objects. Do not grant CREATE in the application schema or relation
privileges to PUBLIC. Retain the owner credential outside the runtime environment.

Put `APP_ENV=local`, the assigned `EDGE_BRANCH_ID` and the owner
`EDGE_DATABASE_URL` in a private operator environment file. The URL must include
the user/password, a loopback host and `/pickchick_edge`, without query/hash
overrides. `local` is the currently supported edge configuration; it is not a
claim of production acceptance. No cloud or Redis variables are needed.

From the packaged repository root, run:

```powershell
node --env-file="C:\ProgramData\PickChick\private\edge-owner.env" scripts/edge-migrate.mjs
node --env-file="C:\ProgramData\PickChick\private\edge-owner.env" scripts/edge-runtime-grants.mjs pickchick_edge_runtime --fulfillment
```

The first command applies only `db/edge/migrations`, with the existing migration
ledger, checksums and transaction lock. It inserts no restaurant or demo data.
The release includes canonical cancellation migration 007 unchanged from commit
`5584542`, before 008/009. This prepares its schema without activating transport
v2 or writing release-result events. A database that already recorded 008/009
without 007 still fails the out-of-order guard; do not rewrite its ledger to bypass it.
The second requires migration 009, clears the role's previous table, sequence
and column privileges in the application schema, then installs explicit POS and
kitchen rights. Omit `--fulfillment` for POS-only rights. Reapplying with that flag
omitted removes kitchen rights. A failed validation rolls back the entire grant
change; it does not silently retain a partially applied configuration.

Migration 009 adds constrained `lock_anchor` columns for PostgreSQL row locks on
staff, terminals, sessions, fulfillment configuration, stations and grants.
Runtime can acquire the locks needed by HTTP operations without permission to
change roles, session expiry, tokens, device binding or station assignments.
Setup, menu installation, cloud admission and transport/outbox acknowledgement
are separate operations and are not granted to the staff-facing runtime.

Start edge using a separate private environment file containing the runtime URL.
For kitchen, also set `EDGE_FULFILLMENT_ENABLED=true` and the assigned
`EDGE_DEVICE_ID`; both must match trusted provisioning. Branch, menu, stations,
routing and staff provisioning remain explicit setup steps. Do not run the demo
seed on the restaurant database. These tools do not enable payment or move an
unpaid POS order onto the kitchen queue.

## Staff credential files on NTFS

`scripts/staff-setup.mjs` stores credentials in `.local` beside the packaged
`scripts` directory. Provision this folder under a trusted parent before issuing
credentials. Keep it out of installation downloads, Git and shared folders.
For a new empty folder, an operator can assign protected ACLs as follows; replace
the example path with the actual package location:

```powershell
$pcStaffDirectory = 'C:\ProgramData\PickChick\edge-tools\.local'
$pcStaffSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory -Path $pcStaffDirectory -ErrorAction Stop
icacls.exe $pcStaffDirectory /inheritance:r /grant:r "*${pcStaffSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'Private staff directory ACL setup failed' }
```

This is not an ACL reset for an existing directory: unrelated explicit grants
remain and the helper rejects them. It verifies NTFS, no reparse points, protected
directory inheritance and SID permissions restricted to the issuing account,
SYSTEM and Administrators. Inherited file permissions are accepted only beneath
that verified directory. It checks an empty temporary file before writing a token.
Unix retains real 0700/0600 checks. Ancestor-directory replacement is outside this
helper's protection, so the installation parent must also be trusted.

Staff setup still issues an eight-hour session. Renewal and operator sign-in are
separate workflows; this helper does not silently issue permanent credentials.

## Verification

```sh
node --test --test-concurrency=1 tests/unit/edge-install.test.mjs tests/unit/staff-credential.test.mjs tests/integration/edge-runtime-grants.test.mjs
```

The database tests use only a loopback development PostgreSQL and temporary
schemas/roles. They log in as the restricted role and exercise POS quote/create/
replay/cancel, ordering/stops, prep-to-handoff, actual kitchen HTTP reads/actions,
forbidden setup changes, grant reapplication and rejection of PUBLIC permissions.
ACL tests cover fixtures and actual Unix files; they do not claim that PowerShell
or NTFS execution has already passed on physical Windows hardware.
