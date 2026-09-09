"""Generate the multi-dynasty web dataset from the chinese-poetry GitHub repo.

Downloads raw JSON for 唐(Tang), 宋(Song), 元(Yuan), 清(Qing=Nalan), then
writes data/web/*.json in the same schema as the existing demo.
Each dynasty is capped at --per-dynasty poems (default 300).
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT / "data" / "raw" / "chinese-poetry"
WEB_DIR = ROOT / "data" / "web"

SOURCE_RAW = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master"

DYNASTY_LIMIT = 300

METER_COLORS = {
    "五绝": "#7dd3fc",
    "七绝": "#60a5fa",
    "五律": "#a78bfa",
    "七律": "#f472b6",
    "词": "#fbbf24",
    "曲": "#fb923c",
    "其他": "#94a3b8",
}

PUNCTUATION_RE = re.compile(r"[\s，。！？；：、,.!?;:'\"“”‘’（）()《》〈〉【】\[\]—…·]+")
BAD_GLYPHS_RE = re.compile(r"[□■�]")

FAMOUS_TANG = [
    "李白", "杜甫", "白居易", "王維", "李商隱", "杜牧", "孟浩然",
    "王昌齡", "劉禹錫", "柳宗元", "岑參", "高適", "韋應物", "韓愈",
    "李賀", "溫庭筠", "王勃", "賀知章", "張九齡", "王之渙", "王翰",
    "孟郊", "賈島", "元稹", "盧綸", "劉長卿", "陳子昂",
]
FAMOUS_SONG = [
    "苏轼", "王安石", "陆游", "杨万里", "范成大", "欧阳修", "黄庭坚",
    "秦观", "梅尧臣", "陈与义", "朱熹", "林逋", "赵师秀", "叶绍翁",
    "志南", "刘克庄", "周敦颐",
]
FAMOUS_SONGCI = [
    "苏轼", "辛弃疾", "李清照", "柳永", "姜夔", "陆游", "秦观",
    "周邦彦", "晏殊", "晏几道", "欧阳修", "王安石", "张先", "贺铸",
]
FAMOUS_NALAN = ["纳兰性德"]

AUTHOR_RANKS = {
    "唐": {n: i for i, n in enumerate(FAMOUS_TANG)},
    "宋": {n: i for i, n in enumerate(FAMOUS_SONG + FAMOUS_SONGCI)},
    "元": {},
    "清": {n: i for i, n in enumerate(FAMOUS_NALAN)},
}

DYNASTY_DISPLAY = {"唐": "唐", "宋": "宋", "元": "元", "清": "清"}


def download(url: str, destination: Path) -> bool:
    if destination.exists() and destination.stat().st_size > 0:
        return True
    destination.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "poets-cloud/2.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            destination.write_bytes(resp.read())
        return True
    except Exception as exc:
        print(f"  download failed: {url}: {exc}")
        return False


def normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip()


def searchable(value: str) -> str:
    return PUNCTUATION_RE.sub("", normalize(value)).lower()


def classify_meter(lines: list[str], dynasty: str) -> tuple[str, float]:
    if dynasty == "元":
        return "曲", 0.8
    if dynasty == "清":
        return "词", 0.7
    clauses = [
        searchable(clause)
        for line in lines
        for clause in re.split(r"[，。！？；,.!?;]+", line)
        if searchable(clause)
    ]
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
    paragraphs = (
        record.get("paragraphs")
        or record.get("para")
        or record.get("contents")
        or record.get("lines")
        or []
    )
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
    if title in {"句", "殘句", "残句"} or len(lines) < 1:
        return None, "fragment"
    normalized_content = searchable(content)
    if len(normalized_content) < 10:
        return None, "too_short"
    meter, confidence = classify_meter(lines, dynasty)
    rhythmic = normalize(record.get("rhythmic", ""))
    if dynasty == "宋" and rhythmic:
        meter = "词"
        confidence = 0.85
    tags = sorted({normalize(tag) for tag in record.get("tags", []) if normalize(tag)})
    stable_key = f"{author}\u241f{title}\u241f{normalized_content}"
    poem_id = hashlib.sha256(stable_key.encode("utf-8")).hexdigest()[:24]
    return {
        "id": poem_id,
        "source_id": str(record.get("id", "")),
        "title": title,
        "author": author,
        "dynasty": dynasty,
        "lines": lines,
        "content": content,
        "normalized_title": searchable(title),
        "normalized_author": searchable(author),
        "normalized_content": normalized_content,
        "meter": meter,
        "meter_confidence": confidence,
        "tags": tags,
        "source_file": source_file,
    }, None


def select_records(records: list[dict], dynasty: str, limit: int) -> list[dict]:
    ranks = AUTHOR_RANKS.get(dynasty, {})
    famous = [r for r in records if r["author"] in ranks]
    candidates = famous if len(famous) >= limit else records
    meter_rank = {"五绝": 0, "七绝": 1, "五律": 2, "七律": 3, "词": 4, "曲": 5, "其他": 6}
    candidates.sort(key=lambda item: (
        0 if "唐诗三百首" in item["tags"] else 1,
        ranks.get(item["author"], 999),
        meter_rank[item["meter"]],
        item["title"],
        item["id"],
    ))
    selected: list[dict] = []
    author_counts: Counter[str] = Counter()
    seen_content: set[str] = set()
    for author_cap in (25, 40, 10_000):
        for record in candidates:
            if len(selected) >= limit:
                return selected
            if record["id"] in {item["id"] for item in selected}:
                continue
            if record["normalized_content"] in seen_content or author_counts[record["author"]] >= author_cap:
                continue
            selected.append(record)
            seen_content.add(record["normalized_content"])
            author_counts[record["author"]] += 1
    return selected


def fetch_tang() -> list[dict]:
    records: list[dict] = []
    tang_dir = RAW_ROOT / "全唐诗"
    files = sorted(tang_dir.glob("poet.tang.*.json"))
    print(f"唐诗: {len(files)} raw files found")
    for f in files:
        for raw in json.loads(f.read_text(encoding="utf-8")):
            rec, _ = clean_record(raw, "唐", str(f.relative_to(RAW_ROOT)))
            if rec:
                records.append(rec)
    print(f"  -> {len(records)} clean Tang records")
    return records


def fetch_song_poems() -> list[dict]:
    song_dir = RAW_ROOT / "宋词"
    files = sorted(song_dir.glob("ci.song.*.json"))
    print(f"宋词: {len(files)} raw files found")
    records: list[dict] = []
    for f in files:
        try:
            for raw in json.loads(f.read_text(encoding="utf-8")):
                rec, _ = clean_record(raw, "宋", str(f.relative_to(RAW_ROOT)))
                if rec:
                    records.append(rec)
        except Exception as exc:
            print(f"  parse error {f.name}: {exc}")
    print(f"  -> {len(records)} clean Song records")
    return records


def fetch_song_ci() -> list[dict]:
    records: list[dict] = []
    for offset in range(0, 22000, 1000):
        rel = f"宋词/ci.song.{offset}.json"
        dest = RAW_ROOT / rel
        encoded = urllib.parse.quote(rel)
        if not download(f"{SOURCE_RAW}/{encoded}", dest):
            continue
        try:
            for raw in json.loads(dest.read_text(encoding="utf-8")):
                rec, _ = clean_record(raw, "宋", rel)
                if rec:
                    records.append(rec)
        except Exception as exc:
            print(f"  parse error {dest.name}: {exc}")
    print(f"宋词: -> {len(records)} clean records")
    return records


def fetch_yuan() -> list[dict]:
    yuan_dir = RAW_ROOT / "元曲"
    rel = "元曲/yuanqu.json"
    dest = RAW_ROOT / rel
    encoded = urllib.parse.quote(rel)
    if not download(f"{SOURCE_RAW}/{encoded}", dest):
        print("元曲: download failed")
        return []
    records: list[dict] = []
    try:
        raw_data = json.loads(dest.read_text(encoding="utf-8"))
        for raw in raw_data:
            rec, _ = clean_record(raw, "元", rel)
            if rec:
                records.append(rec)
    except Exception as exc:
        print(f"元曲: parse error: {exc}")
    print(f"元曲: -> {len(records)} clean records")
    return records


def fetch_qing() -> list[dict]:
    rel = "纳兰性德/纳兰性德诗集.json"
    dest = RAW_ROOT / rel
    encoded = urllib.parse.quote(rel)
    if not download(f"{SOURCE_RAW}/{encoded}", dest):
        print("清(纳兰): download failed")
        return []
    records: list[dict] = []
    try:
        raw_data = json.loads(dest.read_text(encoding="utf-8"))
        for raw in raw_data:
            rec, _ = clean_record(raw, "清", rel)
            if rec:
                records.append(rec)
    except Exception as exc:
        print(f"清(纳兰): parse error: {exc}")
    print(f"清(纳兰): -> {len(records)} clean records")
    return records


def build_author_index(poems: list[dict]) -> list[dict]:
    author_map: dict[str, dict] = {}
    for poem in poems:
        key = f"{poem['dynasty']}:{poem['author']}"
        if key not in author_map:
            author_map[key] = {"id": 0, "name": poem["author"], "dynasty": poem["dynasty"], "poemCount": 0}
        author_map[key]["poemCount"] += 1
    authors = sorted(author_map.values(), key=lambda a: (-a["poemCount"], a["dynasty"], a["name"]))
    for i, a in enumerate(authors, 1):
        a["id"] = i
    return authors


def build_poem_payloads(poems: list[dict], authors: list[dict]) -> list[dict]:
    author_ids = {f"{a['dynasty']}:{a['name']}": a["id"] for a in authors}
    result = []
    for poem in poems:
        aid = author_ids.get(f"{poem['dynasty']}:{poem['author']}", 0)
        author_poem_count = sum(1 for p in poems if p["author"] == poem["author"] and p["dynasty"] == poem["dynasty"])
        importance = round(
            0.35
            + min(author_poem_count, 40) / 40 * 0.35
            + (0.2 if poem["meter"] in {"五绝", "七绝", "五律", "七律"} else 0.05)
            + (0.1 if poem["tags"] else 0.0),
            4,
        )
        result.append({
            "id": poem["id"],
            "title": poem["title"],
            "authorId": aid,
            "authorName": poem["author"],
            "dynasty": poem["dynasty"],
            "content": poem["content"],
            "normalizedTitle": poem["normalized_title"],
            "normalizedAuthor": poem["normalized_author"],
            "normalizedContent": poem["normalized_content"],
            "meter": poem["meter"],
            "meterConfidence": poem["meter_confidence"],
            "sourceId": poem["source_id"],
            "sourceFile": poem["source_file"],
            "authorPoemCount": author_poem_count,
            "lines": poem["lines"],
            "tags": poem["tags"],
            "excerpt": poem["lines"][0] if poem["lines"] else "",
            "importance": importance,
        })
    return result


def build_viz_nodes(poems: list[dict]) -> list[dict]:
    author_groups: dict[str, list[dict]] = defaultdict(list)
    for poem in poems:
        author_groups[poem["authorName"]].append(poem)
    author_list = sorted(author_groups.items(), key=lambda item: (-len(item[1]), item[1][0]["authorName"]))
    centers: dict[str, tuple[float, float]] = {}
    radius = 45.0
    for index, (author_name, _) in enumerate(author_list):
        angle = index * (math.tau / max(len(author_list), 1))
        centers[author_name] = (math.cos(angle) * radius, math.sin(angle) * radius)

    def stable_unit(seed: str, axis: str) -> float:
        digest = hashlib.sha256(f"{seed}:{axis}".encode("utf-8")).hexdigest()[:16]
        return int(digest, 16) / 0xFFFFFFFFFFFFFFFF

    nodes = []
    for poem in poems:
        cx, cy = centers.get(poem["authorName"], (0, 0))
        x = cx + (stable_unit(poem["id"], "x") - 0.5) * 16
        y = cy + (stable_unit(poem["id"], "y") - 0.5) * 16
        z = (stable_unit(poem["id"], "z") - 0.5) * 40
        nodes.append({
            "id": poem["id"],
            "authorId": poem["authorId"],
            "authorName": poem["authorName"],
            "title": poem["title"],
            "meter": poem["meter"],
            "x": round(x, 4),
            "y": round(y, 4),
            "z": round(z, 4),
            "size": round(0.7 + poem["importance"] * 1.6, 4),
            "color": METER_COLORS.get(poem["meter"], METER_COLORS["其他"]),
            "importance": poem["importance"],
        })
    return nodes


def main() -> None:
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    (WEB_DIR / "poems").mkdir(exist_ok=True)

    all_records: list[dict] = []

    # --- 唐 ---
    tang = fetch_tang()
    tang_sel = select_records(tang, "唐", DYNASTY_LIMIT)
    print(f"  -> selected {len(tang_sel)} Tang poems")
    all_records.extend(tang_sel)

    # --- 宋 (poems + ci) ---
    song_poems = fetch_song_poems()
    song_ci = fetch_song_ci()
    song_all = song_poems + song_ci
    song_sel = select_records(song_all, "宋", DYNASTY_LIMIT)
    print(f"  -> selected {len(song_sel)} Song poems")
    all_records.extend(song_sel)

    # --- 元 ---
    yuan = fetch_yuan()
    yuan_sel = select_records(yuan, "元", DYNASTY_LIMIT)
    print(f"  -> selected {len(yuan_sel)} Yuan poems")
    all_records.extend(yuan_sel)

    # --- 清 (纳兰性德) ---
    qing = fetch_qing()
    qing_sel = select_records(qing, "清", DYNASTY_LIMIT)
    print(f"  -> selected {len(qing_sel)} Qing poems")
    all_records.extend(qing_sel)

    # --- Build outputs ---
    authors = build_author_index(all_records)
    poems_payload = build_poem_payloads(all_records, authors)

    meter_counts = Counter(p["meter"] for p in poems_payload)
    category_payload = [
        {"id": m, "name": m, "count": meter_counts.get(m, 0), "color": color}
        for m, color in METER_COLORS.items()
        if meter_counts.get(m, 0) > 0
    ]

    title_index = [
        {
            "id": p["id"], "title": p["title"], "authorId": p["authorId"],
            "authorName": p["authorName"], "dynasty": p["dynasty"],
            "meter": p["meter"], "excerpt": p["excerpt"],
            "importance": p["importance"],
            "normalizedTitle": p["normalizedTitle"],
            "normalizedAuthor": p["normalizedAuthor"],
            "normalizedContent": p["normalizedContent"],
        }
        for p in poems_payload
    ]

    search_index = [
        {
            "id": p["id"], "title": p["title"], "author": p["authorName"],
            "dynasty": p["dynasty"], "meter": p["meter"],
            "text": p["normalizedTitle"] + " " + p["normalizedAuthor"] + " " + p["normalizedContent"],
            "importance": p["importance"],
        }
        for p in poems_payload
    ]

    viz_nodes = build_viz_nodes(poems_payload)

    # --- Write files ---
    (WEB_DIR / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1,
        "datasetVersion": "multi-dynasty-v2",
        "poemCount": len(poems_payload),
        "authorCount": len(authors),
        "dynastyCount": len({p["dynasty"] for p in poems_payload}),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dynasties": sorted({p["dynasty"] for p in poems_payload}),
        "perDynastyLimit": DYNASTY_LIMIT,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (WEB_DIR / "authors.json").write_text(json.dumps(authors, ensure_ascii=False, indent=2), encoding="utf-8")
    (WEB_DIR / "categories.json").write_text(json.dumps(category_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (WEB_DIR / "poems.index.json").write_text(json.dumps(title_index, ensure_ascii=False, indent=2), encoding="utf-8")
    (WEB_DIR / "search-index.json").write_text(json.dumps(search_index, ensure_ascii=False, indent=2), encoding="utf-8")
    (WEB_DIR / "viz-nodes.json").write_text(json.dumps(viz_nodes, ensure_ascii=False, indent=2), encoding="utf-8")

    chunks_dir = WEB_DIR / "poems"
    for old in chunks_dir.glob("*.json"):
        old.unlink()
    for idx in range(0, len(poems_payload), 100):
        chunk = poems_payload[idx:idx + 100]
        (chunks_dir / f"chunk-{idx // 100:03d}.json").write_text(
            json.dumps(chunk, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    dynasty_counts = Counter(p["dynasty"] for p in poems_payload)
    print("\n=== DONE ===")
    print(f"Total poems: {len(poems_payload)}")
    print(f"Authors: {len(authors)}")
    print(f"Dynasty distribution: {dict(dynasty_counts)}")
    print(f"Meter distribution: {dict(meter_counts)}")
    print(f"Chunks: {(len(poems_payload) + 99) // 100}")


if __name__ == "__main__":
    main()
