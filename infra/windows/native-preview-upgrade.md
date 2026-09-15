# One-time native preview upgrade to schema 010

Run `update-native-preview.ps1` from elevated x64 Windows PowerShell 5.1. Keep its
reviewed companions `install-native-foundation.ps1` and `native-upgrade-db.mjs`
beside it. Their SHA-256 pins are checked before use; the foundation script's
installer body is never executed. Supply the separately packaged runtime's exact
source commit and archive hash:

```powershell
.\update-native-preview.ps1 `
  -ReleaseName 'edge-<7hex>' `
  -SourceCommit '<full reviewed source SHA>' `
  -BranchId '<installed branch UUID>' `
  -RuntimeArchive 'C:\absolute\edge-<7hex>.zip' `
  -RuntimeSha256 '<verified archive SHA256>' `
  -BackupManifest 'C:\ProgramData\PickChick\Backups\<verified run>\backup-manifest.json'
```

The helper accepts only the existing completed `edge-0186902` foundation, its
unchanged protected environment files, the same PostgreSQL cluster, a closed
branch with a published preview menu and no quotes/orders, and exact migrations
001-009. The backup manifest must record a completed restore rehearsal of those
30 tables; the dump itself is checked against its recorded hash and size.

It prepares two fresh NTFS-protected copies of the new runtime, verifies archive
paths, source commit, manifest files, file bytes and effective LocalService read
permissions, and rejects extra files. Node 24.21.0 and the existing WinSW/SCM paths,
accounts, PostgreSQL service, database credentials and data directory are kept.
Only Edge stops. The new operator copy migrates to 010 and reapplies restricted
runtime grants through the old private owner environment. Fingerprints of every
old table except the migration ledger must remain identical. Historical order
association's new nullable field is excluded from that comparison.

The existing WinSW XML is atomically replaced with only the app entry point and
working directory changed. The service starts using the old Node executable and
new app. Acceptance checks the real child command line, loopback listeners,
liveness/readiness, original menu release, restricted runtime privileges and
disabled ordering/fulfillment. PostgreSQL is not restarted. No staff sessions,
restaurant data, catalog releases, payments or fiscal documents are created.

An interrupted run preserves all files and private phase records. After inspection,
repeat the same pinned inputs with `-Resume`; migration recovery accepts only
exact ledger 009 or 010 and the recorded unchanged data. It does not restore,
reinitialize, delete, downgrade or start an old application automatically. A
completed run can use `-VerifyOnly` before further catalog/restaurant operations.
This is a one-time unused-preview verifier, not a daily health check after new
orders, sessions, menus or shifts have been created. Reboot/WAN tests remain separate.

Portable verification covers PowerShell parsing, malformed backup/XML rejection,
argument quoting, extraction tuple shape and the pinned JavaScript helper. Real
PostgreSQL tests cover unchanged table fingerprints through 009 to 010 and scope,
ordering and checksum rejection. They do not prove Windows NTFS or SCM execution.
