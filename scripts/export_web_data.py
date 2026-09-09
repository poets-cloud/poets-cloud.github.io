from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "poetry.db"
WEB_DIR = ROOT / "data" / "web"
BUCKET_COUNT = 64


def bucket_for(work_id: str) -> str:
    return f"{int(work_id[:8], 16) % BUCKET_COUNT:02x}"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def stable_position(seed: str, author_id: int, dynasty_id: int) -> list[float]:
    digest = sha256(seed.encode("utf-8")).digest()
    author_angle = (author_id * 2.399963229728653) % 6.283185307179586
    dynasty_radius = 210 + dynasty_id * 72
    cluster_radius = 10 + digest[0] / 255 * 38
    cluster_angle = int.from_bytes(digest[1:5], "big") / 0xFFFFFFFF * 6.283185307179586
    x = dynasty_radius * __import__("math").cos(author_angle) + cluster_radius * __import__("math").cos(cluster_angle)
    z = dynasty_radius * __import__("math").sin(author_angle) + cluster_radius * __import__("math").sin(cluster_angle)
    y = (digest[5] / 255 - 0.5) * 150 + (dynasty_id - 2.5) * 32
    return [round(x, 3), round(y, 3), round(z, 3)]


def main() -> None:
    if not DB_PATH.exists():
        raise RuntimeError(f"Database does not exist: {DB_PATH}")

    WEB_DIR.mkdir(parents=True, exist_ok=True)
    for folder_name in ("works", "search"):
        folder = WEB_DIR / folder_name
        folder.mkdir(exist_ok=True)
        for old_file in folder.glob("*.json"):
            old_file.unlink()

    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row

    metadata = {
        row["key"]: row["value"]
        for row in connection.execute("SELECT key, value FROM metadata")
    }
    dynasties = [
        dict(row)
        for row in connection.execute(
            "SELECT id, name, poem_count AS workCount, author_count AS authorCount FROM dynasties ORDER BY id"
        )
    ]
    authors = [
        dict(row)
        for row in connection.execute(
            """
            SELECT a.id, a.name, d.name AS dynasty, a.poem_count AS workCount,
                   a.importance
            FROM authors a
            JOIN dynasties d ON d.id = a.dynasty_id
            ORDER BY a.importance DESC, a.poem_count DESC, a.name
            """
        )
    ]

    index: list[dict[str, Any]] = []
    details: dict[str, dict[str, Any]] = defaultdict(dict)
    search: dict[str, list[dict[str, Any]]] = defaultdict(list)
    content_hash = sha256()

    rows = connection.execute(
        """
        SELECT w.id, w.title, w.genre, w.rhythmic, w.meter, w.content,
               w.lines_json, w.tags_json, w.normalized_title,
               w.normalized_author, w.normalized_content, w.importance,
               a.id AS author_id, a.name AS author_name,
               d.id AS dynasty_id, d.name AS dynasty
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        ORDER BY w.importance DESC, w.title
        """
    )

    for row in rows:
        item = dict(row)
        work_id = item["id"]
        bucket = bucket_for(work_id)
        lines = json.loads(item["lines_json"])
        tags = json.loads(item["tags_json"])
        content_hash.update(work_id.encode("utf-8"))
        content_hash.update(item["content"].encode("utf-8"))

        index.append(
            {
                "id": work_id,
                "title": item["title"],
                "authorId": item["author_id"],
                "authorName": item["author_name"],
                "dynasty": item["dynasty"],
                "meter": item["meter"],
                "excerpt": lines[0] if lines else "",
                "importance": item["importance"],
                "bucket": bucket,
                "position": stable_position(work_id, item["author_id"], item["dynasty_id"]),
            }
        )
        details[bucket][work_id] = {
            "id": work_id,
            "title": item["title"],
            "authorId": item["author_id"],
            "authorName": item["author_name"],
            "dynasty": item["dynasty"],
            "genre": item["genre"],
            "rhythmic": item["rhythmic"] or "",
            "meter": item["meter"],
            "lines": lines,
            "tags": tags,
            "importance": item["importance"],
        }
        search[bucket].append(
            {
                "id": work_id,
                "text": "".join(
                    (
                        item["normalized_title"],
                        item["normalized_author"],
                        item["normalized_content"],
                    )
                ),
            }
        )

    connection.close()

    for bucket, payload in details.items():
        write_json(WEB_DIR / "works" / f"{bucket}.json", payload)
    for bucket, payload in search.items():
        write_json(WEB_DIR / "search" / f"{bucket}.json", payload)

    generated_at = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schemaVersion": 3,
        "datasetVersion": generated_at[:10],
        "generatedAt": generated_at,
        "contentHash": content_hash.hexdigest(),
        "workCount": len(index),
        "authorCount": len(authors),
        "dynastyCount": len(dynasties),
        "bucketCount": BUCKET_COUNT,
        "detailPattern": "works/{bucket}.json",
        "searchPattern": "search/{bucket}.json",
        "databaseSchemaVersion": metadata.get("schema_version", "unknown"),
    }
    write_json(WEB_DIR / "manifest.json", manifest)
    write_json(WEB_DIR / "dynasties.json", dynasties)
    write_json(WEB_DIR / "authors.index.json", authors)
    write_json(WEB_DIR / "works.index.json", index)

    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
