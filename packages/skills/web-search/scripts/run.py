#!/usr/bin/env python3
"""web-search skill entrypoint.

stdin JSON: {query, count?, region?}
stdout JSON (success): {ok: true, query, count_requested, count_returned,
                         source: "duckduckgo-lite", results: [...]}
stdout JSON (failure): {ok: false, error_code, error, guidance, status?}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Skill scripts run as a subprocess with cwd = skill_dir; add skill root
# to sys.path so `lib.*` imports resolve without a package install.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.ddg import SearchError, search  # noqa: E402


def _emit(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0 if obj.get("ok") else 1


def main() -> int:
    try:
        params = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        return _emit({"ok": False, "error": f"invalid stdin JSON: {exc}"})

    query = str(params.get("query", "")).strip()
    if not query:
        return _emit({"ok": False, "error": "missing required 'query' parameter"})
    count_requested = int(params.get("count", 10))
    region = str(params.get("region", "wt-wt"))

    try:
        results = search(query=query, count=count_requested, region=region)
    except SearchError as exc:
        if getattr(exc, "reason", None) == "budget_exceeded":
            return _emit(
                {
                    "ok": False,
                    "error_code": "search_unavailable",
                    "error": "DuckDuckGo did not respond within 20s budget",
                    "guidance": (
                        "Search is taking too long right now. Do NOT fabricate results "
                        "from training data. Either retry web-search later, report "
                        "'web search currently unavailable' to your parent, or ask the "
                        "user for specific URLs to web-fetch directly. Never invent "
                        "URLs or facts."
                    ),
                    "status": None,
                }
            )
        if exc.status == 202:
            return _emit(
                {
                    "ok": False,
                    "error_code": "search_rate_limited",
                    "error": "DuckDuckGo is rate-limiting our requests (HTTP 202 captcha). Search is TEMPORARILY unavailable.",
                    "guidance": (
                        "Do NOT fabricate results from training data. Either "
                        "(1) wait and retry web-search after 60s, "
                        "(2) report 'web search currently unavailable' to your parent and let them decide, "
                        "or (3) ask the user if they can supply specific URLs to web-fetch directly. "
                        "Never invent URLs or release dates."
                    ),
                    "status": 202,
                }
            )
        return _emit(
            {
                "ok": False,
                "error_code": "search_unavailable",
                "error": f"Web search subprocess could not reach DuckDuckGo: {exc}",
                "guidance": (
                    "Do NOT fabricate results from training data. "
                    "Report 'web search currently unavailable' to your parent or ask the user "
                    "for specific URLs to web-fetch. Never invent URLs, dates, or facts."
                ),
                "status": exc.status,
            }
        )
    except Exception as exc:  # noqa: BLE001 — last resort for subprocess safety
        return _emit(
            {
                "ok": False,
                "error_code": "search_unavailable",
                "error": f"unexpected: {type(exc).__name__}: {exc}",
                "guidance": (
                    "Do NOT fabricate results from training data. "
                    "Report 'web search currently unavailable' to your parent or ask the user "
                    "for specific URLs to web-fetch. Never invent URLs, dates, or facts."
                ),
            }
        )

    if not results:
        return _emit(
            {
                "ok": True,
                "query": query,
                "count_requested": count_requested,
                "count_returned": 0,
                "source": "duckduckgo-lite",
                "results": [],
                "warning": "no results parsed — try a different query or region",
            }
        )

    return _emit(
        {
            "ok": True,
            "query": query,
            "count_requested": count_requested,
            "count_returned": len(results),
            "source": "duckduckgo-lite",
            "results": results,
        }
    )


if __name__ == "__main__":
    raise SystemExit(main())
