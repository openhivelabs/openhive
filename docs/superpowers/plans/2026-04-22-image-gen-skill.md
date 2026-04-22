# image-gen Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a Python skill at `packages/skills/image-gen/` that renders PNGs from Jinja2 HTML templates (5 starter presets) or freeform HTML via headless Chromium, callable from engine skill runner.

**Architecture:** Python skill, per-call subprocess. stdin JSON → `run.py` dispatches template vs freeform → `render.py` runs Jinja2 + Playwright → PNG written into `OPENHIVE_OUTPUT_DIR`. Chromium is lazy-installed on first invocation. No persistent browser. Output envelope: `{ok, files: [{name, path, mime, size}]}`.

**Tech Stack:** Python 3.12+, Jinja2, jsonschema, playwright (sync API, headless Chromium). Uses existing `packages/skills/_lib/verify.py` helpers.

**Key deviation from spec:** Output contract uses `files: [...]` envelope (engine runner convention), not `path: string` — skill writes into `OPENHIVE_OUTPUT_DIR`/cwd and the runner snapshots or reads the envelope.

---

## File Structure

```
packages/skills/image-gen/
  SKILL.md                     # decision tree, template catalog, I/O contract
  skill.yaml                   # name, runtime=python, entrypoint, caller
  scripts/
    run.py                     # stdin → dispatch → stdout envelope
    render.py                  # Jinja + Playwright
    ensure_chromium.py         # first-call Chromium install
  lib/
    __init__.py
    templates.py               # template loader + schema validation
    paths.py                   # resolve image vars safely
  templates/
    yt-bold-text/{template.html.j2,template.yaml}
    yt-split/{template.html.j2,template.yaml}
    yt-quote/{template.html.j2,template.yaml}
    cover-minimal/{template.html.j2,template.yaml}
    stat-card/{template.html.j2,template.yaml}
  reference/
    freeform-guide.md
    examples.md
  tests/
    test_templates.py          # loader + schema validation
    test_render.py             # integration (Playwright, slow)
    fixtures/
      sample_vars.json
```

---

### Task 1: Add Python dependencies

