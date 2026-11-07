import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('links', Path(__file__).resolve().parents[2]/'infra/staging/auth-links-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class Links(unittest.TestCase):
    def fixture(self):
        return json.dumps({'services': {'api': {'image': 'pinned', 'environment': {
            **{k:r.OLD+v for k,v in r.KEYS.items()}, 'UNRELATED': 'unchanged'}},
            'worker': {'image':'same-worker'}}}, indent=2).encode()+b'\n'

    def test_exact_two_lines_and_unchanged_other_bytes(self):
        raw = self.fixture()
        new = r.candidate(raw, r.digest(raw))
        self.assertEqual(new.replace(r.NEW.encode(), r.OLD.encode()), raw)
        self.assertEqual(sum(a!=b for a,b in zip(raw.splitlines(),new.splitlines())),2)

    def test_drift_duplicate_replay_other_service_and_minified_refused(self):
        raw = self.fixture()
        cases = [raw.replace(b'unchanged', b'drift'),
                 raw.replace(b'"image": "pinned"', b'"image":"x","image":"pinned"'),
                 raw.replace(r.OLD.encode(),r.NEW.encode()),
                 raw.replace(b'same-worker', (r.OLD+'terms').encode()),
                 json.dumps(json.loads(raw)).encode()]
        for bad in cases:
            with self.subTest(), self.assertRaises((ValueError, KeyError)):
                r.candidate(bad, r.digest(raw) if b'drift' in bad else r.digest(bad))


if __name__ == '__main__': unittest.main()
