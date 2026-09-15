# Native Windows foundation - stage 2

Run this only after the matching stage-1 record is complete, using elevated x64
Windows PowerShell 5.1 on the cashier. The operator supplies the same release name
and reserved branch UUID. A branch reservation is not a cloud registration.

```powershell
.\install-native-services.ps1 -ReleaseName edge-0186902 -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1
```

Keep `native-foundation-db.mjs` next to the script. Its reviewed SHA-256 is pinned
inside the PowerShell file and checked before and after copying into the private
operator directory. The script accepts no database password on its command line.
It generates three independent 256-bit passwords on the Windows host, writes the
bootstrap password to an administrator-only initdb file, then removes that file.
Owner/bootstrap credentials remain in the protected operator directory; only the
runtime credential is readable by the edge service. PostgreSQL receives SCRAM
verifiers for owner/runtime role creation, never their plaintext SQL passwords.

The script uses the already extracted PostgreSQL 18.6, Node 24.21.0 and WinSW 2.12.
PostgreSQL's native dependencies must run before stage 1 is accepted. The actual
Windows 1909 host required the official Microsoft Visual C++ x64 runtime; its
installation and subsequent `postgres --version` success were observed by the
installation operator, independently of these repository tests.

The database is UTF8, locale C, with checksums and SCRAM enabled, bound only to
127.0.0.1:55433. `PickChickPostgres` runs as its dedicated passwordless Windows
virtual account `NT SERVICE\PickChickPostgres`. Only that account receives Modify
on PostgreSQL data; the edge LocalService account receives no data-directory grant.
The edge runtime cannot own schema objects or create roles/databases/tables, and
has only the repository's explicit POS grants. Migrations 001-009 run as the
separate owner; no cloud migrations or seeds run.

`PickChickEdge` runs under `NT AUTHORITY\LocalService` with read-only code and
configuration, writable rotated logs, automatic delayed startup and restart
recovery. It depends on PostgreSQL. Both service identities, exact executable
paths, owning listener processes, database identity, actual runtime login,
migration ledger, privileges and HTTP health are verified. Setup also performs
a controlled edge/PostgreSQL restart. It does not restart Windows.

Immediately after schema-only setup, `/health/live` must be 200 and
`/health/ready` must be 503 with the database up. No `branch_config`, staff, menu or
order rows are created. Apply the separately reviewed local branch/menu
provisioning step, with ordering closed, then verify again:

```powershell
.\install-native-services.ps1 -ReleaseName edge-0186902 -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1 -VerifyOnly -RequireBranchReady
```

Fulfillment remains disabled in configuration and runtime database grants. Its
station/device/routing setup and the kitchen's authenticated transport are a later
explicit stage. No firewall rules, network addresses, sleep settings, device
credentials, payment/fiscal adapters or commercial readiness claims are added.

## Recovery and operator files

`C:\ProgramData\PickChick\EdgeTools\<release>\private` contains the protected
`foundation-state.json`, `foundation-credentials.json`, `edge-owner.env` and bounded
step diagnostics. Never share that directory or commit its contents. The state
records the Windows computer, operator SID, release/source, branch, installation
UUID and PostgreSQL system identifier. A known identifier is checked before any
database mutation on resume.

After inspecting a failed phase, pass `-Resume` with identical inputs from the
same Windows account. Matching completed phases are reused. Conflicting services,
foreign state, changed credentials/configuration, unexpected ACLs, or uncertain
partial initdb data stop execution and preserve existing files. There is no
automatic deletion, cluster reinitialization or overwrite of an existing env.
An incomplete initdb result or interrupted credential creation needs explicit
operator inspection; repeatedly invoking `-Resume` does not resolve uncertainty.
Use `-VerifyOnly` after completion; setup cannot overwrite a completed record.

Backups and restore rehearsal, an actual Windows reboot, WAN-loss behavior,
trusted restaurant setup and device acceptance remain required separately.

## Targeted checks and primary references

`tests/operations/windows-native-services.test.ps1` parses the installer and tests
its actual argument-array AST, CRT argument escaping and cryptographic password
format/uniqueness without executing Windows installation actions. The Node suite
tests credential validation and supports an opt-in disposable PostgreSQL 18.6
cluster through `PICKCHICK_NATIVE_RUNTIME` and `PICKCHICK_TEST_PG_BIN`.
PowerShell 7 on macOS parsing is not Windows PowerShell 5.1/NTFS/SCM acceptance.
Actual Windows PowerShell 5.1 exposed a null-to-empty-string conversion in
`File.Replace`; explicit `NullString` was then verified twice on that host.
The portable suite now also performs two real atomic state replacements. An
already interrupted credential write still requires inspected operator recovery;
this fix does not silently advance or regenerate existing credentials.
Before delivery, PostgreSQL 18.6 was also exercised in a new network-isolated
Docker container with the pinned runtime closure: both SCRAM logins, repeated
bootstrap, all nine migrations, restricted runtime rights, absence of branch
seed, role-escalation rejection and early cluster-ID rejection passed. Native
macOS execution was unavailable because its libpq package lacks the server
binary. No existing local database or Windows service was used by that check.

- [PostgreSQL 18 initdb](https://www.postgresql.org/docs/18/app-initdb.html)
- [PostgreSQL 18 pg_ctl](https://www.postgresql.org/docs/18/app-pg-ctl.html)
- [PostgreSQL Windows service implementation](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/bin/pg_ctl/pg_ctl.c)
- [Microsoft CreateService virtual-account semantics](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew)
- [WinSW 2.12 configuration implementation](https://github.com/winsw/winsw/blob/v2.12.0/src/WinSW.Core/Configuration/XmlServiceConfig.cs)
