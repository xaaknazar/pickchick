import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "ttk_extract", Path(__file__).parents[2] / "scripts/ttk-extract.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    rows = [[""] * 18 for _ in range(16)]
    rows[0][0] = "Test dish"
    rows[1][0] = "Технологическая карта № 001"
    rows[3][0] = "01.10.2026"
    rows[9][0] = "№"
    rows[9][5:7] = ["Ед. изм.", "Брутто в ед. изм."]
    rows[10][0:2] = ["1", "Raw"]
    rows[10][5:7] = ["кг", 0.025]
    rows[10][8] = 0.025
    rows[10][10] = 0.022
    rows[10][12] = 0.020
    rows[13][0] = "вес готового блюда (изделия) в расчете на"
    rows[13][9] = "1,000 порц"
    rows[14][16:18] = [0.020, "кг"]
    return rows


class ExtractTest(unittest.TestCase):
    def test_preserves_separate_weights_and_accounting_units(self):
        result = module.parse_rows(fixture(), "fixture.xls", "a" * 64, "Page 1")[0]
        self.assertEqual(result["code"], "001")
        self.assertEqual(result["row"], 2)
        self.assertEqual(result["lines"][0]["quantity"], 0.025)
        self.assertEqual(result["lines"][0]["netKg"], 0.022)
        self.assertEqual(result["lines"][0]["readyKg"], 0.020)

    def test_fails_closed_for_changed_columns_or_missing_output(self):
        rows = fixture()
        rows[9][6] = "Unknown"
        with self.assertRaises(ValueError):
            module.parse_rows(rows, "fixture.xls", "a" * 64, "Page 1")
        rows = fixture()
        rows[14][16] = ""
        with self.assertRaises(ValueError):
            module.parse_rows(rows, "fixture.xls", "a" * 64, "Page 1")


if __name__ == "__main__":
    unittest.main()
