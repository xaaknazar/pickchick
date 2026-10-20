#!/usr/bin/env bash
# Run as pickchick-ops. The age PRIVATE key must remain off this VPS.
# Daily: pg_dump -> age -> local copy + .sha256 + encrypted row-count manifest, then (when
# secrets/backup-offsite.env enables it) the same files to S3-compatible storage and, with the
# PITR option, a physical base backup. backups/backup-status.json records the last attempt and
# the failed stage for the watchdog; pickchick-backup.service also starts it via OnFailure=.
set -euo pipefail
umask 077
root=${PICKCHICK_STAGING_ROOT:-/opt/pickchick-staging}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
backups="$root/backups"
exec 9>"$backups/.lock"
flock -n 9 || exit 0
stage=config
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status_file="$backups/backup-status.json"
last_success=$(sed -n 's/.*"lastSuccessAt": *"\([0-9TZ:-]*\)".*/\1/p' "$status_file" 2>/dev/null || true)
write_status() {
  local ok=$1 success=$2 tmp="$status_file.$$.tmp"
  if [[ -n "$success" ]]; then success="\"$success\""; else success=null; fi
  printf '{"lastAttemptAt":"%s","lastSuccessAt":%s,"ok":%s,"stage":"%s"}\n' \
    "$started" "$success" "$ok" "$stage" >"$tmp" && mv "$tmp" "$status_file"
}
finish() {
  local code=$?
  rm -f "${base:-/nonexistent}.tmp" "${manifest:-/nonexistent}.tmp"
  if [[ $code -ne 0 ]]; then
    write_status false "$last_success" || true
    printf 'Encrypted staging backup FAILED at stage %s\n' "$stage" >&2
  fi
  exit "$code"
}
trap finish EXIT
recipient=$(cat "$root/secrets/backup-recipient.txt")
[[ "$recipient" == age1* ]] || { echo 'Invalid backup recipient' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
base="$backups/cloud-$stamp.dump.age"
manifest="$backups/cloud-$stamp.manifest.json.age"
db() {
  docker compose --env-file "$root/secrets/staging.env" --env-file "$root/current/release.env" \
    -f "$root/current/infra/staging/compose.yaml" exec -T cloud-db "$@"
}
# Row counts of every table and the migration ledger head, read just before and just after the
# dump; a restore drill must land inside that range (restore-drill.py).
counts_sql="SELECT json_build_object('capturedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'migration', (SELECT max(version) FROM schema_migrations
  WHERE scope = 'cloud'), 'tables', (SELECT json_object_agg(c.relname, (xpath('/row/c/text()',
  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true,
  '')))[1]::text::bigint ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON
  n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')))"
counts() { db psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d pickchick_cloud -c "$counts_sql"; }
stage=counts
before=$(counts)
stage=dump
db pg_dump -U postgres -d pickchick_cloud --format=custom --no-owner --no-acl \
  | age -r "$recipient" -o "$base.tmp"
test -s "$base.tmp"
stage=manifest
after=$(counts)
[[ "$before" == \{* && "$after" == \{* ]]
printf '{"version":1,"dump":"cloud-%s.dump.age","before":%s,"after":%s}\n' "$stamp" "$before" "$after" \
  | age -r "$recipient" -o "$manifest.tmp"
mv "$manifest.tmp" "$manifest"
mv "$base.tmp" "$base"
sha256sum "$base" > "$base.sha256"
stage=offsite
# No-op (status "enabled": false) until secrets/backup-offsite.env enables the off-site copy.
PICKCHICK_STAGING_ROOT="$root" python3 "$here/backup-offsite.py" upload "$base"
stage=base_backup
PICKCHICK_STAGING_ROOT="$root" python3 "$here/backup-offsite.py" base-backup
stage=retention
# Only delete matching backups after a new, nonempty encrypted copy succeeded.
find "$backups" -maxdepth 1 -type f \( -name 'cloud-*.dump.age*' -o -name 'cloud-*.manifest.json.age' \) \
  -mtime +7 -delete
write_status true "$started"
printf 'Encrypted staging backup complete: %s\n' "$stamp"
