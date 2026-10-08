# Protected local PostgreSQL backup and restore rehearsal

This separate operator command runs after the native cashier foundation and the
assigned closed branch have been provisioned. Use the same elevated x64 Windows
PowerShell 5.1 account. Keep the four script files from its delivery ZIP together.

```powershell
.\backup-native-edge.ps1 -ReleaseName edge-0186902 -BranchId 7a6f6d98-395d-4462-b5e4-b0364a4a8ec1
```

The wrapper verifies the pinned helper bytes and the completed private installation
record, then creates `C:\ProgramData\PickChick\Backups\<timestamp>-<random-id>` with
access only for the operator, Administrators and SYSTEM. It does not export any
file, change services or overwrite an existing database. Its helper uses the
existing protected owner/bootstrap credentials; no password is accepted or printed
on a command line. A temporary protected pgpass file is deleted at completion.

The tool verifies the same PostgreSQL system identifier and closed branch, keeps a
repeatable-read snapshot open, records all public-table counts, and runs `pg_dump`
in custom format against `pickchick_edge` using that snapshot. It verifies the TOC
with `pg_restore --list`, records archive bytes and SHA-256, then restores into a
new randomly named `pickchick_restore_<uuid>` database on that same cluster. No
existing name is reused. Restore runs as bootstrap with `--no-owner --no-acl`,
`--single-transaction` and `--exit-on-error`; it never uses `--clean` or `--create`.

Acceptance compares every restored public-table count with the dump snapshot and
checks the nine edge migrations and assigned closed branch. Finally the tool
drops only its newly created database after checking its name, recorded OID,
bootstrap owner and unique run comment. It never uses DROP FORCE. If those checks
fail or connections remain, it preserves the database for operator inspection and
reports failure. A failure after CREATE with an uncertain result also requires
inspection of the unique name in the private manifest; it does not guess ownership.

## Service backup at a named edge schema

`backup-native-service.mjs` is the same rehearsal for a running service cashier
(ordering stays open, `unpaid_service` branch). Its last argument names the edge
schema the cashier is expected to be at:

```text
node.exe backup-native-service.mjs <toolsRoot> <pgBin> <runRoot> <branchId> [schema014|schema015|schema016|schema017|schema018|schema019]
```

Without it the expected schema is `schema014`. The migration ledger of the dump
snapshot and of the restored copy must equal exactly that prefix of the pinned
`native-edge-backup-ledger.json` (file name, SHA-256 and scope of every migration
001-019). Any other schema name, a ledger one migration behind or ahead, or any
changed checksum fails closed. The manifest records `expectedSchema`. Guarded
upgrades (`menu-sync-upgrade-db.mjs`, `remote-stops-upgrade-db.mjs`) accept only a
manifest at the current ledger, finished less than 6 hours earlier.

The folder retains `pickchick_edge.dump`, `archive-list.txt` and
`backup-manifest.json`, plus pinned code and bounded process diagnostics. These
files stay private: the backup can contain staff sessions and operational data.
The final summary reports success only after dump, restore/count verification and
owned-database removal all pass. A local copy on the cashier is not an off-device
backup, scheduled retention policy, disaster recovery acceptance or power-loss test.

Targeted tests cover PowerShell parsing/pins/actual argument binding and the cleanup
ownership refusal rules. Physical Windows `pg_dump`/`pg_restore` execution and its
manifest remain the required evidence before declaring a backup verified.

- [PostgreSQL 18 pg_dump snapshot option](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL 18 pg_restore options](https://www.postgresql.org/docs/18/app-pgrestore.html)
- [PostgreSQL 18 password file](https://www.postgresql.org/docs/18/libpq-pgpass.html)
