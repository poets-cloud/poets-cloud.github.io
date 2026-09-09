from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SOURCE_REPO = "https://github.com/chinese-poetry/chinese-poetry"
SOURCE_RAW = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master"
SOURCE_LICENSE = f"{SOURCE_RAW}/LICENSE"

PUNCTUATION_RE = re.compile(r"[\s，。！？；：、,.!?;:'\"“”‘’（）()《》〈〉【】\[\]—…·]+")
BAD_GLYPHS_RE = re.compile(r"[□■�]")

DYNASTY_LABELS = {
    "唐": "唐",
    "宋": "宋",
    "元": "元",
    "清": "清",
}

GENRE_DEFAULT = {
    "唐": "诗",
    "宋": "词",
    "元": "曲",
    "清": "词",
}

METER_COLORS = {
    "五绝": "#7dd3fc",
    "七绝": "#60a5fa",
    "五律": "#a78bfa",
    "七律": "#f472b6",
    "词": "#fbbf24",
    "曲": "#fb923c",
    "其他": "#94a3b8",
}

TANG_FILES = [f"全唐诗/poet.tang.{offset}.json" for offset in range(0, 58000, 1000)]
SONG_CI_FILES = [f"宋词/ci.song.{offset}.json" for offset in range(0, 22000, 1000)]
YUAN_FILE = "元曲/yuanqu.json"
QING_FILE = "纳兰性德/纳兰性德诗集.json"

FAMOUS_TANG = [
    "李白", "杜甫", "白居易", "王维", "李商隐", "杜牧", "孟浩然", "王昌龄", "刘禹锡", "柳宗元",
    "岑参", "高适", "韦应物", "韩愈", "李贺", "温庭筠", "王勃", "贺知章", "张九龄", "王之涣",
    "王翰", "孟郊", "贾岛", "元稹", "卢纶", "刘长卿", "陈子昂",
]
FAMOUS_SONG = [
    "苏轼", "王安石", "陆游", "杨万里", "范成大", "欧阳修", "黄庭坚", "秦观", "梅尧臣", "陈与义",
    "朱熹", "林逋", "赵师秀", "叶绍翁", "刘克庄", "周敦颐", "晏殊", "晏几道", "李清照", "柳永",
    "姜夔", "周邦彦", "张先", "贺铸",
]
FAMOUS_YUAN = ["关汉卿", "白朴", "马致远", "郑光祖", "张可久", "乔吉", "王实甫", "杨显之", "高文秀"]
FAMOUS_QING = ["纳兰性德"]

AUTHOR_RANKS = {
    "唐": {name: i for i, name in enumerate(FAMOUS_TANG)},
    "宋": {name: i for i, name in enumerate(FAMOUS_SONG)},
    "元": {name: i for i, name in enumerate(FAMOUS_YUAN)},
    "清": {name: i for i, name in enumerate(FAMOUS_QING)},
}


def download(url: str, destination: Path) -> bool:
    if destination.exists() and destination.stat().st_size > 0:
        return True
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "poets-cloud-data-builder/2.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            destination.write_bytes(response.read())
        return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip()


def searchable(value: str) -> str:
    return PUNCTUATION_RE.sub("", normalize(value)).lower()


def classify_meter(lines: list[str], dynasty: str) -> tuple[str, float]:
    if dynasty == "元":
        return "曲", 0.8
    if dynasty == "宋":
        return "词", 0.85
    if dynasty == "清":
        return "词", 0.75
    clauses = [searchable(clause) for line in lines for clause in re.split(r"[，。！？；,.!?;]+", line) if searchable(clause)]
    lengths = [len(clause) for clause in clauses]
    mapping = {(4, 5): "五绝", (4, 7): "七绝", (8, 5): "五律", (8, 7): "七律"}
    if lengths and len(set(lengths)) == 1:
        meter = mapping.get((len(clauses), lengths[0]))
        if meter:
            return meter, 0.9
    return "其他", 0.25


def clean_record(record: dict, dynasty: str, source_file: str) -> tuple[dict | None, str | None]:
    title = normalize(record.get("title") or record.get("rhythmic") or "")
    author = normalize(record.get("author", ""))
    paragraphs = record.get("paragraphs") or record.get("para") or record.get("contents") or record.get("lines") or []
    if isinstance(paragraphs, str):
        paragraphs = [paragraphs]
    lines = [normalize(line) for line in paragraphs if normalize(line)]
    if not title or not author or not lines:
        return None, "missing_required_field"
    content = "\n".join(lines)
    if BAD_GLYPHS_RE.search(content):
        return None, "damaged_glyph"
    if author in {"不詳", "不详", "佚名"}:
        return None, "unknown_author"
    normalized_content = searchable(content)
    if len(normalized_content) < 10:
        return None, "too_short"
    meter, confidence = classify_meter(lines, dynasty)
    tags = sorted({normalize(tag) for tag in record.get("tags", []) if normalize(tag)})
    stable_key = f"{dynasty}\u241f{author}\u241f{title}\u241f{normalized_content}"
    poem_id = hashlib.sha256(stable_key.encode("utf-8")).hexdigest()[:24]
    return {
        "id": poem_id,
        "title": title,
        "author": author,
        "dynasty": dynasty,
        "genre": GENRE_DEFAULT[dynasty],
        "rhythmic": normalize(record.get("rhythmic", "")),
        "lines": lines,
        "content": content,
        "normalized_title": searchable(title),
        "normalized_author": searchable(author),
        "normalized_content": normalized_content,
        "meter": meter,
        "meter_confidence": confidence,
        "tags": tags,
        "source_file": source_file,
        "source_id": str(record.get("id", "")),
    }, None


