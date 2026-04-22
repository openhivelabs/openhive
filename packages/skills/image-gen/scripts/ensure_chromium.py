"""Ensure Playwright Chromium binary is installed.

Idempotent: exits fast if a chromium cache directory exists, otherwise
runs ``python -m playwright install chromium``. Progress goes to stderr
so stdout stays clean for the skill's JSON envelope.
"""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path


def _candidate_caches() -> list[Path]:
    override = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if override:
        return [Path(override)]
    home = Path.home()
    # Playwright's default cache location varies by OS.
    return [
        home / "Library" / "Caches" / "ms-playwright",  # macOS
        home / ".cache" / "ms-playwright",              # Linux / XDG
        home / "AppData" / "Local" / "ms-playwright",   # Windows
    ]


def chromium_installed() -> bool:
    for cache in _candidate_caches():
        if not cache.exists():
            continue
        try:
            if any(child.name.startswith("chromium") for child in cache.iterdir()):
                return True
        except OSError:
            continue
    return False


def ensure() -> None:
    if chromium_installed():
        return
    print("image-gen: installing Chromium (first run)…", file=sys.stderr)
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        check=True,
        stdout=sys.stderr,
        stderr=sys.stderr,
    )


if __name__ == "__main__":
    ensure()
