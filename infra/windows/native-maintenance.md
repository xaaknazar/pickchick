# Native service maintenance verification

Run from an elevated, 64-bit Windows PowerShell 5.1 session after native stage 2
has completed. Supply the release directory already installed on this computer:

```powershell
.\verify-native-maintenance.ps1 -ReleaseName 'edge-0186902'
```

The script first requires the exact PostgreSQL and Edge service paths/accounts,
automatic startup, and running state. It audits every PostgreSQL data and binary
path for the service SID's effective Modify and ReadAndExecute rights respectively,
rejecting unexpected owners, access rules and reparse points. It does not change
ACLs. A file disappearing during the audit stops verification; rerun once the
filesystem is stable.

It then sets PostgreSQL SCM restart delays to 5, 15 and 60 seconds, a one-hour
failure-count reset, and recovery on unsuccessful non-crash stops. Windows repeats
the final 60-second action for subsequent failures; this is not a three-attempt
limit. The script verifies the registry payload and both services again before
emitting a JSON result. Repeating the same configuration is safe.

No database writes, service restart, forced crash or reboot are performed. The
result proves configuration readback, not recovery after a real crash or reboot.
The companion test checks parsing and malformed SCM payload rejection without
invoking Windows service or filesystem operations.
