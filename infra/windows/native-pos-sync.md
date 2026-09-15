# Windows POS private synchronization

This adds `PickChickSyncTunnel` and `PickChickPosSync` beside the existing native
foundation. It does not update PostgreSQL, Node, WinSW, Edge, Windows capabilities,
firewall rules, ordering flags, menu data or payment/fiscal state. The approved
foundation remains Node 24.21.0, PostgreSQL 18.6 and WinSW 2.12.0. The stage-1
`nodeSha256` identifies its ZIP; the installer separately pins the extracted
`node.exe`. The Windows OpenSSH Client must already be present and signed.

POS order events and kitchen progress are two durable streams. The worker uses
`@pickchick/pos-order-sync` for both. Database leases, retries, unacknowledged
payloads and checkpoints survive process/network failures. An open tunnel is not
proof that the cloud accepted an order. No receipt or payment is fabricated.

## Preconditions

1. Run `inspect-native-ssh.ps1` in elevated x64 Windows PowerShell. This is read-only:
   it reports OpenSSH, signatures, local port 43100 and existing service accounts.
   An absent client requires a separately reviewed Windows prerequisite action.
2. Complete the existing foundation and explicit branch provisioning. Apply edge
   migrations 001-013 and install the immutable runtime with the files below.
3. Obtain confirmed organization, branch and device UUIDs from the actual operator
   plan/cloud registration. A staging test branch is not a substitute.
4. Have an operator-verified, single ED25519 host-key record. Copy it from the
   previously trusted connection and verify its SHA256 through that trusted path.
   Do not use an unverified `ssh-keyscan` or disable host-key checking.
5. The VPS API remains private. Its actual internal port is discovered by the
   operator; it is supplied as `remoteApiPort`, never exposed publicly by this setup.

Build `@pickchick/pos-order-sync` and include its production dependency closure
alongside `@pickchick/platform`, `@pickchick/database` and `@pickchick/contracts`.
The runtime manifest must include:

```text
infra/windows/inspect-native-ssh.ps1
infra/windows/install-native-pos-sync.ps1
infra/windows/native-pos-sync-db.mjs
infra/windows/native-pos-sync-worker.mjs
infra/windows/native-pos-sync-permissions.ps1
infra/windows/native-pos-sync.md
infra/windows/native-foundation-db.mjs
infra/windows/pos-sync-worker-grants.mjs
```

The worker dynamically resolves packages from its immutable `app/package.json`.
Do not copy a pnpm store, symlinks, owner environment, machine identity or keys into
this distributable. The source's shared `scripts/private-identity.mjs` is Unix-only;
the Windows launcher checks NTFS ACLs explicitly instead of POSIX permission bits.

## Three phases

Run the installer with elevated x64 **Windows PowerShell 5.1**, from the reviewed
runtime. `<release>`, `<40-character-source-commit>` and `<branch-uuid>` below are
operator substitutions, not literal commands. Use the same values in every phase.
The default foundation release is `edge-0186902`.

```powershell
.\install-native-pos-sync.ps1 -Mode Prepare -ReleaseName '<release>' -SourceCommit '<40-character-source-commit>' -BranchId '<branch-uuid>'
```

Prepare writes the private setup checkpoint before subsequent work. It generates
an ED25519 key **on this Windows machine**, makes its private file LocalService-owned,
and creates a separate `pickchick_pos_sync` PostgreSQL LOGIN. Because Windows
OpenSSH rejects an operator reading a LocalService-owned private key, pair
verification uses a temporary Administrators/SYSTEM-only copy inside the protected
operator directory. It is deleted in `finally`; the final service key ACL is never
broadened and the private key never leaves this Windows machine. Its deterministic
SCRAM verifier makes a partially created role recoverable with the same saved
secret. An existing different verifier, elevated role, membership, ownership,
nonstandard role settings, wrong PostgreSQL system identifier or foreign branch
fails without resetting credentials.

Bootstrap authentication is used only for `CREATE ROLE` and read-only cluster
verification. The existing owner grants only schema usage, database connect,
SELECT on the two sync states/source outboxes, and column-specific delivery
updates. It cannot grant the worker permission to create/change restaurant orders,
change payloads, toggle sync activation or write menu, payment and fiscal data.

Only export this **public** file for the VPS tunnel account:

```text
C:\ProgramData\PickChick\PosSync\operator\tunnel-public-key.pub
```

Create a dedicated VPS SSH account, separate from root/the general operator.
Its server-side policy must allow only local forwarding to `127.0.0.1:<API-port>`,
with no shell/command session, PTY, X11, agent forwarding, remote forwarding or
other destination. Review `AllowTcpForwarding local`, `PermitOpen`,
`MaxSessions 0`, `PermitTTY no` and `AllowAgentForwarding no` in the VPS operator
configuration. Client restrictions alone do not replace this account policy.

The operator's `connection.json` has these exact fields (UUIDs shown are synthetic):

