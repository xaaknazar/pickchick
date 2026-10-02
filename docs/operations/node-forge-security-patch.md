# node-forge: temporary verified RSA patch

2 October 2026. `pnpm audit` reports high-severity [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
The npm registry has only 1.4.0; 1.4.1 is not published. The official advisory
lists no patched release. Do not label a local patch as an upstream release.

`patches/node-forge@1.4.0.patch` applies the nested DigestAlgorithm element-count
check from [upstream PR1152](https://github.com/digitalbazaar/forge/pull/1152),
commit `ceba34402e329f0365134f23fe19898756527d65`. Independent review also reproduced
nonempty ASN.1 NULL parameter acceptance; the patch rejects that remaining
padding space while preserving absent and empty NULL parameters.
Only `lib/rsa.js` verification changes. pnpm pins the patch hash in both the
workspace configuration and lockfile. Staging source archives include `patches`;
the existing Dockerfile copies the full archive before frozen installation.

`pnpm audit:release` verifies the repository and installed lock snapshots,
all their node-forge references, every physical installed forge copy and all
mobile/kiosk Expo CLI/certificate resolutions against the reviewed RSA hash.
It then runs real RSA signature regressions: SHA256/384/512, valid omitted/empty
NULL, wrong message, extra nested children and nonempty NULL. The ordinary unit
suite also proves the adversarial test detects the unpatched implementation.
Only after those checks does the audit command exempt this exact GHSA for
node-forge1.4.0 findings. All other high/critical findings and unexpected or
incomplete audit responses still fail. Raw `pnpm audit --audit-level=high` continues
to report the upstream version-based advisory; its output is not a failed
local remediation or a claim that npm has published a fix.

After changing patch hashes, use a fresh generated dependency directory and
`pnpm install --frozen-lockfile`: pnpm can retain obsolete unlinked store copies,
which the conservative installed-copy check intentionally rejects. Preserve
existing generated dependencies outside the worktree if needed; native signing,
Pods and Xcode caches do not need to change.

Remove this patch and the exact advisory exception together only when an
upstream published version closes both malformed nested-sequence and nonempty
NULL cases, passes these behavioral regressions, and raw npm/pnpm audit no longer
reports this GHSA. Review new versions rather than extending the exception.
