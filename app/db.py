from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    token           TEXT PRIMARY KEY,
    filename        TEXT NOT NULL,
    size            INTEGER NOT NULL,
    stored_path     TEXT NOT NULL,
    uploaded_at     TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    download_count  INTEGER NOT NULL DEFAULT 0
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def insert_file(
    token: str,
    filename: str,
    size: int,
    stored_path: str,
    expires_at: str,
) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO files (token, filename, size, stored_path, uploaded_at, expires_at, download_count) "
            "VALUES (?, ?, ?, ?, ?, ?, 0)",
            (token, filename, size, stored_path, now_iso(), expires_at),
        )


def get_file(token: str) -> Optional[sqlite3.Row]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM files WHERE token = ?", (token,))
        return cur.fetchone()


def list_files() -> list[sqlite3.Row]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM files ORDER BY uploaded_at DESC")
        return cur.fetchall()


def increment_download_count(token: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET download_count = download_count + 1 WHERE token = ?",
            (token,),
        )


def delete_file(token: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM files WHERE token = ?", (token,))


def list_expired(before_iso: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM files WHERE expires_at < ?", (before_iso,))
        return cur.fetchall()
