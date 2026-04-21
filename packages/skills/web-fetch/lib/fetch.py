"""HTTP fetch with a small disk cache that uses ETag / Last-Modified for
revalidation. Keeping this tiny on purpose — no cookie jar, no auth, no
redirect history. We follow redirects and report the final URL.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

CACHE_TTL_SECONDS = 24 * 3600
MAX_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_TIMEOUT = 20.0

# Browser-ish UA. Some sites 403 on anything that looks like a bot / curl.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0 Safari/537.36 OpenHive/0.1"
)


def _cache_root() -> Path:
    # Respect OPENHIVE_HOME if set (tests override it); otherwise ~/.openhive.
    base = os.environ.get("OPENHIVE_HOME")
    root = Path(base) if base else (Path.home() / ".openhive")
    out = root / "cache" / "web"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _cache_dir_for(url: str) -> Path:
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()
    d = _cache_root() / h[:2] / h
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class FetchResult:
    status: int
    url: str  # final URL after redirects
    body: bytes
    content_type: str
    from_cache: bool
    fetched_at: float


def _load_cache(url: str) -> dict | None:
    meta = _cache_dir_for(url) / "meta.json"
    body = _cache_dir_for(url) / "body"
    if not (meta.is_file() and body.is_file()):
        return None
    try:
        m = json.loads(meta.read_text("utf-8"))
    except Exception:
        return None
    m["body"] = body.read_bytes()
    return m


def _save_cache(url: str, *, status: int, final_url: str, body: bytes, headers: httpx.Headers) -> None:
    d = _cache_dir_for(url)
    (d / "body").write_bytes(body)
    meta = {
        "status": status,
        "final_url": final_url,
        "content_type": headers.get("content-type", ""),
        "etag": headers.get("etag", ""),
        "last_modified": headers.get("last-modified", ""),
        "fetched_at": time.time(),
    }
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def fetch(url: str, *, no_cache: bool = False, timeout: float = DEFAULT_TIMEOUT) -> FetchResult:
    """Return the URL's body. Uses cache with ETag revalidation unless no_cache.

    Raises FetchError on non-200 final status or policy violation.
    """
    cached = None if no_cache else _load_cache(url)

    # Fresh cache hit — no network.
    if cached and (time.time() - cached["fetched_at"]) < CACHE_TTL_SECONDS:
        return FetchResult(
            status=cached["status"],
            url=cached["final_url"],
            body=cached["body"],
            content_type=cached["content_type"],
            from_cache=True,
            fetched_at=cached["fetched_at"],
        )

    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
    if cached:
        if cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        if cached.get("last_modified"):
            headers["If-Modified-Since"] = cached["last_modified"]

    with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
        resp = client.get(url)

    # 304 — server says cache is still valid. Refresh fetched_at and return cached body.
    if resp.status_code == 304 and cached:
        d = _cache_dir_for(url)
        try:
            m = json.loads((d / "meta.json").read_text("utf-8"))
            m["fetched_at"] = time.time()
            (d / "meta.json").write_text(json.dumps(m), encoding="utf-8")
        except Exception:
            pass
        return FetchResult(
            status=cached["status"],
            url=cached["final_url"],
            body=cached["body"],
            content_type=cached["content_type"],
            from_cache=True,
            fetched_at=time.time(),
        )

    if resp.status_code >= 400:
        raise FetchError(f"HTTP {resp.status_code}", status=resp.status_code)

    body = resp.content
    if len(body) > MAX_BODY_BYTES:
        raise FetchError(
            f"body too large ({len(body)} bytes > {MAX_BODY_BYTES})",
            status=413,
        )

    _save_cache(
        url,
        status=resp.status_code,
        final_url=str(resp.url),
        body=body,
        headers=resp.headers,
    )
    return FetchResult(
        status=resp.status_code,
        url=str(resp.url),
        body=body,
        content_type=resp.headers.get("content-type", ""),
        from_cache=False,
        fetched_at=time.time(),
    )


class FetchError(Exception):
    def __init__(self, message: str, *, status: int = 0) -> None:
        super().__init__(message)
        self.status = status