```json
{
  "format": "pickchick-pos-sync-connection-v1",
  "sshHost": "vps.example.test",
  "sshPort": 22,
  "sshUser": "dedicated_tunnel",
  "remoteApiPort": 13100,
  "organizationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "branchId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "deviceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

The registered device identity is a separate protected file with the canonical
fields `device_id`, `branch_id`, `token` (64 lowercase hex characters) and
`expires_at` (ISO datetime). Never paste its token into shell arguments, Git,
screenshots or logs. Protect the input with an explicit DACL granting only the
current operator, SYSTEM and Administrators before Configure.

```powershell
.\install-native-pos-sync.ps1 -Mode Configure -ReleaseName '<release>' -SourceCommit '<40-character-source-commit>' -BranchId '<branch-uuid>' -ConnectionFile 'C:\Protected\connection.json' -KnownHostsFile 'C:\Protected\known_hosts' -KnownHostsSha256 '<trusted-file-sha256>' -IdentityFile 'C:\Protected\device-identity.json'
```

Configure verifies endpoint/key/identity scope and expiry, writes create-only
service files, then explicitly binds local POS transport. It preserves any existing
`local_order_streams.producer_id`. It exports the actual scope plus `producerId` to
`operator\cloud-binding.json`. Register that binding on the private cloud database
using `scripts/pos-order-sync-setup.mjs cloud <protected-input-path>` before Install.
The POS producer is distinct from the other fulfillment transport's producer.
Configure changes no restaurant ordering or fulfillment activation flags.

```powershell
.\install-native-pos-sync.ps1 -Mode Install -ReleaseName '<release>' -SourceCommit '<40-character-source-commit>' -BranchId '<branch-uuid>'
.\install-native-pos-sync.ps1 -Mode Verify -ReleaseName '<release>' -SourceCommit '<40-character-source-commit>' -BranchId '<branch-uuid>'
```

Install creates only two new LocalService WinSW services, delayed automatic start
with restart recovery. The worker depends on both `PickChickEdge` and
`PickChickSyncTunnel`. SSH uses a pinned host key, `BatchMode`,
`ExitOnForwardFailure`, 15-second keepalives/3 missed replies, no passwords, agent,
X11 or interactive command. The forward binds exactly `127.0.0.1:43100` and targets
only the VPS loopback API. No renderer/browser can choose its endpoint.

Install/Verify check service identity, image/XML, dependency configuration, actual
SSH listener ownership, immutable inputs and the restricted database login.
They explicitly return `cloudDeliveryVerified: false`: a listener cannot establish
remote API readiness or a valid device registration. Observe delivery checkpoints
and the back-office projection of a real authorized order and its kitchen status,
then check reconnect/reboot behavior on the physical Windows devices.

## Protected state and recovery

- Program Files `PickChick\PosSync`: new WinSW wrappers and XML; LocalService read.
- ProgramData `PickChick\PosSync\operator`: operator checkpoint, sync database
  secret, public export and binding; only Administrators/SYSTEM.
- ProgramData `PickChick\PosSync\service`: SSH key, pinned host file, worker
  environment and device identity; LocalService read. The SSH private key is
  LocalService-owned. No bootstrap/owner secret is copied here.
- ProgramData `PickChick\PosSync\logs`: bounded rotating logs, LocalService modify;
  worker logs only whitelisted event/state names.

Use `Prepare -Resume` only for the same recorded machine, operator, foundation,
source and sync secret. Configure/Install may be repeated with the exact same
inputs after a confirmed failure. Existing mismatched files are never overwritten;
unknown partial key generation/files remain for protected operator inspection.
The installer does not delete directories, reset roles or roll back an active
business database. A different release, host key or rotated device identity needs
an explicit maintenance procedure, not editing this checkpoint. Identity expiration
stops authenticated delivery while retaining the durable pending events.

## Verification evidence

`windows-pos-sync.test.ps1` parses all PowerShell files and executes the actual
pure functions for Windows argument escaping, SSH restrictions, host-key matching,
WinSW XML/dependencies and create-only/atomic state recovery. It does not claim
macOS PowerShell 7 proves Windows 5.1 ACL, OpenSSH or SCM behavior.

`windows-pos-sync.test.mjs` covers credential separation, scope/URL drift, malformed
and expired identities, symlinks and immutable setup constraints. Its opt-in native
PostgreSQL test uses a newly initialized disposable cluster. Where a complete
local PostgreSQL server is unavailable, `run-windows-pos-sync-docker.mjs` runs the
same test with two new isolated containers, no published ports/existing database,
and destroys only those test containers:

```sh
PICKCHICK_SYNC_TEST_IMAGE='<locally-built-current-api-image>' node tests/operations/run-windows-pos-sync-docker.mjs
```

The PostgreSQL test proves cluster mismatch fails before CREATE ROLE; partially
created roles recover with the same SCRAM secret; different secrets/excess rights
fail; the real restricted LOGIN can deliver but cannot alter orders/payloads; and
repeated binding preserves the existing producer and ordering-disabled state.
Physical Windows acceptance remains required for LocalService OpenSSH key access,
actual SSH connection, WinSW child PID ownership, reboot and cloud acknowledgment.
