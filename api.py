from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "poetry.db"

app = FastAPI(title="Poets Cloud API", version="2.0.0")
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Accept", "Content-Type"],
)


@app.get("/app/{path:path}")
def frontend_file(path: str) -> FileResponse:
    requested = (ROOT / path).resolve()
    if ROOT not in requested.parents and requested != ROOT:
        raise HTTPException(status_code=404, detail="File not found")
    if not requested.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(requested)


@app.get("/app")
def frontend_index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


def get_connection() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(status_code=500, detail=f"Database not found: {DB_PATH}")
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


def fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]


def fetch_one(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(query, params).fetchone()
        return row_to_dict(row)


@app.get("/api/manifest")
def manifest() -> dict[str, Any]:
    rows = fetch_all("SELECT key, value FROM metadata")
    data = {row["key"]: row["value"] for row in rows}
    data["work_count"] = int(data.get("work_count", "0"))
    data["dynasty_count"] = int(data.get("dynasty_count", "0"))
    if "source_files" in data:
        try:
            data["source_files"] = json.loads(data["source_files"])
        except Exception:
            pass
    return data


@app.get("/api/dynasties")
def dynasties() -> list[dict[str, Any]]:
    return fetch_all(
        "SELECT id, name, poem_count, author_count FROM dynasties ORDER BY id"
    )


@app.get("/api/authors")
def authors(
    dynasty: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    if dynasty:
        return fetch_all(
            """
            SELECT a.id, a.name, d.name AS dynasty, a.poem_count, a.importance
            FROM authors a
            JOIN dynasties d ON d.id = a.dynasty_id
            WHERE d.name = ?
            ORDER BY a.poem_count DESC, a.name
            LIMIT ? OFFSET ?
            """,
            (dynasty, limit, offset),
        )
    return fetch_all(
        """
        SELECT a.id, a.name, d.name AS dynasty, a.poem_count, a.importance
        FROM authors a
        JOIN dynasties d ON d.id = a.dynasty_id
        ORDER BY a.poem_count DESC, d.id, a.name
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    )


@app.get("/api/authors/{author_id}")
def author_detail(author_id: int) -> dict[str, Any]:
    author = fetch_one(
        """
        SELECT a.id, a.name, d.name AS dynasty, a.poem_count, a.importance
        FROM authors a
        JOIN dynasties d ON d.id = a.dynasty_id
        WHERE a.id = ?
        """,
        (author_id,),
    )
    if not author:
        raise HTTPException(status_code=404, detail="Author not found")
    return author


@app.get("/api/works")
def works(
    author_id: int | None = None,
    dynasty: str | None = None,
    genre: str | None = None,
    include_content: bool = False,
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    where = []
    params: list[Any] = []
    if author_id is not None:
        where.append("w.author_id = ?")
        params.append(author_id)
    if dynasty:
        where.append("d.name = ?")
        params.append(dynasty)
    if genre:
        where.append("w.genre = ?")
        params.append(genre)
    where_sql = "WHERE " + " AND ".join(where) if where else ""
    select_columns = "w.content, w.lines_json, w.tags_json," if include_content else ""
    items = fetch_all(
        f"""
        SELECT w.id, w.title, w.genre, w.rhythmic, w.meter, w.meter_confidence,
               {select_columns} w.importance,
               a.id AS author_id, a.name AS author_name,
               d.name AS dynasty
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        {where_sql}
        ORDER BY w.importance DESC, w.title
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    )
    if include_content:
        for item in items:
            item["lines"] = json.loads(item.pop("lines_json"))
            item["tags"] = json.loads(item.pop("tags_json"))
    else:
        for item in items:
            item.pop("content", None)
            item.pop("lines_json", None)
            item.pop("tags_json", None)
    total = fetch_one(
        f"""
        SELECT COUNT(*) AS count
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        {where_sql}
        """,
        tuple(params),
    )
    return {"total": int(total["count"] if total else 0), "items": items}


@app.get("/api/works/{work_id}")
def work_detail(work_id: str) -> dict[str, Any]:
    item = fetch_one(
        """
        SELECT w.id, w.title, w.genre, w.rhythmic, w.meter, w.meter_confidence,
               w.content, w.lines_json, w.tags_json, w.importance,
               a.id AS author_id, a.name AS author_name,
               d.name AS dynasty
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        WHERE w.id = ?
        """,
        (work_id,),
    )
    if not item:
        raise HTTPException(status_code=404, detail="Work not found")
    item["lines"] = json.loads(item.pop("lines_json"))
    item["tags"] = json.loads(item.pop("tags_json"))
    return item


@app.get("/api/search")
def search(q: str = "", dynasty: str | None = None, genre: str | None = None, limit: int = Query(default=50, ge=1, le=5000), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    q = q.strip()
    if not q:
        return {"total": 0, "items": []}

    # The bundled FTS index was produced by several source encodings and cannot
    # reliably match every Chinese query. Query the canonical columns directly
    # so title, author,正文 and tags remain discoverable for all four dynasties.
    like_term = f"%{q}%"
    where = [
        "(w.title LIKE ? OR a.name LIKE ? OR COALESCE(w.rhythmic, '') LIKE ? "
        "OR w.content LIKE ? OR COALESCE(w.tags_json, '') LIKE ?)"
    ]
    params: list[Any] = [like_term] * 5
    if dynasty:
        where.append("d.name = ?")
        params.append(dynasty)
    if genre:
        where.append("w.genre = ?")
        params.append(genre)
    where_sql = "WHERE " + " AND ".join(where)
    items = fetch_all(
        f"""
        SELECT w.id, w.title, w.genre, w.rhythmic, w.meter, w.importance,
               a.name AS author_name, d.name AS dynasty
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        {where_sql}
        ORDER BY w.importance DESC, w.title
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    )
    total = fetch_one(
        f"""
        SELECT COUNT(*) AS count
        FROM works w
        JOIN authors a ON a.id = w.author_id
        JOIN dynasties d ON d.id = w.dynasty_id
        {where_sql}
        """,
        tuple(params),
    )
    return {"total": int(total["count"] if total else 0), "items": items}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "message": "Poets Cloud API is running"}


@app.get("/", include_in_schema=False)
def frontend_root() -> FileResponse:
    dist_root = ROOT / "frontend" / "dist"
    index = dist_root / "index.html"
    if index.exists():
        return FileResponse(index)
    return FileResponse(ROOT / "index.html")


@app.get("/app.js", include_in_schema=False)
def frontend_script() -> FileResponse:
    return FileResponse(ROOT / "app.js")


@app.get("/styles.css", include_in_schema=False)
def frontend_styles() -> FileResponse:
    return FileResponse(ROOT / "styles.css")


app.mount("/node_modules", StaticFiles(directory=ROOT / "node_modules"), name="node-modules")
app.mount("/data/web", StaticFiles(directory=ROOT / "data" / "web"), name="web-data")


@app.get("/{path:path}", include_in_schema=False)
def frontend_route(_path: str) -> FileResponse:
    dist_index = ROOT / "frontend" / "dist" / "index.html"
    if not dist_index.exists():
        raise HTTPException(status_code=404, detail="Frontend has not been built")
    return FileResponse(dist_index)
