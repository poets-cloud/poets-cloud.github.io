from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "poetry.db"


def main() -> None:
    if not DB_PATH.exists():
        raise RuntimeError(f"Database does not exist: {DB_PATH}")

    connection = sqlite3.connect(DB_PATH)
    connection.execute("PRAGMA foreign_keys=ON")
    objects = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        )
    }
    required = {"metadata", "dynasties", "authors", "works", "works_fts"}
    missing = sorted(required - objects)
    if missing:
        raise RuntimeError(f"Missing database objects: {', '.join(missing)}")

    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"SQLite integrity check failed: {integrity}")

    metadata = dict(connection.execute("SELECT key, value FROM metadata"))
    work_count = connection.execute("SELECT COUNT(*) FROM works").fetchone()[0]
    author_count = connection.execute("SELECT COUNT(*) FROM authors").fetchone()[0]
    orphan_authors = connection.execute(
        "SELECT COUNT(*) FROM works w LEFT JOIN authors a ON a.id=w.author_id WHERE a.id IS NULL"
    ).fetchone()[0]
    orphan_dynasties = connection.execute(
        "SELECT COUNT(*) FROM works w LEFT JOIN dynasties d ON d.id=w.dynasty_id WHERE d.id IS NULL"
    ).fetchone()[0]
    invalid_json = connection.execute(
        "SELECT COUNT(*) FROM works WHERE NOT json_valid(lines_json) OR NOT json_valid(tags_json)"
    ).fetchone()[0]
    duplicate_ids = connection.execute(
        "SELECT COUNT(*) FROM (SELECT id FROM works GROUP BY id HAVING COUNT(*) > 1)"
    ).fetchone()[0]

    expected_count = int(metadata.get("work_count", "0"))
    checks = {
        "metadataCountMatches": expected_count == work_count,
        "noOrphanAuthors": orphan_authors == 0,
        "noOrphanDynasties": orphan_dynasties == 0,
        "validJson": invalid_json == 0,
        "uniqueIds": duplicate_ids == 0,
    }
    failed = [name for name, passed in checks.items() if not passed]
    connection.close()
    if failed:
        raise RuntimeError(f"Database validation failed: {', '.join(failed)}")

    print(
        json.dumps(
            {
                "integrity": integrity,
                "works": work_count,
                "authors": author_count,
                "checks": checks,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
