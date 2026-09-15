# Native Windows foundation: stage 1

`install-native-foundation.ps1` prepares files for a **fresh** installation of the
reviewed edge `0186902`, Node 24.21.0, PostgreSQL 18.6-3 and WinSW 2.12.0. Its name
does not mean that it installs a running server. It creates no database, roles,
credentials, environment secrets, migrations or services. Fulfillment remains
unconfigured. This narrower first step allows archive delivery and native binary
startup to be checked before introducing database ownership and secret handling.

Use elevated **64-bit Windows PowerShell 5.1**. Supply local NTFS files whose hashes
were checked against the delivery record, a short release label and an externally
assigned branch UUID. The default SHA-256 pins match the released files in
[runtime-package.md](runtime-package.md) and the edge-0186902 delivery record.
Overriding a hash is an operator trust decision, not a way to bypass a mismatch.

```powershell
.\install-native-foundation.ps1 `
  -RuntimeArchive 'C:\Users\Operator\Downloads\edge-0186902.zip' `
  -NodeArchive 'C:\Users\Operator\Downloads\node-v24.21.0-win-x64.zip' `
  -PostgresArchive 'C:\Users\Operator\Downloads\postgresql-18.6-3-windows-x64-binaries.zip' `
  -WinSwExecutable 'C:\Users\Operator\Downloads\WinSW.NET461.exe' `
  -ReleaseName 'edge-0186902' `
  -BranchId $AssignedBranchId
```

The paths above are examples. Do not copy seed branch/device/staff identities into
a restaurant installation. This script records the supplied branch ID but does
not provision it or assert that it is production data. It does not change the
PowerShell execution policy, Defender, firewall, network, sleep settings or iiko.

## Checks and destinations

Before creating any destination it requires elevated x64 Windows PowerShell,
Windows build 18363 or newer, .NET Framework 4.8, local fixed NTFS drives, no
reparse-point ancestors, 4 GiB free per destination drive, no existing PickChick
server directories/services, and no listener on 55433 or 3101. Other PostgreSQL
instances are left alone. Existing shared `PickChick` parent directories must
already have private, protected ACLs; they are never reset.

Each input stays open with writes/deletion denied from SHA-256 verification
through extraction. ZIP plans reject traversal, alternate streams, Windows device
names, duplicate/case-colliding files, file/directory collisions, links, excessive
expanded size and paths longer than 259 characters. All plans and the exact runtime
source/migration set are checked before writing files. Extraction uses `CreateNew`.

Fresh directories are created with protected ACLs for the operator, SYSTEM and
Administrators. LocalService receives read/execute on service code and read/execute
on its empty config directory, plus modify on its own empty logs directory. It gets
no access grant to the private operator copy or PostgreSQL data. PostgreSQL service
identity and data permissions must be assigned by the subsequent reviewed stage.

The script creates the layout in [runtime-package.md](runtime-package.md), with
PostgreSQL binaries under `Program Files\PickChick\Postgres\18.6-3`. It extracts only
Node runtime/license/documents and PostgreSQL server/command-line tools, libraries,
resources and licenses; pgAdmin, StackBuilder, npm and Corepack are not installed.
No directory is added to PATH. It checks the actual `node.exe --version` and
`postgres.exe --version` results, and the WinSW file version. Missing native DLLs
therefore fail preparation instead of being reported as successful installation.

A successful run writes private `EdgeTools\<release>\foundation-stage1.json` with
explicit false flags for database initialization, credentials, migrations, services
and health. A failed/interrupted run retains its protected partial files and stops.
Inspect them before removal or recovery; the script never recursively removes
unknown data or resumes over an existing installation.

## Next stage and acceptance

Database initialization under its intended Windows service identity, SCRAM
password generation into protected temporary files, independent owner/runtime
roles, loopback-only 55433, UTF-8/checksums, edge-only migrations, WinSW registration,
service health/restart and secret cleanup are **not implemented by stage 1**.
They require a separate reviewed operator step following [the runtime runbook](README.md).
Do not run demo seeding or enable fulfillment before trusted branch/menu/routing
provisioning. PostgreSQL's [initdb](https://www.postgresql.org/docs/18/app-initdb.html)
and [service registration](https://www.postgresql.org/docs/18/app-pg-ctl.html), and
[WinSW installation](https://github.com/winsw/winsw/blob/v2.12.0/doc/installation.md)
are the authoritative native entry points for that stage.

Windows 1909 meets the binaries' documented Windows 10 execution floor, but
[Microsoft ended Pro 1909 servicing in May 2021](https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-1909-end-of-servicing).
[Node 24's policy excludes vendor-EOL platforms](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md).
Successful preparation on this host is therefore not supported production
acceptance. EDB's tested PostgreSQL 18 platforms remain Server 2022/2025; physical
Windows compatibility, NTFS ACL behavior and database recovery must be verified.

## Local validation

`tests/operations/windows-native-stage1.test.ps1` parses the complete operator
script and runs its actual pure ZIP validation/selection functions against hostile
and valid in-memory archives. Optional `-RuntimeArchive`, `-NodeArchive` and
`-PostgresArchive` inputs validate plans for the actual delivery archives without
extracting or executing them. PowerShell 7 on a Mac can run these checks; doing so
does not validate Windows PowerShell 5.1, NTFS or native Windows execution.

On 15 September 2026, the PowerShell 7.5.2 parser and five archive-check groups
passed on Mac. Plans for the actual delivery selected 7,768 runtime files
(including the manifest), four Node files and 1,588 PostgreSQL files. The complete
Windows operator script has not been executed on physical Windows by this check.
