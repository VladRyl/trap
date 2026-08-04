#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="./data"
BACKUP_DIR="./backups"

mkdir -p "$BACKUP_DIR"

docker run --rm -i \
  -v "$DATA_DIR:/data:ro" \
  -v "$BACKUP_DIR:/backups" \
  python:3.11-slim python - <<'PY'
from __future__ import annotations

import datetime
import gzip
import os
import shutil
import sqlite3
from pathlib import Path

SOURCE = Path("/data/trap.sqlite3")
BACKUP_DIR = Path("/backups")
KEEP_COUNT = 56  # 14 днів при backup кожні 6 годин

if not SOURCE.exists():
    raise SystemExit(f"Database not found: {SOURCE}")

BACKUP_DIR.mkdir(parents=True, exist_ok=True)

timestamp = datetime.datetime.now(
    datetime.timezone.utc
).strftime("%Y%m%dT%H%M%SZ")

temp_path = BACKUP_DIR / f".trap-{timestamp}.sqlite3.tmp"
database_path = BACKUP_DIR / f"trap-{timestamp}.sqlite3"
compressed_path = BACKUP_DIR / f"trap-{timestamp}.sqlite3.gz"

# Відкриваємо робочу базу лише для читання.
source = sqlite3.connect(
    f"file:{SOURCE}?mode=ro",
    uri=True,
    timeout=30,
)

destination = sqlite3.connect(temp_path, timeout=30)

try:
    source.backup(destination)
finally:
    destination.close()
    source.close()

# Перевіряємо цілісність створеної копії.
check = sqlite3.connect(temp_path)

try:
    result = check.execute("PRAGMA integrity_check").fetchone()
finally:
    check.close()

if not result or result[0] != "ok":
    temp_path.unlink(missing_ok=True)
    raise SystemExit(f"Backup integrity check failed: {result}")

os.replace(temp_path, database_path)

# Стискаємо копію.
with database_path.open("rb") as source_file:
    with gzip.open(compressed_path, "wb", compresslevel=6) as output_file:
        shutil.copyfileobj(source_file, output_file)

database_path.unlink()

# Залишаємо тільки останні KEEP_COUNT копій.
backups = sorted(
    BACKUP_DIR.glob("trap-*.sqlite3.gz"),
    key=lambda path: path.stat().st_mtime,
    reverse=True,
)

for old_backup in backups[KEEP_COUNT:]:
    old_backup.unlink()

print(f"Backup created: {compressed_path}")
PY