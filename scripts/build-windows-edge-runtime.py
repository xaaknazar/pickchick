#!/usr/bin/env python3
"""Build an isolated Windows edge application ZIP from a clean, built source tree.

Node/PostgreSQL/WinSW and secrets are installed separately. This command builds
workspace packages, closes their production dependency graph without symlinks,
and preserves version conflicts in nested directories. No pnpm store is shipped.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import zipfile

ADMIN_FILES = (
    'infra/windows/native-fulfillment-worker.mjs',
    'infra/windows/native-device-access-worker.mjs',
    'infra/windows/terminal-access-grants.mjs',
    'infra/windows/native-pos-sync-worker.mjs',
    'infra/windows/native-pos-sync-permissions.ps1',
    'infra/windows/fulfillment-worker-grants.mjs',
    'infra/windows/native-menu-sync-worker.mjs',
    'infra/windows/menu-sync-worker-grants.mjs',
    'infra/windows/menu-sync-upgrade-db.mjs',
    'infra/windows/remote-stops-upgrade-db.mjs',
    'infra/windows/remote-stops-upgrade.md',
    'infra/windows/native-menu-sync.md',
    'scripts/edge-migrate.mjs',
    'scripts/edge-runtime-grants.mjs',
    'scripts/staff-setup.mjs',
    'scripts/staff-password-setup.mjs',
    'scripts/staff-pin-setup.mjs',
    'scripts/hidden-password.mjs',
    'scripts/local-pos-service.mjs',
    'scripts/local-pos-operator-plan.mjs',
    'scripts/local-pos-catalog-upgrade.mjs',
    'scripts/local-pos-draft.mjs',
    'infra/windows/local-pos-draft-catalog.json',
    'infra/windows/local-pos-draft-catalog-v2.json',
    'infra/windows/local-pos-operator-plan.md',
    'scripts/staff-revoke.mjs',
    'scripts/staff-credential.mjs',
    'scripts/staff-file-permissions.mjs',
    'infra/windows/edge-runtime-grants.mjs',
    'infra/windows/README.md',
    'infra/windows/native-staff-login.md',
    'infra/windows/local-pos-service.md',
    'infra/windows/runtime-package.md',
    'infra/windows/PickChickEdge.xml.example',
)


# Build every root shipped by build_package, including packages not reachable from edge.
BUILD_ROOTS = ('@pickchick/edge', '@pickchick/pos-order-sync', '@pickchick/fulfillment-transport')


def build_workspace_roots(source):
    command = ['pnpm']
    for name in BUILD_ROOTS:
        command.extend(['--filter', name + '...'])
    subprocess.run([*command, 'build'], cwd=source, check=True)


def build_package(source, output, commit):
    source = source.resolve()
    output = output.resolve()
    if output.exists() or output.with_suffix('.zip').exists():
        raise ValueError('Output directory and ZIP must not exist')
    root = (source / 'services/edge').resolve()
    graph = {}
    # Operator sync services run separately but share the isolated package tree.
    queue = collections.deque([root, (source / 'packages/pos-order-sync').resolve(),
                               (source / 'packages/fulfillment-transport').resolve()])

    def resolve_package(start, name):
        for parent in [start, *start.parents]:
            candidate = parent / 'node_modules' / name
            if (candidate / 'package.json').is_file():
                resolved = candidate.resolve()
                if not resolved.is_relative_to(source):
                    raise ValueError(f'Dependency escapes source checkout: {name}')
                return resolved
        return None

    while queue:
        path = queue.popleft()
        if path in graph:
            continue
        package = json.loads((path / 'package.json').read_text())
        node = graph[path] = {'name': package['name'], 'version': package['version'], 'edges': {}}
        optional_peers = {name for name, meta in package.get('peerDependenciesMeta', {}).items()
                          if meta.get('optional')}
        names = set(package.get('dependencies', {})) | set(package.get('peerDependencies', {}))
        names |= set(package.get('optionalDependencies', {}))
        for name in sorted(names):
            dependency = resolve_package(path, name)
            if dependency is None:
                if name in optional_peers or name in package.get('optionalDependencies', {}):
                    continue
                raise SystemExit(f'Missing required dependency: {package["name"]} -> {name}')
            if name in optional_peers:
                continue
            node['edges'][name] = dependency
            queue.append(dependency)

    placements = {}
    pending = collections.deque()

    def copy_package(path, destination):
        destination.mkdir(parents=True)
        package = graph[path]
        if package['name'].startswith('@pickchick/'):
            if not (path / 'dist').is_dir():
                raise SystemExit(f'Build required for {package["name"]}')
            shutil.copy2(path / 'package.json', destination / 'package.json')
            shutil.copytree(path / 'dist', destination / 'dist', symlinks=True)
            for name in ('LICENSE', 'LICENSE.md', 'LICENSE.txt'):
                if (path / name).is_file():
                    shutil.copy2(path / name, destination / name)
        else:
            for child in path.iterdir():
                if child.name == 'node_modules':
                    continue
                if child.is_symlink():
                    raise SystemExit(f'Unexpected package symlink: {child}')
                target = destination / child.name
                if child.is_dir():
                    shutil.copytree(child, target, symlinks=True)
                elif child.is_file():
                    shutil.copy2(child, target)
        placements[destination] = path
        pending.append(destination)

    copy_package(root, output)
    selected = {}
    for path, package in graph.items():
        if path != root and package['name'] not in selected:
            selected[package['name']] = path
            copy_package(path, output / 'node_modules' / package['name'])

    def installed_at(start, name):
        for parent in [start, *start.parents]:
            if not parent.is_relative_to(output):
                break
            candidate = parent / 'node_modules' / name
            if candidate in placements:
                return candidate
        return None

    while pending:
        destination = pending.popleft()
        package = graph[placements[destination]]
        for name, dependency in package['edges'].items():
            installed = installed_at(destination, name)
            if installed is None or placements[installed] != dependency:
                target = destination / 'node_modules' / name
                if target in placements:
                    raise SystemExit(f'Conflicting dependency placement: {target}')
                copy_package(dependency, target)

    for destination, path in placements.items():
        for name, dependency in graph[path]['edges'].items():
            installed = installed_at(destination, name)
            if installed is None or placements[installed] != dependency:
                raise SystemExit('Dependency closure validation failed')

    for relative in ADMIN_FILES:
        original = source / relative
        if not original.is_file() or original.is_symlink():
            raise ValueError(f'Missing or unsafe administration file: {relative}')
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
    migrations = source / 'db/edge/migrations'
    if not migrations.is_dir() or not list(migrations.glob('*.sql')):
        raise ValueError('Edge migrations are required')
    shutil.copytree(migrations, output / 'db/edge/migrations', symlinks=True)
    files = []
    casefold_names = set()
    for file in sorted(output.rglob('*')):
        relative = file.relative_to(output).as_posix()
        if file.is_symlink():
            raise SystemExit(f'Unexpected output symlink: {relative}')
        for part in pathlib.PurePosixPath(relative).parts:
            if re.search(r'[<>:"\\|?*]', part) or part.endswith((' ', '.')):
                raise SystemExit(f'Windows-unsafe path: {relative}')
            if re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?', part):
                raise SystemExit(f'Windows reserved path: {relative}')
        if relative.casefold() in casefold_names:
            raise SystemExit(f'Case-insensitive path collision: {relative}')
        casefold_names.add(relative.casefold())
        if file.suffix.lower() in ('.node', '.dll', '.so', '.dylib', '.exe'):
            raise SystemExit(f'Native executable requires separate target build: {relative}')
        if file.is_file():
            if file.suffix == '.map':
                try:
                    mapping = json.loads(file.read_text())
                except (ValueError, UnicodeError):
                    mapping = {}
                paths = [mapping.get('sourceRoot', ''), *mapping.get('sources', [])]
                if any(isinstance(path, str) and (path.startswith(('/', 'file:')) or
                       re.match(r'^[A-Za-z]:', path)) for path in paths):
                    raise SystemExit(f'Absolute build path in source map: {relative}')
            data = file.read_bytes()
            files.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    manifest = {
        'format': 'pickchick-edge-runtime-v1', 'sourceCommit': commit,
        'target': 'windows-x64', 'node': '>=24.16.0 <25',
        'runtimeAcceptance': 'not_tested_on_windows_by_packager',
        'dependencies': [{**{key: graph[path][key] for key in ('name', 'version')},
                          'path': destination.relative_to(output).as_posix()}
                         for destination, path in placements.items()],
        'dependencyEdgesValidated': sum(len(graph[path]['edges']) for path in placements.values()),
        'symlinks': 0, 'nativeAddons': 0,
        'longestRelativePath': max(len(file['path'].encode('utf-16-le')) // 2 for file in files),
        'maximumExtractionPrefixLength': 258 - max(len(file['path'].encode('utf-16-le')) // 2 for file in files),
        'files': files,
    }
    (output / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    archive = output.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                info = zipfile.ZipInfo(file.relative_to(output).as_posix(), (1980, 1, 1, 0, 0, 0))
                info.create_system = 0
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, file.read_bytes(), compresslevel=6)
    return {'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                      'packagePlacements': len(placements), 'files': len(files),
                      'edges': manifest['dependencyEdgesValidated'],
                      'longestRelativePath': manifest['longestRelativePath']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    status = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)
    if status.strip():
        raise SystemExit('Commit source changes before creating a pinned package')
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    build_workspace_roots(source)
    print(json.dumps(build_package(source, args.output, commit), indent=2))