**Files:**
- Modify: `packages/skills/image-gen/requirements.txt` (create)
- Modify: `package.json` root (if there's a Python install step — otherwise note manual)

- [ ] **Step 1: Create requirements.txt**

```
jinja2>=3.1
jsonschema>=4.20
playwright>=1.47
pyyaml>=6.0
```

- [ ] **Step 2: Install into the venv the skill runner uses**

Run: `python3 -m pip install -r packages/skills/image-gen/requirements.txt`
Expected: installs without error.

- [ ] **Step 3: Commit**

```bash
git add packages/skills/image-gen/requirements.txt
git commit -m "feat(image-gen): declare Python deps"
```

---

### Task 2: Scaffold skill manifest + empty directories

**Files:**
- Create: `packages/skills/image-gen/skill.yaml`
- Create: `packages/skills/image-gen/lib/__init__.py`
- Create: `packages/skills/image-gen/tests/__init__.py`

- [ ] **Step 1: Write skill.yaml**

```yaml
name: image-gen
description: Render PNG images from HTML — 5 built-in templates (YouTube thumbnails, report covers, stat cards) or freeform HTML. Good for text-graphic outputs; not a photo generator.
runtime: python
entrypoint: scripts/run.py
caller: [agent, ui]
```

- [ ] **Step 2: Create empty __init__.py files**

```bash
touch packages/skills/image-gen/lib/__init__.py
touch packages/skills/image-gen/tests/__init__.py
```

- [ ] **Step 3: Commit**

```bash
git add packages/skills/image-gen/
git commit -m "feat(image-gen): scaffold skill manifest"
```

---

### Task 3: Template loader + schema validation (TDD)

**Files:**
- Create: `packages/skills/image-gen/tests/test_templates.py`
- Create: `packages/skills/image-gen/lib/templates.py`
- Create: `packages/skills/image-gen/templates/yt-bold-text/template.yaml` (minimal fixture for test)

- [ ] **Step 1: Write the failing test**

```python
# packages/skills/image-gen/tests/test_templates.py
from pathlib import Path
import pytest
from lib.templates import load_template, list_templates, TemplateNotFound, ValidationError

ROOT = Path(__file__).resolve().parents[1]

def test_list_templates_includes_yt_bold_text():
    names = list_templates(ROOT / "templates")
    assert "yt-bold-text" in names

def test_load_template_reads_size_and_schema():
    tpl = load_template(ROOT / "templates", "yt-bold-text")
    assert tpl.size == (1280, 720)
    assert "title" in tpl.schema["properties"]

def test_load_missing_template_raises():
    with pytest.raises(TemplateNotFound):
        load_template(ROOT / "templates", "nonexistent")

def test_validate_vars_rejects_missing_required():
    tpl = load_template(ROOT / "templates", "yt-bold-text")
    with pytest.raises(ValidationError):
        tpl.validate({})   # title is required

def test_validate_vars_accepts_full_payload():
    tpl = load_template(ROOT / "templates", "yt-bold-text")
    tpl.validate({"title": "Hello", "subtitle": "World", "accent": "#ff0044"})
```

- [ ] **Step 2: Write minimal yt-bold-text/template.yaml to satisfy fixture**

```yaml
# packages/skills/image-gen/templates/yt-bold-text/template.yaml
name: yt-bold-text
description: YouTube thumbnail — bold title with optional subtitle on gradient or solid background.
size: { width: 1280, height: 720 }
inputs:
  type: object
  required: [title]
  properties:
    title: { type: string, maxLength: 120 }
    subtitle: { type: string, maxLength: 160 }
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#ff4d4d" }
    bg_style: { type: string, enum: [solid, gradient], default: gradient }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/skills/image-gen && python3 -m pytest tests/test_templates.py -v`
Expected: ImportError on `lib.templates`.

- [ ] **Step 4: Implement templates.py**

```python
# packages/skills/image-gen/lib/templates.py
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as _JSValidationError


class TemplateNotFound(Exception): ...
class ValidationError(Exception): ...


@dataclass(frozen=True)
class Template:
    name: str
    description: str
    size: tuple[int, int]
    schema: dict[str, Any]
    root: Path

    @property
    def html_path(self) -> Path:
        return self.root / "template.html.j2"

    def validate(self, vars: dict[str, Any]) -> dict[str, Any]:
        validator = Draft202012Validator(self.schema)
        errors = sorted(validator.iter_errors(vars), key=lambda e: e.path)
        if errors:
            first = errors[0]
            raise ValidationError(f"{'/'.join(map(str, first.path)) or '<root>'}: {first.message}")
        # Fill defaults (jsonschema doesn't do this automatically)
        filled = dict(vars)
        for key, prop in self.schema.get("properties", {}).items():
            if key not in filled and "default" in prop:
                filled[key] = prop["default"]
        return filled


def list_templates(templates_dir: Path) -> list[str]:
    return sorted(p.name for p in templates_dir.iterdir() if p.is_dir() and (p / "template.yaml").exists())


def load_template(templates_dir: Path, name: str) -> Template:
    root = templates_dir / name
    meta_path = root / "template.yaml"
    if not meta_path.exists():
        raise TemplateNotFound(name)
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
    size = meta["size"]
    return Template(
        name=meta["name"],
        description=meta.get("description", ""),
        size=(int(size["width"]), int(size["height"])),
        schema=meta["inputs"],
        root=root,
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/skills/image-gen && PYTHONPATH=. python3 -m pytest tests/test_templates.py -v`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/image-gen/lib/ packages/skills/image-gen/tests/test_templates.py packages/skills/image-gen/templates/yt-bold-text/template.yaml
git commit -m "feat(image-gen): template loader + JSON Schema validation"
```

---

### Task 4: ensure_chromium helper

**Files:**
- Create: `packages/skills/image-gen/scripts/ensure_chromium.py`

- [ ] **Step 1: Write the helper**

```python
# packages/skills/image-gen/scripts/ensure_chromium.py
"""Ensure Playwright Chromium binary is installed.

Idempotent: exits fast if `~/.cache/ms-playwright/chromium-*` exists,
otherwise runs `python -m playwright install chromium`. stderr carries
progress; stdout stays clean for the JSON envelope.
"""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path


def chromium_installed() -> bool:
    cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache" / "ms-playwright")
    if not cache.exists():
        return False
    return any(child.name.startswith("chromium") for child in cache.iterdir())


def ensure() -> None:
    if chromium_installed():
        return
    print("image-gen: installing Chromium (first run)…", file=sys.stderr)
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        check=True,
        stdout=sys.stderr,   # silence stdout
        stderr=sys.stderr,
    )


if __name__ == "__main__":
    ensure()
