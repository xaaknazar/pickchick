# TipTopPay TEST - guarded rollout preparation

Baseline API `f39863718f074e923ae24ffecf37d8bf36987cdf`, schema 038.
Roadmap `239148bf3329f6ec8e467b9425bcdff6189dd414` published after 7 tests,
immutable package, inspect/apply; its business-neighbor fingerprints unchanged.
Public pointer now uses the roadmap SHA; gateway digest remains
`1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51`.

`release-tiptoppay-test.py` requires Python 3.12 and exact green CI for all 11
jobs. It preserves auth/Kaspi/farm/kitchen policy and all public asset bytes,
adding bounded TEST gateway routes and an immutable private TEST environment.
Migrations 039/040 create separate empty tables. The sole API ACL delta is
SELECT/INSERT/UPDATE for `commerce_tiptoppay_test_payments`; no commercial
capture, order, outbox, provider-account or worker permission is added.

TEST mode, TEST webhook receiver and card option are enabled together. Live
checkout, live webhooks, reconciliation, method routing and Apple Pay domain
verification remain false. Existing Kaspi flags and credentials are preserved.
The original private credentials are read with 0600 guards; only a private
release environment receives them. No credentials are stored in Git or stdout.

Apply closes ingress under the owned deployment/cleanup locks, stops only API,
performs encrypted backup and temporary restore comparison, applies migrations
and narrow grants idempotently twice, verifies existing data/ACL/neighbor hashes,
checks old-image compatibility with retained schema, then installs the exact
immutable candidate and switches pointers by CAS. Explicit rollback restores
old API/public pointers and ACL while retaining additive schema and TEST rows;
it never restores the live database dump or drops tables.

This checkpoint prepares the release. VPS installation, real provider TEST
notifications and physical native checkout acceptance are not yet confirmed.
The backoffice public bundle is a separate guarded update; this release preserves
the currently published files. Individual wallets require provider routing/domain
verification before their own acceptance.
