"""Shared self-check helpers for bundled OpenHive skill scripts.

Protocol: after a skill script finishes its main work, call
``check_file`` on each produced output and then ``emit_success`` (or
``emit_error`` on the failure path). The runner looks at the LAST line
of stdout — if it is a JSON object with ``ok: true`` / ``ok: false``,
the runner surfaces the structured result to the engine.

Stdout must be pure JSON on the final line; diagnostic chatter goes to
stderr. Keep the protocol machine-parseable so LLMs can read retry
guidance out of ``suggestion``.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any


class EmitError(Exception):
    """Structured error raised by check helpers.

    The runner converts this into a final ``{"ok": false, ...}`` line so
    the LLM sees ``error_code`` + ``suggestion`` instead of a raw
    traceback.
    """

    def __init__(self, code: str, message: str, suggestion: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.suggestion = suggestion


def check_file(path: str, min_bytes: int = 100) -> None:
    """Verify ``path`` exists and is at least ``min_bytes`` bytes.

    Raises ``EmitError("empty_output", ...)`` if the file is missing and
    ``EmitError("tiny_output", ...)`` if it is suspiciously small. Both
    cases carry a ``suggestion`` that gives the LLM a concrete next
    step.
    """
    if not path:
        raise EmitError(
            "empty_output",
            "output path is empty",
            "pass a non-empty --out path when invoking the script",
        )
    if not os.path.exists(path):
        raise EmitError(
            "empty_output",
            f"expected output file was not created: {path}",
            "check that the script reached the write step without an "
            "earlier exception, and that --out points to a writable path",
        )
    try:
        size = os.path.getsize(path)
    except OSError as e:
        raise EmitError(
            "empty_output",
            f"could not stat output file {path}: {e}",
            "verify the path is readable and not on a stale mount",
        ) from e
    if size < min_bytes:
        raise EmitError(
            "tiny_output",
            f"output file {path} is {size} bytes "
            f"(minimum {min_bytes}); likely a malformed or empty document",
            "inspect the spec for missing blocks/content; a valid "
            "document of this type is normally much larger",
        )


def emit_success(
    files: list[dict[str, Any]], warnings: list[str] | None = None
) -> None:
    """Print the final ``{"ok": true, ...}`` line for a successful run.

    ``files`` is the authoritative artifact list. The runner prefers
    this over its directory snapshot when both are available.
    """
    payload: dict[str, Any] = {
        "ok": True,
        "files": list(files),
        "warnings": list(warnings) if warnings else [],
    }
    # Use a dedicated print so nothing after this can accidentally
    # become the "last line" of stdout.
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_error(code: str, message: str, suggestion: str = "") -> None:
    """Print the final ``{"ok": false, ...}`` line and exit non-zero.

    Always exits with status 1 so callers that only look at the exit
    code still see a failure.
    """
    payload = {
        "ok": False,
        "error_code": code,
        "message": message,
        "suggestion": suggestion,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(1)
