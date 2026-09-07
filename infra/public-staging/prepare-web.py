"""Build a pinned operations SPA and package only public runtime design assets."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[2]
    assert re.fullmatch('[a-f0-9]{40}', args.source_sha)
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    assert sha == args.source_sha, 'Build must use the named source commit'
    dirty = subprocess.check_output([
        'git', 'status', '--porcelain', '--untracked-files=all', '--',
        'apps/operations', 'apps/backoffice', 'design/prototype', 'packages/design-tokens',
        'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    ], cwd=repo, text=True)
    assert not dirty, 'Commit the operations build inputs before packaging'
    output = args.output.resolve()
    assert not output.exists(), 'Output must be a new directory'
    subprocess.run(['pnpm', '--filter', '@pickchick/operations', 'build'], cwd=repo, check=True)
    subprocess.run(['pnpm', '--filter', '@pickchick/backoffice', 'build'], cwd=repo, check=True)
    output.mkdir(parents=True, mode=0o755)
    hashes = {}

    def copy(source, relative):
        assert source.is_file() and not source.is_symlink()
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()

    extensions = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.mp4'}
    dist = repo / 'apps/operations/dist'
    assert (dist / 'index.html').is_file()
    for source in dist.rglob('*'):
        if source.is_file() and source.suffix in extensions:
            copy(source, pathlib.Path('operations') / source.relative_to(dist))
    backoffice = repo / 'apps/backoffice/dist'
    assert (backoffice / 'index.html').is_file()
    for source in backoffice.rglob('*'):
        if source.is_file() and source.suffix in extensions:
            copy(source, pathlib.Path('backoffice') / source.relative_to(backoffice))
    prototype = pathlib.Path('design/prototype')
    names = [
        'index.html', 'app.js', 'ui.js', 'views.js', 'screens.json', 'styles.css',
        'reference-fonts.css', 'reference-mobile.css', 'reference-mobile.js',
        'reference-kiosk.css', 'reference-kiosk.js', 'reference-operations.css',
        'reference-operations.js',
    ]
    for name in names:
        copy(repo / prototype / name, prototype / name)
    # provenance.json includes source-machine paths and is not a runtime asset.
    for source in (repo / prototype / 'assets').rglob('*'):
        if source.is_file() and source.suffix in extensions - {'.html', '.js', '.css'}:
            copy(source, source.relative_to(repo))
    for name in ['tokens.css', 'tokens.json']:
        relative = pathlib.Path('packages/design-tokens') / name
        copy(repo / relative, relative)
    (output / '.release.json').write_text(json.dumps({'source_sha': sha, 'files': hashes}, indent=2) + '\n')
    print(json.dumps({'event': 'public_web_prepared', 'source_sha': sha, 'files': len(hashes), 'output': str(output)}))


if __name__ == '__main__':
    main()