```

- [ ] **Step 2: Smoke-run (no-op if already installed)**

Run: `python3 packages/skills/image-gen/scripts/ensure_chromium.py`
Expected: exit 0, either silent or a one-time "installing Chromium…" message followed by success.

- [ ] **Step 3: Commit**

```bash
git add packages/skills/image-gen/scripts/ensure_chromium.py
git commit -m "feat(image-gen): lazy Chromium install helper"
```

---

### Task 5: Render module (Jinja2 + Playwright)

**Files:**
- Create: `packages/skills/image-gen/scripts/render.py`

- [ ] **Step 1: Write render.py**

```python
# packages/skills/image-gen/scripts/render.py
"""Render HTML → PNG via headless Chromium."""
from __future__ import annotations
import sys
from pathlib import Path

import jinja2
from playwright.sync_api import sync_playwright


def render_template(template_html_path: Path, vars: dict) -> str:
    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(template_html_path.parent),
        autoescape=jinja2.select_autoescape(["html"]),
        undefined=jinja2.StrictUndefined,
    )
    tmpl = env.get_template(template_html_path.name)
    return tmpl.render(**vars)


def render_png(html: str, width: int, height: int, out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=2,
            )
            page = context.new_page()
            try:
                page.set_content(html, wait_until="networkidle", timeout=10_000)
            except Exception as exc:
                # Network flake on freeform templates that pull external assets.
                # Take the shot anyway so the caller gets *something*.
                print(f"image-gen: set_content warning: {exc}", file=sys.stderr)
            page.screenshot(path=str(out_path), omit_background=False, full_page=False)
        finally:
            browser.close()
    return out_path.stat().st_size
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/image-gen/scripts/render.py
git commit -m "feat(image-gen): Jinja2 + Playwright render pipeline"
```

---

### Task 6: run.py entry (stdin → dispatch → envelope)

**Files:**
- Create: `packages/skills/image-gen/scripts/run.py`

- [ ] **Step 1: Write run.py**

```python
#!/usr/bin/env python3
"""image-gen skill entrypoint.

stdin JSON:
  template mode: {mode: "template", template: "<name>", vars: {...}, filename?: "out.png"}
  freeform mode: {mode: "freeform", html: "<...>", width: int, height: int, filename?: "out.png"}

stdout envelope (last line):
  success: {ok: true, files: [{name, path, mime, size}], warnings: []}
  failure: {ok: false, error_code, message, suggestion}
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

# Make `lib.*` importable regardless of cwd (runner sets cwd=OPENHIVE_OUTPUT_DIR).
SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))
sys.path.insert(0, str(SKILL_DIR.parent))  # for _lib.verify

from lib.templates import load_template, list_templates, TemplateNotFound, ValidationError  # noqa: E402
from scripts.render import render_template, render_png  # noqa: E402
from scripts.ensure_chromium import ensure as ensure_chromium  # noqa: E402
from _lib.verify import emit_success, emit_error, check_file  # noqa: E402


OUTPUT_DIR = Path(os.environ.get("OPENHIVE_OUTPUT_DIR") or ".").resolve()
TEMPLATES_DIR = SKILL_DIR / "templates"


def _default_filename() -> str:
    return f"image-gen-{int(time.time() * 1000)}.png"


def main() -> None:
    try:
        params = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        emit_error("invalid_input", f"stdin is not valid JSON: {exc}",
                   "the runner must pipe a JSON object on stdin")

    mode = params.get("mode")
    filename = params.get("filename") or _default_filename()
    if "/" in filename or ".." in filename:
        emit_error("invalid_filename", f"filename must be a plain name, got {filename!r}",
                   "pass only the base filename; the skill writes into OPENHIVE_OUTPUT_DIR")
    out_path = OUTPUT_DIR / filename

    try:
        if mode == "template":
            name = params.get("template")
            if not isinstance(name, str):
                emit_error("missing_template", "`template` must be a string",
                           f"known templates: {list_templates(TEMPLATES_DIR)}")
            try:
                tpl = load_template(TEMPLATES_DIR, name)
            except TemplateNotFound:
                emit_error(
                    "template_not_found",
                    f"template {name!r} does not exist",
                    f"pick one of: {list_templates(TEMPLATES_DIR)}",
                )
            vars_in = params.get("vars") or {}
            try:
                vars_filled = tpl.validate(vars_in)
            except ValidationError as exc:
                emit_error("validation", str(exc),
                           f"see SKILL.md for the {name} input schema")
            html = render_template(tpl.html_path, vars_filled)
            width, height = tpl.size

        elif mode == "freeform":
            html = params.get("html")
            width = params.get("width")
            height = params.get("height")
            if not isinstance(html, str) or not html.strip():
                emit_error("missing_html", "`html` must be a non-empty string",
                           "provide a full HTML document for freeform mode")
            if not isinstance(width, int) or not isinstance(height, int):
                emit_error("missing_size", "`width` and `height` must be integers",
                           "supply target pixel dimensions (e.g. 1280x720)")
            if not (100 <= width <= 4096 and 100 <= height <= 4096):
                emit_error("size_out_of_range", f"size {width}x{height} out of [100, 4096]",
                           "pick a reasonable pixel size; giant images will OOM Chromium")

        else:
            emit_error("invalid_mode", f"mode must be 'template' or 'freeform', got {mode!r}",
                       "see SKILL.md for supported modes")

        ensure_chromium()
        bytes_written = render_png(html, width, height, out_path)

        try:
            check_file(str(out_path), min_bytes=200)
        except Exception as exc:
            emit_error("output_sanity", f"rendered PNG looks malformed: {exc}",
                       "inspect stderr for Playwright warnings; template HTML may be empty")

        emit_success(
            files=[{
                "name": out_path.name,
                "path": str(out_path),
                "mime": "image/png",
                "size": bytes_written,
            }],
            warnings=[],
        )

    except SystemExit:
        raise
    except Exception as exc:  # defensive — don't leak tracebacks as "ok: true"
        emit_error("unexpected", f"{type(exc).__name__}: {exc}",
                   "report this as a skill bug; stderr has the traceback")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/image-gen/scripts/run.py
git commit -m "feat(image-gen): run.py dispatch + envelope"
```

---

### Task 7: Build the five templates

**Files:**
- Create: `packages/skills/image-gen/templates/yt-bold-text/template.html.j2`
- Create: `packages/skills/image-gen/templates/yt-split/{template.yaml,template.html.j2}`
- Create: `packages/skills/image-gen/templates/yt-quote/{template.yaml,template.html.j2}`
- Create: `packages/skills/image-gen/templates/cover-minimal/{template.yaml,template.html.j2}`
- Create: `packages/skills/image-gen/templates/stat-card/{template.yaml,template.html.j2}`

- [ ] **Step 1: yt-bold-text HTML**

```html
<!-- packages/skills/image-gen/templates/yt-bold-text/template.html.j2 -->
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  html, body { margin:0; padding:0; width:1280px; height:720px;
    font-family: 'Inter', 'Pretendard', system-ui, sans-serif;
    color:#fff;
    background: {% if bg_style == 'solid' %}{{ accent }}{% else %}linear-gradient(135deg, {{ accent }} 0%, #0a0a0a 100%){% endif %};
    display:flex; flex-direction:column; justify-content:center; padding:96px; box-sizing:border-box;
    overflow:hidden;
  }
  h1 { font-size: 112px; line-height:1.05; margin:0; font-weight:900; letter-spacing:-0.03em; text-wrap:balance; }
  p  { font-size: 40px; margin:32px 0 0 0; opacity:0.82; font-weight:500; max-width:1000px; }
  .bar { position:absolute; left:0; bottom:0; height:14px; width:100%; background:{{ accent }}; }
</style></head>
<body>
  <h1>{{ title }}</h1>
  {% if subtitle %}<p>{{ subtitle }}</p>{% endif %}
  {% if bg_style != 'solid' %}<div class="bar"></div>{% endif %}
</body></html>
```

- [ ] **Step 2: yt-split template.yaml + html**

```yaml
# templates/yt-split/template.yaml
name: yt-split
description: YouTube thumbnail — left column text, right column image slot. image_path can be an absolute local path or a http(s) URL.
size: { width: 1280, height: 720 }
inputs:
  type: object
  required: [title, image_path]
  properties:
    title: { type: string, maxLength: 100 }
    subtitle: { type: string, maxLength: 120 }
    image_path: { type: string, minLength: 1 }
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#111827" }
```

```html
<!-- templates/yt-split/template.html.j2 -->
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:720px;font-family:'Inter',system-ui,sans-serif;color:#fff;background:{{ accent }};display:flex;overflow:hidden}
  .text{flex:1;padding:80px;display:flex;flex-direction:column;justify-content:center}
  h1{font-size:92px;line-height:1.04;margin:0;font-weight:900;letter-spacing:-0.02em}
  p{font-size:34px;margin:24px 0 0;opacity:0.8;font-weight:500}
  .img{flex:1;background:url("{{ image_path }}") center/cover no-repeat}
</style></head><body>
  <div class="text"><h1>{{ title }}</h1>{% if subtitle %}<p>{{ subtitle }}</p>{% endif %}</div>
  <div class="img"></div>
</body></html>
```

- [ ] **Step 3: yt-quote template**

```yaml
# templates/yt-quote/template.yaml
name: yt-quote
description: YouTube thumbnail — large quote with attribution. Good for interview recaps or report pull-quotes.
size: { width: 1280, height: 720 }
inputs:
  type: object
  required: [quote]
  properties:
    quote: { type: string, maxLength: 260 }
    author: { type: string, maxLength: 80 }
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#fbbf24" }
```

```html
<!-- templates/yt-quote/template.html.j2 -->
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:720px;font-family:'Inter',system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:100px;box-sizing:border-box}
  .mark{font-size:220px;line-height:0.6;color:{{ accent }};font-family:Georgia,serif;margin-bottom:20px}
  blockquote{font-size:64px;line-height:1.2;margin:0;font-weight:700;max-width:1080px;letter-spacing:-0.01em}
  cite{display:block;margin-top:48px;font-size:30px;color:{{ accent }};font-style:normal;font-weight:600;letter-spacing:0.08em;text-transform:uppercase}
</style></head><body>
  <div class="mark">“</div>
  <blockquote>{{ quote }}</blockquote>
  {% if author %}<cite>— {{ author }}</cite>{% endif %}
</body></html>
```

- [ ] **Step 4: cover-minimal template**

```yaml
# templates/cover-minimal/template.yaml
name: cover-minimal
description: Report/presentation cover — clean title, subtitle, small metadata block.
size: { width: 1600, height: 900 }
inputs:
  type: object
  required: [title]
  properties:
    title: { type: string, maxLength: 140 }
    subtitle: { type: string, maxLength: 200 }
    meta: { type: string, maxLength: 120 }
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#2563eb" }
```

```html
<!-- templates/cover-minimal/template.html.j2 -->
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1600px;height:900px;font-family:'Inter',system-ui,sans-serif;background:#fafafa;color:#111;padding:120px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between}
  .top{border-top:8px solid {{ accent }};padding-top:48px;width:120px}
  h1{font-size:104px;line-height:1.05;margin:0;font-weight:800;letter-spacing:-0.03em;max-width:1300px}
  p{font-size:36px;margin:32px 0 0;color:#555;max-width:1200px;line-height:1.4}
  .meta{font-size:22px;letter-spacing:0.15em;color:#888;text-transform:uppercase}
</style></head><body>
  <div><div class="top"></div><h1 style="margin-top:64px">{{ title }}</h1>{% if subtitle %}<p>{{ subtitle }}</p>{% endif %}</div>
  {% if meta %}<div class="meta">{{ meta }}</div>{% endif %}
</body></html>
```

- [ ] **Step 5: stat-card template**

```yaml
# templates/stat-card/template.yaml
name: stat-card
description: Square stat card — big value, label, optional delta. tone tints the delta color.
size: { width: 1080, height: 1080 }
inputs:
  type: object
  required: [value, label]
  properties:
    value: { type: string, maxLength: 24 }
    label: { type: string, maxLength: 80 }
    delta: { type: string, maxLength: 24 }
    tone:  { type: string, enum: [pos, neg, neutral], default: neutral }
    accent: { type: string, pattern: "^#[0-9a-fA-F]{6}$", default: "#0ea5e9" }
```

```html
<!-- templates/stat-card/template.html.j2 -->
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1080px;height:1080px;font-family:'Inter',system-ui,sans-serif;background:#0b1220;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:96px;box-sizing:border-box}
  .label{font-size:32px;letter-spacing:0.15em;text-transform:uppercase;color:{{ accent }};font-weight:600}
  .value{font-size:260px;line-height:1;margin:32px 0;font-weight:900;letter-spacing:-0.04em}
  .delta{font-size:46px;font-weight:700;padding:16px 28px;border-radius:16px;display:inline-block;
    background:{% if tone == 'pos' %}#052e1c{% elif tone == 'neg' %}#3f0f14{% else %}#1f2937{% endif %};
    color:{% if tone == 'pos' %}#22c55e{% elif tone == 'neg' %}#ef4444{% else %}#e5e7eb{% endif %};}
</style></head><body>
  <div class="label">{{ label }}</div>
  <div class="value">{{ value }}</div>
  {% if delta %}<div class="delta">{{ delta }}</div>{% endif %}
</body></html>
```

- [ ] **Step 6: Commit**

```bash
git add packages/skills/image-gen/templates/
git commit -m "feat(image-gen): 5 starter templates"
```

---

### Task 8: Integration test — render every template to PNG

**Files:**
- Create: `packages/skills/image-gen/tests/test_render.py`

- [ ] **Step 1: Write test (slow, requires Chromium installed)**

```python
# packages/skills/image-gen/tests/test_render.py
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[1]
RUN = SKILL / "scripts" / "run.py"

PAYLOADS = {
    "yt-bold-text": {"title": "10x Faster Than You Think", "subtitle": "We measured it", "bg_style": "gradient"},
    "yt-quote": {"quote": "Simplicity is the ultimate sophistication.", "author": "da Vinci"},
    "cover-minimal": {"title": "Annual Report 2026", "subtitle": "Q1 operations review", "meta": "Apr 2026 · internal"},
    "stat-card": {"value": "+42%", "label": "Conversion lift", "delta": "vs Q4", "tone": "pos"},
}


@pytest.mark.parametrize("template,vars", list(PAYLOADS.items()))
def test_template_renders_png(tmp_path, template, vars):
    env = {**os.environ, "OPENHIVE_OUTPUT_DIR": str(tmp_path)}
    payload = {"mode": "template", "template": template, "vars": vars}
    proc = subprocess.run(
        [sys.executable, str(RUN)],
        input=json.dumps(payload).encode(),
        cwd=tmp_path,
        env=env,
        capture_output=True,
        timeout=60,
    )
    last = proc.stdout.decode().strip().splitlines()[-1]
    envelope = json.loads(last)
    assert envelope["ok"], f"stderr: {proc.stderr.decode()}"
    assert envelope["files"][0]["mime"] == "image/png"
    assert envelope["files"][0]["size"] > 500
    assert Path(envelope["files"][0]["path"]).exists()


def test_freeform_renders(tmp_path):
    env = {**os.environ, "OPENHIVE_OUTPUT_DIR": str(tmp_path)}
    payload = {
        "mode": "freeform",
        "width": 800, "height": 400,
        "html": "<html><body style='margin:0;background:#111;color:#fff;font:bold 120px/1 sans-serif;display:grid;place-items:center;width:800px;height:400px'>FREEFORM</body></html>",
    }
    proc = subprocess.run(
        [sys.executable, str(RUN)],
        input=json.dumps(payload).encode(),
        cwd=tmp_path, env=env, capture_output=True, timeout=60,
    )
    last = proc.stdout.decode().strip().splitlines()[-1]
    env_out = json.loads(last)
    assert env_out["ok"], proc.stderr.decode()
    assert env_out["files"][0]["size"] > 500


def test_missing_required_var_returns_validation_error(tmp_path):
    env = {**os.environ, "OPENHIVE_OUTPUT_DIR": str(tmp_path)}
    proc = subprocess.run(
        [sys.executable, str(RUN)],
        input=json.dumps({"mode": "template", "template": "yt-bold-text", "vars": {}}).encode(),
        cwd=tmp_path, env=env, capture_output=True, timeout=30,
    )
    last = proc.stdout.decode().strip().splitlines()[-1]
    env_out = json.loads(last)
    assert env_out["ok"] is False
    assert env_out["error_code"] == "validation"
```

- [ ] **Step 2: Install playwright Chromium (one-time)**

Run: `python3 -m playwright install chromium`
Expected: downloads ~170MB, exits 0.

- [ ] **Step 3: Run the tests**

Run: `cd packages/skills/image-gen && PYTHONPATH=. python3 -m pytest tests/test_render.py -v`
Expected: 6 passed (4 parametrized + freeform + validation).

- [ ] **Step 4: Also run yt-split (separate because it needs a real image file)**

Add to test file:

```python
def test_yt_split_with_local_image(tmp_path):
    img = tmp_path / "hero.png"
    # 1x1 red PNG
    import base64
    img.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="))
    env = {**os.environ, "OPENHIVE_OUTPUT_DIR": str(tmp_path)}
    payload = {"mode": "template", "template": "yt-split",
               "vars": {"title": "Split Layout", "subtitle": "Left text, right pic", "image_path": f"file://{img}"}}
    proc = subprocess.run([sys.executable, str(RUN)], input=json.dumps(payload).encode(),
                          cwd=tmp_path, env=env, capture_output=True, timeout=60)
    env_out = json.loads(proc.stdout.decode().strip().splitlines()[-1])
    assert env_out["ok"], proc.stderr.decode()
```

Re-run: `cd packages/skills/image-gen && PYTHONPATH=. python3 -m pytest tests/test_render.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/image-gen/tests/test_render.py
git commit -m "test(image-gen): integration — each template + freeform + validation"
```

---

### Task 9: SKILL.md (LLM-facing decision tree)

**Files:**
- Create: `packages/skills/image-gen/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: image-gen
description: Render PNG images from HTML. Two modes — template (pick a built-in preset + fill vars, ~hundreds of tokens) or freeform (provide full HTML, kB of tokens). Good for text-first graphics: YouTube thumbnails, report covers, stat cards. NOT a photo generator.
---

# image-gen skill

## Decision tree

```
무엇을 만들 건가?
│
├─ 유튜브 썸네일 / 표지 / 지표 카드 같이 정해진 레이아웃
│   → template 모드로 호출. 아래 카탈로그에서 고르고 vars 채움.
│
└─ 카탈로그에 맞는 레이아웃이 없음 (독자적인 디자인 필요)
    → freeform 모드. 직접 HTML/CSS 작성 후 width/height 명시.
      reference/freeform-guide.md 먼저 읽기.
```

**기본은 template 모드.** freeform 은 토큰을 10배 이상 쓰니 템플릿이 안 맞을 때만.

## 템플릿 카탈로그

| name | size | 용도 | 필수 vars |
| --- | --- | --- | --- |
| `yt-bold-text` | 1280×720 | 큰 제목 + 부제, YouTube 썸네일 범용 | title |
| `yt-split` | 1280×720 | 좌 텍스트 / 우 이미지 | title, image_path |
| `yt-quote` | 1280×720 | 인용구 + 저자 | quote |
| `cover-minimal` | 1600×900 | 보고서/프레젠테이션 표지 | title |
| `stat-card` | 1080×1080 | 큰 숫자 지표 카드 | value, label |

각 템플릿의 전체 입력 스키마는 `templates/<name>/template.yaml` 참조.

## Input 규약

### template 모드
```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": { "title": "…", "subtitle": "…", "accent": "#ff4d4d" },
  "filename": "thumbnail.png"      // optional; default: image-gen-<timestamp>.png
}
```

### freeform 모드
```json
{
  "mode": "freeform",
  "html": "<!doctype html><html>…",
  "width": 1280,
  "height": 720,
  "filename": "custom.png"
}
```

## Output 규약

성공:
```json
{"ok": true, "files": [{"name": "thumbnail.png", "path": "/abs/...", "mime": "image/png", "size": 73412}], "warnings": []}
```

실패 (선택된 `error_code`):
- `validation` — vars 가 스키마에 안 맞음. `message` 에 경로 + 사유.
- `template_not_found` — 존재하지 않는 템플릿.
- `invalid_mode` — mode 가 template/freeform 이 아님.
- `size_out_of_range` — 100~4096 벗어남.
- `output_sanity` — 렌더 결과 PNG 가 너무 작음 (보통 빈 HTML).

## 주의사항

- 로컬 이미지 경로를 `image_path` 등에 넘길 땐 `file:///abs/path` 또는 http(s) URL.
- 외부 폰트/이미지 로딩 실패 시 10s 타임아웃 뒤 현 상태로 스크린샷 — 폰트가 없으면 시스템 기본 폰트로 보일 수 있음.
- 이 skill 은 photo-realistic 이미지를 만들지 않는다. 인물/제품 사진이 필요하면 다른 수단으로.
```

- [ ] **Step 2: Commit**

```bash
git add packages/skills/image-gen/SKILL.md
git commit -m "docs(image-gen): SKILL.md with decision tree + catalog"
```

---

### Task 10: Freeform guide + examples

**Files:**
- Create: `packages/skills/image-gen/reference/freeform-guide.md`
- Create: `packages/skills/image-gen/reference/examples.md`

- [ ] **Step 1: freeform-guide.md**

```markdown
# freeform mode guide

Use freeform only when no `template` matches. It costs ~10× more tokens.

## 기본 원칙

1. **전체 HTML 문서를 보내라.** `<!doctype html><html>…</html>` 전부.
2. **body width/height 를 픽셀로 고정.** viewport 와 일치해야 한다:
   ```css
   html, body { margin:0; width:1280px; height:720px; overflow:hidden; }
   ```
3. **폰트는 system stack 을 우선 써라** — Google Fonts 는 networkidle 로딩에 의존하므로 느리고 가끔 실패한다.
   ```css
   font-family: 'Inter', 'Pretendard', system-ui, -apple-system, sans-serif;
   ```
4. **이미지는 `file://` 절대경로 또는 https URL.** 로컬 상대경로는 안 된다.

## 권장 사이즈 프리셋

| 용도 | W × H |
| --- | --- |
| YouTube 썸네일 | 1280 × 720 |
| OG Image / 트위터 카드 | 1200 × 630 |
| Instagram 정사각 | 1080 × 1080 |
| 보고서 커버 (16:9) | 1600 × 900 |
| Story 세로형 | 1080 × 1920 |

## 피할 것

- JS 기반 차트 라이브러리 (Chart.js 등) 로딩 — `wait_until=networkidle` 와 불안정. 차트가 필요하면 SVG 로 직접 그려라.
- 애니메이션 — 첫 프레임에 의미 있는 상태가 나오게.
- `position:fixed` + 스크롤 의존 레이아웃 — viewport 안에 모든 게 들어와야 함.
```

- [ ] **Step 2: examples.md**

```markdown
# image-gen examples

## 1. YouTube 썸네일 — bold text

```json
{
  "mode": "template",
  "template": "yt-bold-text",
  "vars": {
    "title": "AGI is not close. Here's why.",
    "subtitle": "A deep dive into scaling limits",
    "accent": "#ef4444",
    "bg_style": "gradient"
  },
  "filename": "agi-not-close.png"
}
```

## 2. 분기 실적 카드

```json
{
  "mode": "template",
  "template": "stat-card",
  "vars": {
    "value": "+42%",
    "label": "Q1 revenue",
    "delta": "YoY",
    "tone": "pos",
    "accent": "#22c55e"
  }
}
```

## 3. 보고서 커버

```json
{
  "mode": "template",
  "template": "cover-minimal",
  "vars": {
    "title": "2026 Agent Platform Review",
    "subtitle": "OpenHive · internal architecture retrospective",
    "meta": "2026-04-22 · prepared by Core"
  }
}
```

## 4. Freeform — 특이 레이아웃

```json
{
  "mode": "freeform",
  "width": 1200,
  "height": 630,
  "html": "<!doctype html><html><head><style>html,body{margin:0;width:1200px;height:630px;display:grid;place-items:center;background:radial-gradient(circle at 30% 30%,#6366f1,#0b1020);font-family:system-ui,sans-serif;color:#fff}.card{padding:64px 96px;background:#0b1020;border-radius:32px;box-shadow:0 40px 80px rgba(0,0,0,.4);text-align:center}h1{font-size:96px;margin:0;font-weight:900;letter-spacing:-.03em}p{font-size:28px;margin:16px 0 0;color:#a5b4fc}</style></head><body><div class='card'><h1>Hello OpenHive</h1><p>Freeform rendered via Chromium</p></div></body></html>"
}
```
```

- [ ] **Step 3: Commit**

```bash
git add packages/skills/image-gen/reference/
git commit -m "docs(image-gen): freeform guide + examples"
```

---

### Task 11: Final sanity run + commit

- [ ] **Step 1: Run full test suite**

Run: `cd packages/skills/image-gen && PYTHONPATH=. python3 -m pytest tests/ -v`
Expected: all green.

- [ ] **Step 2: Verify file tree**

Run: `find packages/skills/image-gen -type f | sort`
Expected: manifest, SKILL.md, 3 scripts, 2 lib files, 10 template files (5×2), 2 reference docs, 2 tests, requirements.

- [ ] **Step 3: Smoke-run one render end-to-end**

Run:
```bash
mkdir -p /tmp/image-gen-smoke
cd packages/skills/image-gen
echo '{"mode":"template","template":"yt-bold-text","vars":{"title":"Smoke test","subtitle":"image-gen is alive","accent":"#0ea5e9"}}' | \
  OPENHIVE_OUTPUT_DIR=/tmp/image-gen-smoke PYTHONPATH=. python3 scripts/run.py
ls -la /tmp/image-gen-smoke/
```
Expected: JSON `{"ok":true,...}`, a .png of ~50–200kB in `/tmp/image-gen-smoke/`.

- [ ] **Step 4: Commit if anything was changed during the smoke run**

```bash
git status
# If clean, skip. Otherwise:
git add -A && git commit -m "chore(image-gen): final tweaks after integration smoke"
```

---

## Self-review notes

- **Spec coverage:** each spec section maps — modes (Tasks 3/6), templates (Task 7), render pipeline (Tasks 4/5), I/O contract (Task 6, adjusted to runner `files[]` envelope), tests (Tasks 3/8), resource strategy (Task 4 lazy Chromium), SKILL.md (Task 9), freeform guide (Task 10).
- **Deviation:** spec had `out_path` in I/O; plan uses `filename` + `OPENHIVE_OUTPUT_DIR` to match engine runner. Documented in SKILL.md.
- **Deferred per memory `project_sandbox_deferred`:** no domain filter on outbound fetches, no skill-level timeout override. MVP baseline.
- **No placeholders.** Each file has full code. Templates have both yaml + html.
