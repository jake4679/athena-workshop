#!/usr/bin/env python3
import csv
import json
import sys
from pathlib import Path

import pandas as pd


def normalize_rows(rows, columns):
  if not isinstance(rows, list):
    return []

  if (
    isinstance(columns, list)
    and len(columns) > 0
    and len(rows) > 0
    and isinstance(rows[0], list)
    and len(rows[0]) == len(columns)
    and all((rows[0][i] == columns[i]) for i in range(len(columns)))
  ):
    return rows[1:]

  return rows


def rows_to_records(rows, columns):
  records = []
  for row in rows:
    if not isinstance(row, list):
      row = []
    record = {}
    for idx, column in enumerate(columns):
      value = row[idx] if idx < len(row) else None
      record[str(column)] = value
    records.append(record)
  return records


def write_csv(output_path, columns, rows):
  with output_path.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(columns)
    for row in rows:
      writer.writerow([(row[idx] if idx < len(row) else None) for idx in range(len(columns))])


def write_excel(output_path, columns, rows):
  records = rows_to_records(rows, columns)
  frame = pd.DataFrame(records, columns=columns)
  frame.to_excel(output_path, index=False, engine="openpyxl")


def write_parquet(output_path, columns, rows):
  records = rows_to_records(rows, columns)
  frame = pd.DataFrame(records, columns=columns)
  frame.to_parquet(output_path, index=False)


def main():
  if len(sys.argv) != 4:
    print("Usage: export_results.py <input_json> <format> <output_file>", file=sys.stderr)
    return 2

  input_path = Path(sys.argv[1])
  fmt = sys.argv[2].strip().lower()
  output_path = Path(sys.argv[3])

  with input_path.open("r", encoding="utf-8") as f:
    payload = json.load(f)

  columns = payload.get("columns")
  if not isinstance(columns, list):
    columns = []
  columns = [str(c) for c in columns]

  rows = normalize_rows(payload.get("rows"), columns)

  output_path.parent.mkdir(parents=True, exist_ok=True)

  if fmt == "csv":
    write_csv(output_path, columns, rows)
  elif fmt in ("excel", "xlsx"):
    write_excel(output_path, columns, rows)
  elif fmt == "parquet":
    write_parquet(output_path, columns, rows)
  else:
    print(f"Unsupported format: {fmt}", file=sys.stderr)
    return 2

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
