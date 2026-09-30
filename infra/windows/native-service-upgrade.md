# Native unused-preview upgrade from schema 009 to 014

Use `update-native-service.ps1` for the installed `edge-0186902` foundation.
The historical `update-native-preview.ps1` remains a separate schema 010 helper;
do not run either foundation installer again over the existing database.

Keep the reviewed `install-native-foundation.ps1` and
`native-service-upgrade-db.mjs` beside the new PowerShell script. Run elevated
x64 Windows PowerShell 5.1 with a separately verified runtime archive:

```powershell
.\update-native-service.ps1 `
  -ReleaseName 'edge-<7hex>' `
  -SourceCommit '<full reviewed runtime source SHA>' `
  -BranchId '<installed branch UUID>' `
  -RuntimeArchive 'C:\absolute\edge-<7hex>.zip' `
  -RuntimeSha256 '<verified archive SHA256>' `
  -BackupManifest 'C:\ProgramData\PickChick\Backups\<verified run>\backup-manifest.json'
```

The helper checks the exact original foundation binding, PostgreSQL cluster ID,
completed 30-table schema 009 backup/restore proof and actual dump bytes. It only
accepts the unused local preview: no orders, quotes, kitchen reservations/config,
POS sync binding or cash shifts. The original menu, staff and sessions are kept.

The runtime archive must contain exactly migrations 001-014. Both new app and
operator copies are checked against their manifest, protected NTFS paths and
allowed service access. The original Node, PostgreSQL data and binaries,
credentials and both SCM service identities stay in place. PostgreSQL stays up;
only Edge stops. The old WinSW wrapper remains registered, and only its app entry
point/working directory change atomically to the new release.

Before switching the app, the owner runs migrations and restricted POS/auth
grants. The verifier checks each recoverable ledger 009/010/011/012/013/014 against
the reviewed SQL checksums and exact table names: 30/31/33/34/35/38 tables.
New tables must stay empty. Fingerprints retain every original field except
these explicit additive columns: `local_orders.cash_shift_id/execution_mode`,
`branch_config.pos_service_mode`, reservation admission-origin fields, and `local_stops.expires_at/expires_shift_id/updated_at/updated_by`.
The new branch mode is checked separately as `payment_required`.

An interruption after any complete migration can resume with the same pinned
inputs and `-Resume`, provided all original fingerprints and expected defaults
still match. The private `service-upgrade-state.json` is separate from the old
010 upgrade record. There is no automatic restore, deletion, downgrade or fallback
to an old executable after a failed migration.

Acceptance checks real process paths, SCM accounts/autostart, loopback listeners,
HTTP liveness/readiness, the unchanged menu, disabled fulfillment and the current
password-login/shift database privilege boundaries. It does not create a login,
cash shift or restaurant order. Ordering stays closed, mode stays
`payment_required`, and fulfillment/transport flags stay off. The original
protected environment files are verified unchanged by SHA-256.

After this checkpoint, separately install catalog v2, enroll staff passwords,
configure the protected kitchen connection, apply kitchen runtime grants and use
the reviewed `local-pos-service.mjs prepare` and explicit `enable` workflow. The
service environment and owner environment must be updated deliberately for those
later operations. They are not mutations hidden inside this upgrade helper.

`-VerifyOnly` is for the completed upgrade before those later catalog/auth/service
changes. Portable PowerShell tests validate parsing, backup/XML refusal, quoting,
source pins and six interrupted-migration checkpoints. An isolated PostgreSQL
test migrates through every checkpoint, compares old fingerprints, rejects changed
data/mode/table sets and validates a real restricted LOGIN. Windows NTFS/SCM,
reboot, two-device and WAN-loss acceptance remain separate physical checks.
