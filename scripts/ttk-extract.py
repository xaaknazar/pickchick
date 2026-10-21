#!/usr/bin/env python3
"""Read iiko printed technological cards from XLS. Requires xlrd==2.0.2.

No workbook edits, network access, formula evaluation or production writes.
Output retains source hashes, rows, quantities and gross/net/finished weights.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path


def parse_rows(rows, filename, digest, sheet):
    starts = [i for i, r in enumerate(rows)
              if str(r[0]).startswith("Технологическая карта №")]
    if not starts:
        raise ValueError("No technological cards found")
    result = []
    for index, start in enumerate(starts):
        end = starts[index + 1] - 1 if index + 1 < len(starts) else len(rows)
        code = str(rows[start][0]).split("№", 1)[1].strip()
        name = str(rows[start - 1][0]).strip()
        if not re.fullmatch(r"\d{1,12}", code) or not name:
            raise ValueError("Invalid card identity")
        card = dict(file=filename, sha256=digest, sheet=sheet, row=start + 1,
                    code=code, name=name, date=str(rows[start + 2][0]).strip(),
                    lines=[])
        header = False
        for i in range(start + 3, end):
            r = rows[i]
            if r[0] == "№":
                if r[5:7] != ["Ед. изм.", "Брутто в ед. изм."]:
                    raise ValueError(f"Unknown table columns: {code}")
                header = True
            if str(r[0]).isdigit() and r[1]:
                if not header or r[5] not in ("кг", "л", "шт", "порц"):
                    raise ValueError(f"Unknown ingredient/unit: {code}:{i+1}")
                card["lines"].append(dict(
                    row=i + 1, name=str(r[1]).strip(), unit=r[5], quantity=r[6],
                    grossKg=r[8], netKg=r[10], readyKg=r[12],
                    technology=r[13]))
            elif str(r[0]).startswith("вес готового блюда"):
                if "batch" in card:
                    raise ValueError("Duplicate batch")
                card["batch"] = r[9]
            elif r[16] != "":
                if "output" in card:
                    raise ValueError("Duplicate output")
                card["output"] = dict(value=r[16], unit=r[17], row=i + 1)
        if not header or "batch" not in card or "output" not in card:
            raise ValueError(f"Incomplete card: {code}")
        result.append(card)
    return result


def extract(paths):
    import xlrd
    sources, recipes = [], []
    for path in paths:
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        book = xlrd.open_workbook(file_contents=raw)
        sources.append(dict(file=path.name, sha256=digest))
        for sheet in book.sheets():
            if sheet.nrows == 0:
                continue
            if sheet.ncols != 18:
                raise ValueError(f"Expected 18 columns: {path.name}/{sheet.name}")
            recipes.extend(parse_rows(
                [sheet.row_values(i) for i in range(sheet.nrows)],
                path.name, digest, sheet.name))
    if len({r["code"] for r in recipes}) != len(recipes):
        raise ValueError("Duplicate card numbers; reconcile versions explicitly")
    return dict(version=1, sources=sources, recipes=recipes)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    data = extract(args.files)
    # Exclusive creation prevents overwriting the evidence of an earlier import.
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
    args.output.chmod(0o600)
    print(json.dumps({"sources": len(data["sources"]), "cards": len(data["recipes"])}))
