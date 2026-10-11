import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('roadmap_package', Path(__file__).with_name('package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class RoadmapPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        self.source = self.root / 'source.json'
        self.source.write_text('{"tasks": []}\n')
        self.head = 'a' * 40
        self.meta = {'sourceSha': self.head,
                     'dataHash': hashlib.sha256(self.source.read_bytes()).hexdigest()}

    def write_build(self, meta):
        (self.dist / 'project.json').write_text(json.dumps({'meta': meta}))

    def test_current_commit_and_exact_data_are_accepted(self):
        self.write_build(self.meta)
        package.validate_build(self.dist, self.source, self.head)

    def test_previous_commit_is_rejected_even_when_project_data_is_unchanged(self):
        self.write_build({**self.meta, 'sourceSha': 'b' * 40})
        with self.assertRaisesRegex(ValueError, 'build source differs'):
            package.validate_build(self.dist, self.source, self.head)

    def test_stale_project_data_is_rejected_even_with_current_commit(self):
        self.write_build(self.meta)
        self.source.write_text('{"tasks": [{"id": "updated"}]}\n')
        with self.assertRaisesRegex(ValueError, 'build data differs'):
            package.validate_build(self.dist, self.source, self.head)

    def test_missing_metadata_is_rejected(self):
        self.write_build(None)
        with self.assertRaisesRegex(ValueError, 'build source differs'):
            package.validate_build(self.dist, self.source, self.head)

    def test_invalid_json_is_rejected(self):
        (self.dist / 'project.json').write_text('{')
        with self.assertRaises(ValueError):
            package.validate_build(self.dist, self.source, self.head)


if __name__ == '__main__':
    unittest.main()
