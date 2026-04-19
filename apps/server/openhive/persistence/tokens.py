"""Token storage — encrypts on write, decrypts on read."""

from __future__ import annotations

import time
from dataclasses import dataclass

from openhive.persistence.crypto import decrypt, encrypt
from openhive.persistence.db import db


@dataclass
class TokenRecord:
    provider_id: str
    access_token: str
    refresh_token: str | None
    expires_at: int | None  # unix seconds
    scope: str | None
    account_label: str | None


def save(record: TokenRecord) -> None:
    now = int(time.time())
    access_enc = encrypt(record.access_token)
    refresh_enc = encrypt(record.refresh_token) if record.refresh_token else None
    with db() as conn:
        conn.execute(
            """
            INSERT INTO oauth_tokens
              (provider_id, access_token, refresh_token, expires_at, scope, account_label,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider_id) DO UPDATE SET
              access_token=excluded.access_token,
              refresh_token=excluded.refresh_token,
              expires_at=excluded.expires_at,
              scope=excluded.scope,
              account_label=excluded.account_label,
              updated_at=excluded.updated_at
            """,
            (
                record.provider_id,
                access_enc,
                refresh_enc,
                record.expires_at,
                record.scope,
                record.account_label,
                now,
                now,
            ),
        )
        conn.commit()


def load(provider_id: str) -> TokenRecord | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM oauth_tokens WHERE provider_id = ?", (provider_id,)
        ).fetchone()
    if not row:
        return None
    return TokenRecord(
        provider_id=row["provider_id"],
        access_token=decrypt(row["access_token"]),
        refresh_token=decrypt(row["refresh_token"]) if row["refresh_token"] else None,
        expires_at=row["expires_at"],
        scope=row["scope"],
        account_label=row["account_label"],
    )


def delete(provider_id: str) -> bool:
    with db() as conn:
        cur = conn.execute("DELETE FROM oauth_tokens WHERE provider_id = ?", (provider_id,))
        conn.commit()
        return cur.rowcount > 0


def list_connected() -> list[str]:
    with db() as conn:
        rows = conn.execute("SELECT provider_id FROM oauth_tokens").fetchall()
    return [r["provider_id"] for r in rows]


def get_account_label(provider_id: str) -> str | None:
    with db() as conn:
        row = conn.execute(
            "SELECT account_label FROM oauth_tokens WHERE provider_id = ?", (provider_id,)
        ).fetchone()
    return row["account_label"] if row else None
