#!/usr/bin/env bash
# Runs as the existing PickChick operator, with a pinned, verified release.
set -euo pipefail
umask 077
release_sha=${1:-}
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
base=/opt/pickchick-staging
release="$base/releases/$release_sha"
state="$base/maintenance"
test -f "$release/scripts/customer-identity-maintenance.mjs"
test -f "$release/release.env"
test "$(sed -n 's/^RELEASE_SHA=//p' "$release/release.env")" = "$release_sha"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "pickchick-api:$release_sha")" = "$release_sha"
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/identity-cleanup.lock"
flock -n 9 || exit 0
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
exit_status=0
timeout --signal=TERM 120 docker compose \
  --env-file "$base/secrets/staging.env" \
  --env-file "$release/release.env" \
  -f "$release/infra/staging/compose.yaml" \
  run --rm --no-deps -T provision node scripts/customer-identity-maintenance.mjs cleanup \
  >"$state/identity-cleanup.last.log" 2>&1 || exit_status=$?
python3 - "$state" "$release_sha" "$started_at" "$exit_status" <<'PY'
import json, os, pathlib, sys
from datetime import datetime, timezone
directory, source_sha, started_at, status = sys.argv[1:]
target = pathlib.Path(directory) / 'identity-cleanup.last.json'
temporary = target.with_suffix('.tmp')
temporary.write_text(json.dumps({
    'source_sha': source_sha, 'started_at': started_at,
    'finished_at': datetime.now(timezone.utc).isoformat(),
    'exit_status': int(status), 'success': status == '0',
}) + '\n')
temporary.chmod(0o600)
os.replace(temporary, target)
PY
exit "$exit_status"
