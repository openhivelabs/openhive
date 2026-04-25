#!/usr/bin/env python3
"""Ad-hoc test for the DDG wall-clock budget guard. Stubs httpx.Client to
return HTTP 202 forever and asserts that search() raises SearchError with
reason='budget_exceeded' within roughly the configured budget window.

Run directly: `python3 packages/skills/web-search/lib/test_ddg_budget.py`
Exits 0 on pass, non-zero with a printed reason on fail.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

# Set the budget BEFORE importing ddg so the module-level constant picks it up.
os.environ["OPENHIVE_WEB_SEARCH_BUDGET_MS"] = "2000"
# Disable rate limiter so we test budget logic, not throttle queueing.
os.environ["OPENHIVE_WEB_SEARCH_MIN_INTERVAL"] = "0"

# Make `lib.ddg` importable when run directly from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import ddg  # noqa: E402


class _FakeResponse:
    status_code = 202
    text = ""


class _FakeClient:
    """Minimal httpx.Client stand-in: every GET/POST returns 202."""

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *_exc) -> None:
        return None

    def get(self, *_args, **_kwargs) -> _FakeResponse:
        return _FakeResponse()

    def post(self, *_args, **_kwargs) -> _FakeResponse:
        return _FakeResponse()


def main() -> int:
    # Patch BOTH the budget constant (in case env was already evaluated) and
    # the httpx.Client used inside _fetch_serp.
    ddg._BUDGET_MS = 2000
    ddg.httpx.Client = _FakeClient  # type: ignore[assignment]

    started = time.monotonic()
    try:
        ddg.search("anything", count=5)
    except ddg.SearchError as exc:
        elapsed = time.monotonic() - started
        if getattr(exc, "reason", None) != "budget_exceeded":
            print(
                f"FAIL: expected reason='budget_exceeded', got reason="
                f"{getattr(exc, 'reason', None)!r} status={exc.status!r} "
                f"message={exc!s}"
            )
            return 1
        if elapsed > 2.3:
            print(f"FAIL: budget guard fired too late: elapsed={elapsed:.3f}s > 2.3s")
            return 1
        print(
            f"PASS: SearchError(reason='budget_exceeded') raised in "
            f"{elapsed:.3f}s (budget=2.0s, slack<=0.3s)"
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: unexpected exception type {type(exc).__name__}: {exc}")
        return 1
    print("FAIL: search() returned without raising — budget guard did not fire")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
