"""Integration tests — spawns run.py as a subprocess, renders real PNGs.

Requires Playwright Chromium installed (see scripts/ensure_chromium.py).
Slow: ~1–2s per case.
"""
from __future__ import annotations
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[1]
RUN = SKILL / "scripts" / "run.py"

TEMPLATE_PAYLOADS = {
    "yt-bold-text": {
        "title": "10x Faster Than You Think",
        "subtitle": "We measured it",
        "bg_style": "gradient",
    },
    "yt-quote": {
        "quote": "Simplicity is the ultimate sophistication.",
        "author": "da Vinci",
    },
    "cover-minimal": {
        "title": "Annual Report 2026",
        "subtitle": "Q1 operations review",
        "meta": "Apr 2026 · internal",
    },
    "stat-card": {
        "value": "+42%",
        "label": "Conversion lift",
        "delta": "vs Q4",
        "tone": "pos",
    },
}


def _run(payload: dict, tmp_path: Path) -> dict:
    env = {**os.environ, "OPENHIVE_OUTPUT_DIR": str(tmp_path)}
    proc = subprocess.run(
        [sys.executable, str(RUN)],
        input=json.dumps(payload).encode(),
        cwd=tmp_path,
        env=env,
        capture_output=True,
        timeout=60,
    )
    out = proc.stdout.decode().strip()
    assert out, f"empty stdout; stderr:\n{proc.stderr.decode()}"
    last = out.splitlines()[-1]
    return json.loads(last)


@pytest.mark.parametrize("template,vars", list(TEMPLATE_PAYLOADS.items()))
def test_template_renders_png(tmp_path, template, vars):
    envelope = _run(
        {"mode": "template", "template": template, "vars": vars}, tmp_path
    )
    assert envelope["ok"], envelope
    assert envelope["files"][0]["mime"] == "image/png"
    assert envelope["files"][0]["size"] > 500
    assert Path(envelope["files"][0]["path"]).exists()


def test_yt_split_with_local_image(tmp_path):
    img = tmp_path / "hero.png"
    # 1x1 red PNG
    img.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
        )
    )
    envelope = _run(
        {
            "mode": "template",
            "template": "yt-split",
            "vars": {
                "title": "Split Layout",
                "subtitle": "Left text, right pic",
                "image_path": f"file://{img}",
            },
        },
        tmp_path,
    )
    assert envelope["ok"], envelope
    assert envelope["files"][0]["size"] > 500


def test_freeform_renders(tmp_path):
    envelope = _run(
        {
            "mode": "freeform",
            "width": 800,
            "height": 400,
            "html": (
                "<html><body style='margin:0;background:#111;color:#fff;"
                "font:bold 120px/1 sans-serif;display:grid;place-items:center;"
                "width:800px;height:400px'>FREEFORM</body></html>"
            ),
        },
        tmp_path,
    )
    assert envelope["ok"], envelope
    assert envelope["files"][0]["size"] > 500


def test_missing_required_var_returns_validation_error(tmp_path):
    envelope = _run(
        {"mode": "template", "template": "yt-bold-text", "vars": {}}, tmp_path
    )
    assert envelope["ok"] is False
    assert envelope["error_code"] == "validation"


def test_unknown_template_returns_template_not_found(tmp_path):
    envelope = _run(
        {"mode": "template", "template": "does-not-exist", "vars": {}}, tmp_path
    )
    assert envelope["ok"] is False
    assert envelope["error_code"] == "template_not_found"


def test_invalid_mode_returns_invalid_mode(tmp_path):
    envelope = _run({"mode": "nope"}, tmp_path)
    assert envelope["ok"] is False
    assert envelope["error_code"] == "invalid_mode"


def test_freeform_rejects_out_of_range_size(tmp_path):
    envelope = _run(
        {"mode": "freeform", "html": "<html></html>", "width": 5000, "height": 5000},
        tmp_path,
    )
    assert envelope["ok"] is False
    assert envelope["error_code"] == "size_out_of_range"