def select_records(records: list[dict], dynasty: str, limit: int) -> list[dict]:
    ranks = AUTHOR_RANKS.get(dynasty, {})
    candidates = sorted(records, key=lambda item: (
        ranks.get(item["author"], 999),
        0 if item["meter"] in {"五绝", "七绝", "五律", "七律", "词", "曲"} else 1,
        item["title"],
        item["id"],
    ))
    selected: list[dict] = []
    author_counts: Counter[str] = Counter()
    seen_content: set[str] = set()
    max_per_author = 40 if dynasty in {"唐", "宋"} else 25
    for record in candidates:
        if len(selected) >= limit:
            break
        if record["id"] in {item["id"] for item in selected}:
            continue
        if record["normalized_content"] in seen_content:
            continue
        if author_counts[record["author"]] >= max_per_author:
            continue
        selected.append(record)
        seen_content.add(record["normalized_content"])
        author_counts[record["author"]] += 1
    return selected


def load_dynasty_records(raw_root: Path) -> tuple[list[dict], list[str]]:
    all_records: list[dict] = []
    source_files: list[str] = []
    seen_ids: set[str] = set()

    sources = [
        ("唐", raw_root / "全唐诗", TANG_FILES),
        ("宋", raw_root / "宋词", SONG_CI_FILES),
        ("元", raw_root / "元曲", [YUAN_FILE]),
        ("清", raw_root / "纳兰性德", [QING_FILE]),
    ]

    for dynasty, base_dir, rel_files in sources:
        for relative_file in rel_files:
            destination = raw_root / relative_file
            encoded_path = urllib.parse.quote(relative_file)
            if not download(f"{SOURCE_RAW}/{encoded_path}", destination):
                continue
            source_files.append(relative_file)
            try:
                raw_payload = json.loads(destination.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(raw_payload, list):
                continue
            for raw_record in raw_payload:
                record, _ = clean_record(raw_record, dynasty, relative_file)
                if record and record["id"] not in seen_ids:
                    seen_ids.add(record["id"])
                    all_records.append(record)
    return all_records, source_files


def build_database(path: Path, works: list[dict], source_files: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    if temp_path.exists():
        temp_path.unlink()
    connection = sqlite3.connect(temp_path)
    connection.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE dynasties (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            poem_count INTEGER NOT NULL DEFAULT 0,
            author_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE authors (
            id INTEGER PRIMARY KEY,
            dynasty_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            poem_count INTEGER NOT NULL DEFAULT 0,
            importance REAL NOT NULL DEFAULT 0,
            FOREIGN KEY(dynasty_id) REFERENCES dynasties(id)
        );

        CREATE UNIQUE INDEX idx_authors_unique ON authors(dynasty_id, normalized_name);
        CREATE INDEX idx_authors_dynasty ON authors(dynasty_id);

        CREATE TABLE works (
            id TEXT PRIMARY KEY,
            dynasty_id INTEGER NOT NULL,
            author_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            genre TEXT NOT NULL,
            rhythmic TEXT,
            meter TEXT NOT NULL,
            meter_confidence REAL NOT NULL,
            content TEXT NOT NULL,
            lines_json TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            normalized_title TEXT NOT NULL,
            normalized_author TEXT NOT NULL,
            normalized_content TEXT NOT NULL,
            source_file TEXT NOT NULL,
            source_id TEXT,
            importance REAL NOT NULL DEFAULT 0,
            FOREIGN KEY(dynasty_id) REFERENCES dynasties(id),
            FOREIGN KEY(author_id) REFERENCES authors(id)
        );

        CREATE INDEX idx_works_dynasty ON works(dynasty_id);
        CREATE INDEX idx_works_author ON works(author_id);
        CREATE INDEX idx_works_genre ON works(genre);
        CREATE INDEX idx_works_meter ON works(meter);

        CREATE VIRTUAL TABLE works_fts USING fts5(
            work_id UNINDEXED,
            title,
            author,
            rhythmic,
            content,
            tags,
            tokenize='trigram'
        );
    """)

    dynasty_ids = {name: index + 1 for index, name in enumerate(DYNASTY_LABELS.values())}
    dynasty_counts = Counter(work["dynasty"] for work in works)
    author_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for work in works:
        author_groups[(work["dynasty"], searchable(work["author"]))].append(work)

    generated_at = datetime.now(timezone.utc).isoformat()
    for key, value in {
        "schema_version": "2.0.0",
        "generated_at": generated_at,
        "source_repository": SOURCE_REPO,
        "source_license": "MIT",
        "source_files": json.dumps(source_files, ensure_ascii=False),
        "work_count": str(len(works)),
        "dynasty_count": str(len(dynasty_counts)),
    }.items():
        connection.execute("INSERT INTO metadata(key, value) VALUES (?, ?)", (key, value))

    for dynasty_name in sorted(dynasty_counts.keys(), key=lambda d: list(DYNASTY_LABELS).index(d)):
        dynasty_id = dynasty_ids[dynasty_name]
        authors_in_dynasty = [key for key in author_groups.keys() if key[0] == dynasty_name]
        connection.execute(
            "INSERT INTO dynasties(id, name, poem_count, author_count) VALUES (?, ?, ?, ?)",
            (dynasty_id, dynasty_name, dynasty_counts[dynasty_name], len(authors_in_dynasty)),
        )

    author_id_map: dict[tuple[str, str], int] = {}
    authors_sorted: list[tuple[tuple[str, str], list[dict]]] = sorted(
        author_groups.items(),
        key=lambda item: (-len(item[1]), item[0][0], item[0][1]),
    )
    for index, ((dynasty_name, normalized_author), group) in enumerate(authors_sorted, start=1):
        importance = round(min(len(group), 80) / 80, 4)
        display_name = group[0]["author"]
        dynasty_id = dynasty_ids[dynasty_name]
        connection.execute(
            "INSERT INTO authors(id, dynasty_id, name, normalized_name, poem_count, importance) VALUES (?, ?, ?, ?, ?, ?)",
            (index, dynasty_id, display_name, normalized_author, len(group), importance),
        )
        author_id_map[(dynasty_name, normalized_author)] = index

    author_work_counts = Counter((work["dynasty"], searchable(work["author"])) for work in works)

    for work in works:
        author_key = (work["dynasty"], searchable(work["author"]))
        author_id = author_id_map[author_key]
        dynasty_id = dynasty_ids[work["dynasty"]]
        author_poem_count = author_work_counts[author_key]
        importance = round(
            0.35
            + min(author_poem_count, 80) / 80 * 0.35
            + (0.2 if work["meter"] in {"五绝", "七绝", "五律", "七律", "词", "曲"} else 0.05)
            + (0.1 if work["tags"] else 0.0),
            4,
        )
        connection.execute(
            """INSERT INTO works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                work["id"], dynasty_id, author_id, work["title"], work["genre"], work["rhythmic"],
                work["meter"], work["meter_confidence"], work["content"],
                json.dumps(work["lines"], ensure_ascii=False), json.dumps(work["tags"], ensure_ascii=False),
                work["normalized_title"], work["normalized_author"], work["normalized_content"],
                work["source_file"], work["source_id"], importance,
            ),
        )
        connection.execute(
            "INSERT INTO works_fts(work_id, title, author, rhythmic, content, tags) VALUES (?, ?, ?, ?, ?, ?)",
            (work["id"], work["title"], work["author"], work["rhythmic"], work["content"], " ".join(work["tags"])),
        )

    connection.commit()
    connection.close()
    os.replace(temp_path, path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the standardized Poets Cloud SQLite database")
    parser.add_argument("--limit", type=int, default=0, help="Optional maximum number of works; 0 keeps all works")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=None, help="Optional explicit database path")
    args = parser.parse_args()

    raw_root = args.root / "data" / "raw" / "chinese-poetry"
    database_path = args.output or (args.root / "data" / "poetry.db")
    report_path = args.root / "data" / "quality-report.json"

    download(SOURCE_LICENSE, raw_root / "LICENSE")
    works, source_files = load_dynasty_records(raw_root)
    if not works:
        raise RuntimeError("No works were loaded from the raw dataset")
    if args.limit > 0:
        works = sorted(works, key=lambda item: (item["dynasty"], item["author"], item["title"], item["id"]))[: args.limit]

    build_database(database_path, works, source_files)
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRepository": SOURCE_REPO,
        "license": "MIT",
        "workCount": len(works),
        "dynastyDistribution": dict(Counter(work["dynasty"] for work in works)),
        "genreDistribution": dict(Counter(work["genre"] for work in works)),
        "meterDistribution": dict(Counter(work["meter"] for work in works)),
        "topAuthors": Counter((work["dynasty"], work["author"]) for work in works).most_common(20),
        "sourceFiles": source_files,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Database: {database_path}")


if __name__ == "__main__":
    main()
