#!/usr/bin/env python3
"""Package a verified operations build without rebuilding other deployed web apps.

This command packages an already built dist; the operator must build/test the named
source first. It never contacts a server or switches a running gateway.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess


PUBLIC_EXTENSIONS = {
    '.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp',
    '.avif', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.json',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def public_path(root, relative):
    path = PurePosixPath(relative)
    assert not path.is_absolute() and '..' not in path.parts and str(path) == relative
    assert path.parts and path.parts[0] in ('operations', 'backoffice', 'design', 'packages')
    assert not any(part.startswith('.') for part in path.parts)
    target = root.joinpath(*path.parts)
    assert target.is_file() and not target.is_symlink(), relative
    assert all(not parent.is_symlink() for parent in target.parents if parent != root.parent)
    assert target.suffix in PUBLIC_EXTENSIONS, relative
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--base-web', required=True, type=Path)
    parser.add_argument('--expected-base-source-sha', required=True)
    parser.add_argument('--expected-base-manifest-sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    assert re.fullmatch('[a-f0-9]{40}', args.source_sha)
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == args.source_sha
    assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo, text=True), 'Commit source and remove temporary dependency links first'
    base = args.base_web.resolve()
    assert re.fullmatch('[a-f0-9]{64}', args.expected_base_manifest_sha256)
    assert digest(base / '.release.json') == args.expected_base_manifest_sha256, 'Base manifest changed'
    manifest = json.loads((base / '.release.json').read_text())
    assert re.fullmatch('[a-f0-9]{40}', manifest['source_sha'])
    assert manifest['source_sha'] == args.expected_base_source_sha, 'Unexpected base release'
    files = manifest['files']
    assert files and 'operations/index.html' in files
    for relative, expected in files.items():
        assert re.fullmatch('[a-f0-9]{64}', expected)
        assert digest(public_path(base, relative)) == expected, relative

    dist = repo / 'apps/operations/dist'
    assert dist.is_dir() and not dist.is_symlink() and (dist / 'index.html').is_file()
    additions = {}
    for path in dist.rglob('*'):
        assert not path.is_symlink(), 'Dist must not contain symlinks'
        if path.is_file():
            relative = 'operations/' + path.relative_to(dist).as_posix()
            assert path.suffix in PUBLIC_EXTENSIONS - {'.json'}, 'Unexpected dist file: ' + relative
            assert not any(part.startswith('.') for part in path.relative_to(dist).parts)
            assert relative == 'operations/index.html' or relative not in files or digest(path) == files[relative], 'Existing asset name has different bytes: ' + relative
            additions[relative] = path
    assert 'operations/index.html' in additions

    output = args.output.resolve()
    assert output != base and base not in output.parents and output not in base.parents
    output.mkdir(parents=True, exist_ok=False)
    output.chmod(0o755)

    def copy(source, relative):
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)

    # Retain old hashed assets so an already open tab can finish reading them.
    for relative in files:
        copy(base / relative, relative)
    for relative, source in additions.items():
        copy(source, relative)
    hashes = {relative: digest(output / relative) for relative in files.keys() | additions.keys()}
    assert all(hashes[name] == value for name, value in files.items() if not name.startswith('operations/'))
    components = dict(manifest.get('component_sources', {}))
    for name in ('operations', 'backoffice', 'design', 'packages'):
        components.setdefault(name, manifest['source_sha'])
    components['operations'] = args.source_sha
    result = {
        'source_sha': args.source_sha,
        'base_source_sha': manifest['source_sha'],
        'component_sources': components,
        'files': dict(sorted(hashes.items())),
    }
    (output / '.release.json').write_text(json.dumps(result, indent=2) + '\n')
    (output / '.release.json').chmod(0o644)
    for directory in output.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    print(json.dumps({'event': 'operations_overlay_packaged', 'source_sha': args.source_sha,
                      'base_source_sha': manifest['source_sha'], 'files': len(hashes),
                      'operations_build_files': len(additions)}))


if __name__ == '__main__':
    main()
