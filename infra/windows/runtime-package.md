# Portable Windows edge application package

`scripts/build-windows-edge-runtime.py` builds the edge workspace packages and
creates a deterministic ZIP with compiled JavaScript, production dependencies,
edge-only migrations and explicit administration CLIs. It does not install
software, configure Windows services or create restaurant data.

Use a clean source checkout with the locked dependencies already installed:

```sh
python3 scripts/build-windows-edge-runtime.py --output /private/build-output/pickchick-edge
python3 -m unittest discover -s tests/operations -p 'test_windows_edge_runtime.py'
```

The output directory and `.zip` must not already exist. The manifest records the
source commit and every file's SHA-256. The build rejects missing dependencies,
external workspace links, symlinks in the output, native addons, Windows-invalid
names and case-insensitive collisions. Version conflicts get real nested package
directories. Neither a pnpm store nor developer `node_modules` links are shipped.
Archive timestamps and ordering are fixed, so identical inputs produce identical
bytes. Native Windows acceptance is always separate from archive verification.
Check the manifest's maximum extraction prefix length against the complete
`C:\Program Files\PickChick\Edge\<release>\app` path, including the release name;
this budget keeps the longest filename within the traditional 259-character
Windows path limit without assuming that long-path support has been enabled.

## Separate application, private setup and data

Example layout, to be checked against the actual machine before installation:

```text
C:\Program Files\PickChick\Edge\<release>\
  PickChickEdge.exe + PickChickEdge.xml    WinSW and reviewed configuration
  node\node.exe                         official Node x64 runtime
  app\                                 extracted application ZIP
C:\ProgramData\PickChick\Edge\config\edge.env
C:\ProgramData\PickChick\Edge\logs\
C:\ProgramData\PickChick\EdgeTools\<release>\
  scripts\ + node_modules\ + db\        separate copy of the application ZIP
  .local\                              private staff credentials
C:\ProgramData\PickChick\Postgres\18\data\
```

Run the service from the Program Files copy. Run owner/admin commands only from
the private EdgeTools copy: `staff-setup.mjs` deliberately writes `.local` beside
its packaged scripts. Protect the complete EdgeTools parent and the `.local`
directory before issuing a credential, using [the NTFS instructions](README.md).
Do not grant the edge service access to owner credentials or staff-token files.
Keep code read-only to the service; only its own logs need write access. The
service environment file gets the restricted runtime database URL. Owner and
runtime environments must remain separate, with no credentials in wrapper XML,
downloads, Git, command-line values or logs. These ACLs are installed and verified
on the actual Windows machine; ZIP extraction does not establish them.

The checked-in XML is a template for WinSW 2.12.0, not a service installer. It uses
LocalService, a PostgreSQL service dependency, delayed automatic startup, bounded
log rotation and escalating restart delays. Validate the service name, .NET
Framework installation, paths and final NTFS service permissions first. Test
start, stop, process failure, Windows reboot and database recovery on the host.
`sc create` pointing directly at `node.exe` is not a substitute for an SCM wrapper.

## Independently installed native prerequisites

Verified primary sources on 2026-09-15:

| Component                          | Pinned download                                                           | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Node 24.21.0 x64 ZIP               | [Node release](https://nodejs.org/en/blog/release/v24.21.0)               | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| WinSW 2.12.0 .NET461               | [WinSW release](https://github.com/winsw/winsw/releases/tag/v2.12.0)      | `b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f` |
| PostgreSQL 18.6-3 x64 binaries ZIP | [EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries) | `59f8ce701c63c2ed623c665a5e51b3ef6f2e37ccf837b68ffeed0742d0ae6abd` |

Node's downloaded ZIP matched its published `SHASUMS256.txt`. WinSW and PostgreSQL
hashes above pin the bytes downloaded from the linked official HTTPS sources;
no independently published SHA-256 was found for these two assets. Recheck the
download hashes on Windows before extraction/execution. This is not an
Authenticode verification claim. Preserve the distributed licenses.

[Node 24's platform table](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md)
lists Windows 10 x64. [WinSW 2.12's README](https://github.com/winsw/winsw/blob/v2.12.0/README.md)
supports the .NET461 build where .NET Framework 4.6.1 or a compatible newer version
is installed; this avoids its self-contained .NET Core 3.1 distribution.
[PostgreSQL's Windows page](https://www.postgresql.org/download/windows/) lists
tested Server 2022/2025 for PostgreSQL 18 and describes comparable desktop versions
as generally expected to work. This is not proof of execution on the monoblocks.
The native binaries archive does not run the EDB installer's prerequisite setup;
check required Visual C++ runtime libraries on the host.

PostgreSQL provides [native `pg_ctl register`](https://www.postgresql.org/docs/18/app-pg-ctl.html)
for Windows service registration. Inventory existing services, ports and data
before creating a separate loopback cluster/database. Keep `pickchick_edge` on a
dedicated port, use SCRAM, an owner role for setup and the restricted runtime role.
Database service ownership, data ACLs, backup/restore and physical restart tests
remain installation work. Never overwrite another PostgreSQL/iiko service.

## Acceptance boundary

The service needs `APP_ENV=local`, `EDGE_BRANCH_ID`, a loopback
`EDGE_DATABASE_URL` ending in `/pickchick_edge`, and its edge port. For kitchen it
also needs `EDGE_FULFILLMENT_ENABLED=true` and `EDGE_DEVICE_ID` matching trusted
provisioning. Redis and cloud are not required for this local edge. The service
binds `127.0.0.1`; a protected per-device connection is required from the kitchen.

The package includes `edge-migrate`, `edge-runtime-grants`, `staff-setup`,
`staff-revoke` and their helper dependencies. It deliberately excludes demo
seeding, cloud migration/transport and test data. Branch/menu/station/routing
provisioning must still use trusted data. An unpaid POS order does not become a
paid kitchen admission merely because both clients connect. Staff sessions
currently last eight hours. Payments, KKM, permanent sign-in, WAN loss, backup
restoration and physical Windows execution are separate acceptance requirements.
Before the first installation, reconcile the complete migration sequence with
other active branches. In particular, migration 007 from the unpaid-cancellation
branch must be resolved before applying 008/009: the migrator rejects late
out-of-order migrations. A successfully built ZIP is not approval to migrate an
existing restaurant database.
