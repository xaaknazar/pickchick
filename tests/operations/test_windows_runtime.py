"""Regression guards for the real Windows runtime dependency boundary."""
import collections
import importlib.util
import json
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'windows_runtime_builder', ROOT / 'scripts/build-windows-edge-runtime.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class WindowsRuntimeBoundaryTests(unittest.TestCase):
    def test_builds_all_shipped_roots_and_their_dependencies(self):
        with mock.patch.object(builder.subprocess, 'run') as run:
            builder.build_workspace_roots(ROOT)
        run.assert_called_once_with([
            'pnpm', '--filter', '@pickchick/edge...',
            '--filter', '@pickchick/pos-order-sync...',
            '--filter', '@pickchick/fulfillment-transport...', 'build',
        ], cwd=ROOT, check=True)

    def test_image_encoder_is_api_only_in_real_workspace_dependency_graph(self):
        packages = {}
        for directory in ('packages', 'services', 'apps'):
            for path in (ROOT / directory).glob('*/package.json'):
                package = json.loads(path.read_text())
                packages[package['name']] = package
        self.assertEqual(packages['@pickchick/api']['dependencies']['sharp'], '0.35.5')
        visited = set()
        queue = collections.deque((name, [name]) for name in builder.BUILD_ROOTS)
        while queue:
            name, route = queue.popleft()
            if name in visited:
                continue
            visited.add(name)
            self.assertNotIn(name, ('sharp', '@pickchick/api'), ' -> '.join(route))
            package = packages.get(name)
            if package is None:
                continue
            dependencies = (set(package.get('dependencies', {})) |
                            set(package.get('optionalDependencies', {})) |
                            set(package.get('peerDependencies', {})))
            queue.extend((dependency, [*route, dependency]) for dependency in dependencies)
        # Exercise the known production route, not a disconnected edge-only fixture.
        self.assertIn('@pickchick/commerce-core', visited)
        self.assertIn('@pickchick/catalog-admin', visited)


if __name__ == '__main__':
    unittest.main()
