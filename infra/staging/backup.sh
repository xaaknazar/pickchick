#!/usr/bin/env bash
# Run as pickchick-ops. The age PRIVATE key must remain off this VPS.
set -euo pipefail
umask 077
root=/opt/pickchick-staging
exec 9>"$root/backups/.lock"
flock -n 9 || exit 0
recipient=$(cat "$root/secrets/backup-recipient.txt")
[[ "$recipient" == age1* ]] || { echo 'Invalid backup recipient' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
base="$root/backups/cloud-$stamp.dump.age"
trap 'rm -f "$base.tmp"' EXIT
docker compose --env-file "$root/secrets/staging.env" --env-file "$root/current/release.env" \
  -f "$root/current/infra/staging/compose.yaml" exec -T cloud-db \
  pg_dump -U postgres -d pickchick_cloud --format=custom --no-owner --no-acl \
  | age -r "$recipient" -o "$base.tmp"
test -s "$base.tmp"
mv "$base.tmp" "$base"
sha256sum "$base" > "$base.sha256"
# Only delete matching backups after a new, nonempty encrypted copy succeeded.
find "$root/backups" -maxdepth 1 -type f -name 'cloud-*.dump.age*' -mtime +7 -delete
printf 'Encrypted staging backup complete: %s\n' "$stamp"
