#!/usr/bin/env python3
"""Cloud-1 local gates and resolved-compose preparation. Never deploys or connects to DB.

Inputs containing configuration stay in protected local files. Only hashes and
check names are printed. A prepared compose is not a release/restore receipt.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

BASELINE = '6630eb0f676350341806b735b6877a36f017c673'
COMPOSE_SHA = '3b6d2f55be5e8dae202de15dfca292b9f33e278c4435befee7ee6623dadd4d4c'
BRANCH = 'codex/cutover-1119'
REPO = 'xaaknazar/pickchick'
FLAGS = (
    'CLOUD_POS_SALES_SYNC_ENABLED', 'CATALOG_AGGREGATOR_PRICES_ENABLED',
    'BACKOFFICE_ROLES_ENABLED', 'BACKOFFICE_STOCK_V2_ENABLED',
    'BACKOFFICE_SALES_REPORT_ENABLED', 'BACKOFFICE_POS_DAY_ENABLED',
    'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED', 'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
    'BACKOFFICE_STAFF_POSITIONS_ENABLED', 'BACKOFFICE_DISCOUNTS_ENABLED',
    'BACKOFFICE_MANUAL_REFUNDS_ENABLED', 'BACKOFFICE_SUPPLY_ENABLED',
    'BACKOFFICE_STOCK_REPORTS_ENABLED', 'BACKOFFICE_STAFF_ASSIGNMENT_ENABLED',
)
JOBS = frozenset((
    'Foundation static checks and transaction invariants',
    'Foundation POS and backoffice integration',
    'Foundation mobile bundles and checkout recovery',
    'Foundation simulator browser regressions',
    'Foundation server account and Kaspi fixtures',
    'Build, contracts and PostgreSQL integration',
    'iPad kiosk state, bundles and browser recovery',
    'Private staging image and restricted database role',
    'Local kitchen UI and recovery',
    'Cloud-edge fulfillment transport and recovery',
    'Design screens and interaction smoke',
))


class Stop(RuntimeError):
    """Stable check identifier only, never rejected configuration values."""


def require(ok, check):
    if not ok:
        raise Stop(check)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'compose.duplicate_key')
        result[key] = value
    return result


def candidate_gate(sha, published_sha, pr, run, jobs, merged_ancestor):
    """GitHub REST objects plus an independently checked git ancestry result.

    Caller must fetch fresh refs/API data; stored JSON is evidence, not authority
    to skip rechecking this gate immediately before the live window.
    """
    require(isinstance(sha, str) and re.fullmatch('[a-f0-9]{40}', sha)
            and sha != BASELINE, 'candidate.sha')
    require(sha == published_sha, 'candidate.published_head')
    require(pr.get('number') == 343 and pr.get('merged') is True
            and pr.get('base', {}).get('ref') == BRANCH
            and pr.get('base', {}).get('repo', {}).get('full_name') == REPO
            and re.fullmatch('[a-f0-9]{40}', pr.get('merge_commit_sha') or '')
            and merged_ancestor is True, 'candidate.pr343_merged_ancestor')
    require(run.get('head_sha') == sha and run.get('head_branch') == BRANCH
            and run.get('head_repository', {}).get('full_name') == REPO
            and run.get('path') == '.github/workflows/ci.yml'
            and run.get('event') == 'push'
            and run.get('status') == 'completed'
            and run.get('conclusion') == 'success', 'candidate.foundation_run')
    rows = jobs.get('jobs', [])
    require(jobs.get('total_count') == len(JOBS) == len(rows)
            and {row.get('name') for row in rows} == JOBS
            and all(row.get('run_id') == run.get('id')
                    and row.get('head_sha') == sha
                    and row.get('status') == 'completed'
                    and row.get('conclusion') == 'success' for row in rows),
            'candidate.foundation_all_jobs')
    return {'candidate': sha, 'foundationRun': run['id'], 'jobs': len(rows)}


def resolved_compose(data, sha):
    """Support only the exact installed JSON baseline; never repair unknown input."""
    require(digest(data) == COMPOSE_SHA, 'compose.baseline_sha256')
    require(isinstance(sha, str) and re.fullmatch('[a-f0-9]{40}', sha)
            and sha != BASELINE, 'compose.candidate_sha')
    try:
        original = json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Stop('compose.json') from None
    require(isinstance(original, dict), 'compose.object')
    services = original.get('services', {})
    require(isinstance(services, dict)
            and set(services) == {'api', 'cloud-db', 'redis-cache'}, 'compose.services')
    api = services['api']
    require(isinstance(api, dict), 'compose.api')
    require(api.get('image') == 'pickchick-api:' + BASELINE, 'compose.baseline_image')
    env = api.get('environment')
    require(isinstance(env, dict) and 'RELEASE_SHA' not in env, 'compose.environment')
    require(not any(key in env for key in FLAGS), 'compose.flags_already_present')
    result = copy.deepcopy(original)
    result['services']['api']['image'] = 'pickchick-api:' + sha
    result['services']['api']['environment'].update({key: 'false' for key in FLAGS})
    restored = copy.deepcopy(result)
    restored['services']['api']['image'] = api['image']
    for key in FLAGS:
        del restored['services']['api']['environment'][key]
    require(restored == original, 'compose.unrelated_change')
    return (json.dumps(result, indent=2) + '\n').encode()


def github_gate(gh, repo_dir):
    """Fetch current remote evidence; no merge, CI rerun, or server operation."""
    def api(path):
        result = subprocess.run([gh, 'api', 'repos/' + REPO + '/' + path],
                                capture_output=True, text=True, timeout=60)
        require(result.returncode == 0, 'candidate.github_read')
        return json.loads(result.stdout)

    def git(*args):
        return subprocess.run(['git', '-C', str(repo_dir), *args],
                              capture_output=True, text=True, timeout=60)

    branch_path = 'git/ref/heads/' + BRANCH
    sha = api(branch_path)['object']['sha']
    pr = api('pulls/343')
    require(pr.get('merged') is True, 'candidate.pr343_not_merged')
    require(git('fetch', 'origin', 'refs/heads/' + BRANCH).returncode == 0,
            'candidate.fetch')
    remote = git('rev-parse', 'FETCH_HEAD')
    require(remote.returncode == 0 and remote.stdout.strip() == sha,
            'candidate.published_head')
    merge = pr.get('merge_commit_sha') or ''
    require(re.fullmatch('[a-f0-9]{40}', merge), 'candidate.merge_sha')
    ancestor = git('merge-base', '--is-ancestor', merge, sha).returncode == 0
    runs = api('actions/workflows/ci.yml/runs?head_sha=' + sha + '&event=push&per_page=100')
    choices = [r for r in runs.get('workflow_runs', []) if r.get('head_branch') == BRANCH]
    require(bool(choices), 'candidate.foundation_missing')
    run = api('actions/runs/' + str(max(choices, key=lambda r: r['id'])['id']))
    jobs = api('actions/runs/' + str(run['id']) + '/jobs?filter=latest&per_page=100')
    result = candidate_gate(sha, sha, pr, run, jobs, ancestor)
    require(api(branch_path)['object']['sha'] == sha, 'candidate.published_head_changed')
    return {'status': 'CANDIDATE_GATE_ONLY', **result, 'deployed': False,
            'rehearsalVerified': False, 'liveWindowVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-github', action='store_true')
    parser.add_argument('--gh', default='gh')
    parser.add_argument('--repo-dir', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--compose', type=Path)
    parser.add_argument('--candidate')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    try:
        if args.check_github:
            require(not any((args.compose, args.candidate, args.out)), 'candidate.mode')
            print(json.dumps(github_gate(args.gh, args.repo_dir)))
            return 0
        require(all((args.compose, args.candidate, args.out)), 'compose.arguments')
        require(args.compose.is_file() and not args.compose.is_symlink()
                and args.compose.stat().st_mode & 0o077 == 0, 'compose.protected_input')
        data = resolved_compose(args.compose.read_bytes(), args.candidate)
        # O_EXCL prevents overwrite and following a symlink at the destination.
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
        print(json.dumps({'status': 'PREPARED_ONLY', 'composeBefore': COMPOSE_SHA,
                          'composeAfter': digest(data), 'candidate': args.candidate,
                          'disabledFlags': list(FLAGS), 'deployed': False}))
    except Stop as error:
        print(json.dumps({'status': 'STOP', 'check': str(error)}))
        return 1
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({'status': 'STOP', 'check': 'compose.input_or_output'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
