# Verify interrupted stage 1 after native dependency repair

Use `verify-native-foundation-recovery.ps1` only when the original stage 1
finished extracting files but failed its final native binary check. It does not
resume installation, replace files, reset permissions, initialize PostgreSQL or
register services. Its only destination write is a new private
`foundation-stage1.json`, using `CreateNew` after every verification passes.

Run in elevated x64 Windows PowerShell 5.1 with the same operator, release name,
branch ID and four local download paths used by stage 1. Supply the original
`install-native-foundation.ps1` from commit `f345210` alongside it, or through
`-Stage1Script`. The verifier pins that script's SHA-256 and imports only four
function declarations from its parsed AST; the installation body never runs.
All four download hashes are fixed in the verifier and cannot be overridden.

```powershell
.\verify-native-foundation-recovery.ps1 `
  -RuntimeArchive 'C:\Users\Operator\Downloads\edge-0186902.zip' `
  -NodeArchive 'C:\Users\Operator\Downloads\node-v24.21.0-win-x64.zip' `
  -PostgresArchive 'C:\Users\Operator\Downloads\postgresql-18.6-3-windows-x64-binaries.zip' `
  -WinSwExecutable 'C:\Users\Operator\Downloads\WinSW.NET461.exe' `
  -ReleaseName 'edge-0186902' `
  -BranchId $AssignedBranchId
```

Paths above are examples. The script checks expected NTFS owners/principals,
full operator/SYSTEM/Administrators rights, bounded LocalService rights, protected
installation roots and inherited extracted entries. It rejects unknown/missing
files or directories, reparse points and every byte difference from the original
archive extraction plan. It verifies both runtime copies, selected Node and
PostgreSQL files, WinSW bytes/version, and actual Node/PostgreSQL startup.

The database data, runtime config/logs and private operator directory must remain
empty. Existing target services, dedicated listeners or a prior stage 1 record
stop recovery. Service/empty-directory checks are repeated immediately before
the record is created. A failure retains the installation unchanged; investigate
the specific mismatch instead of changing pins or disabling checks.

The record preserves the original stage and false flags, adding
`recovery: verified_existing_extraction_after_native_dependency_repair` and
`verificationCounts`. It never asserts a running database, migrations, service
health or a supported commercial Windows deployment. Repairing a missing native
dependency is a separate operator action.

`tests/operations/windows-native-recovery.test.ps1` parses the actual script,
loads its pinned helpers, tests ACL-policy rejection, compares real temporary
files against ZIP streams, and checks native-version rejection. These checks run
on macOS PowerShell 7.5.2. NTFS observation and Windows PowerShell 5.1 execution
remain part of physical acceptance; the test reports this explicitly.
