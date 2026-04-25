#!/usr/bin/env python3
"""text-file skill: write a single text file into OPENHIVE_OUTPUT_DIR."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    try:
        params = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"invalid stdin JSON: {exc}", file=sys.stderr)
        return 2

    filename = params.get("filename")
    content = params.get("content")
    if not isinstance(filename, str) or not filename:
        print("missing 'filename'", file=sys.stderr)
        return 2
    if not isinstance(content, str):
        print("missing 'content' (string)", file=sys.stderr)
        return 2
    # Reject path traversal and subdirectories — keep writes flat in OUTPUT_DIR.
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        # Stay actionable: tell the model exactly how to recover (basename only)
        # and why (artifact dir is the only sandboxed write target).
        from os.path import basename
        bare = basename(filename.replace("\\", "/")) or "output.txt"
        print(
            f"filename must be a bare name (no '/' or '\\\\'). Got {filename!r} — "
            f"retry with {bare!r}. Output is written to the run's artifact "
            f"directory; absolute paths are not supported.",
            file=sys.stderr,
        )
        return 2

    out_dir_env = os.environ.get("OPENHIVE_OUTPUT_DIR")
    if not out_dir_env:
        print("OPENHIVE_OUTPUT_DIR not set", file=sys.stderr)
        return 2
    out_dir = Path(out_dir_env)
    out_dir.mkdir(parents=True, exist_ok=True)

    target = out_dir / filename
    target.write_text(content, encoding="utf-8")
    size = target.stat().st_size
    print(json.dumps({"wrote": filename, "bytes": size}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
