#!/usr/bin/env python3
"""web-fetch skill entrypoint.

stdin JSON: {url, query?, max_chars?, top_k?, format?, no_cache?}
stdout JSON (success): {ok, url, status, from_cache, title, content, chars,
                        truncated, [chunks_returned, total_chunks], fetched_at}
stdout JSON (failure): {ok: false, error, status?}
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

# Skill scripts run as a subprocess with cwd = skill_dir (see runner.py),
# so adding the skill root to sys.path lets us import `lib.*`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.fetch import FetchError, fetch  # noqa: E402
from lib.extract import chunk, extract  # noqa: E402
from lib.rank import rank  # noqa: E402


def _emit(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0 if obj.get("ok") else 1


def _iso(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    try:
        params = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        return _emit({"ok": False, "error": f"invalid stdin JSON: {exc}"})

    url = params.get("url")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return _emit({"ok": False, "error": "url must be an absolute http(s) URL"})

    query = params.get("query")
    fmt = params.get("format") or "markdown"
    if fmt not in ("markdown", "text", "raw"):
        return _emit({"ok": False, "error": f"bad format: {fmt!r}"})
    max_chars = int(params.get("max_chars") or 8000)
    top_k = int(params.get("top_k") or 6)
    no_cache = bool(params.get("no_cache") or False)

    try:
        result = fetch(url, no_cache=no_cache)
    except FetchError as exc:
        return _emit({"ok": False, "error": str(exc), "status": exc.status})
    except Exception as exc:  # network / DNS / TLS
        return _emit({"ok": False, "error": f"fetch failed: {exc}"})

    # Decode body as text (trafilatura also accepts bytes, but we want a text
    # handle for raw mode and for length reasoning).
    charset = "utf-8"
    ct = result.content_type.lower()
    if "charset=" in ct:
        charset = ct.split("charset=", 1)[1].split(";", 1)[0].strip() or "utf-8"
    try:
        html_text = result.body.decode(charset, errors="replace")
    except LookupError:
        html_text = result.body.decode("utf-8", errors="replace")

    title: str | None = None
    warning: str | None = None

    if fmt == "raw":
        content = html_text
    else:
        title, extracted = extract(html_text, fmt=fmt)
        if not extracted.strip():
            warning = "empty_content_likely_spa"
            extracted = ""
        content = extracted

    chunks_returned: int | None = None
    total_chunks: int | None = None

    if query and fmt != "raw" and content:
        chunks = chunk(content)
        total_chunks = len(chunks)
        picked = rank(query, chunks, top_k=top_k)
        content = "\n\n---\n\n".join(c for _, _, c in picked)
        chunks_returned = len(picked)

    truncated = False
    if len(content) > max_chars:
        cut = content[:max_chars]
        content = cut + f"\n\n[… truncated {len(html_text) - len(cut)} chars]"
        truncated = True

    out: dict = {
        "ok": True,
        "url": result.url,
        "status": result.status,
        "from_cache": result.from_cache,
        "title": title,
        "content": content,
        "chars": len(content),
        "truncated": truncated,
        "fetched_at": _iso(result.fetched_at),
    }
    if chunks_returned is not None:
        out["chunks_returned"] = chunks_returned
        out["total_chunks"] = total_chunks
    if warning:
        out["warning"] = warning
    return _emit(out)


if __name__ == "__main__":
    sys.exit(main())
