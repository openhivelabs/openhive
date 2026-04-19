"""Minimal SQLite helpers for Phase 0B.

Schema is intentionally small — the only table right now is oauth_tokens. More tables
land alongside the features that need them (runs, messages, usage_logs in Phase 0C+).
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from openhive.config import get_settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider_id   TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,           -- encrypted (Fernet)
  refresh_token TEXT,                    -- encrypted (Fernet) or NULL
  expires_at    INTEGER,                 -- unix seconds, NULL if unknown
  scope         TEXT,
  account_label TEXT,                    -- human-readable ("dongyun@...")
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    settings = get_settings()
    with _connect(settings.db_path) as conn:
        conn.executescript(SCHEMA)
        conn.commit()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    settings = get_settings()
    conn = _connect(settings.db_path)
    try:
        yield conn
    finally:
        conn.close()
