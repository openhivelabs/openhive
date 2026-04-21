#!/usr/bin/env python3
"""Convert a simple markdown outline into a pptx spec JSON.

Conventions:
    # Heading 1     → title slide (first one) or section slide
    ## Heading 2    → new bullets slide whose title is the heading
    - list item     → bullet (indent = nested)
    > quote         → quote slide (attribution in trailing '— name' on same line)
    ---             → section divider (next ## becomes section, not bullets)
    (blank lines separate blocks)

Not a full markdown parser. Good enough to turn brainstorm notes into a draft
deck; the agent then tweaks the JSON as needed.

Usage:
    python md_to_spec.py --in outline.md --out spec.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--theme", default="default")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    text = pathlib.Path(args.inp).expanduser().read_text(encoding="utf-8")
    lines = text.splitlines()
    slides: list[dict] = []
    pending_section = False
    first_h1_used = False

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        if line.strip() == "---":
            pending_section = True
            i += 1
            continue
        h1 = re.match(r"^#\s+(.+)$", line)
        h2 = re.match(r"^##\s+(.+)$", line)
        quote = re.match(r"^>\s+(.+)$", line)

        if h1:
            title = h1.group(1).strip()
            if not first_h1_used:
                slides.insert(0, {"type": "title", "title": title})
                first_h1_used = True
            else:
                slides.append({"type": "section", "title": title})
            pending_section = False
            i += 1
        elif h2:
            title = h2.group(1).strip()
            if pending_section:
                slides.append({"type": "section", "title": title})
                pending_section = False
                i += 1
            else:
                # gather bullets under this heading
                bullets, consumed = _consume_bullets(lines, i + 1)
                if bullets:
                    slides.append({"type": "bullets", "title": title, "bullets": bullets})
                else:
                    slides.append({"type": "bullets", "title": title, "bullets": ["(empty)"]})
                i += 1 + consumed
        elif quote:
            q_text = quote.group(1).strip()
            attr = None
            m = re.match(r"^(.*?)\s+[—\-]\s+(.+)$", q_text)
            if m:
                q_text, attr = m.group(1).strip(), m.group(2).strip()
            slide = {"type": "quote", "quote": q_text}
            if attr:
                slide["attribution"] = attr
            slides.append(slide)
            i += 1
        else:
            # stray paragraph — attach as speaker notes to last slide if any
            if slides:
                slides[-1].setdefault("notes", "")
                slides[-1]["notes"] = (slides[-1]["notes"] + "\n" + line).strip()
            i += 1

    if not first_h1_used:
        slides.insert(0, {"type": "title", "title": args.title or pathlib.Path(args.inp).stem})

    spec = {
        "meta": {
            "title": args.title or slides[0].get("title", ""),
            "theme": args.theme,
            "size": "16:9",
        },
        "slides": slides,
    }
    pathlib.Path(args.out).expanduser().write_text(
        json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps({"ok": True, "path": str(args.out), "slides": len(slides)}))
    return 0


def _consume_bullets(lines: list[str], start: int) -> tuple[list, int]:
    """Read bullet lines starting at `start`, returning (nested_bullets, lines_consumed).
    Supports two levels: a bullet more-indented than the base becomes a child of the
    previous base-level bullet. Deeper nesting collapses to level 2 for simplicity.
    Stops at blank line, heading, or non-bullet line.
    """
    out: list = []
    i = start
    base_indent: int | None = None
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            break
        if re.match(r"^#{1,6}\s+", line) or line.strip() == "---":
            break
        m = re.match(r"^(\s*)-\s+(.+)$", line)
        if not m:
            break
        indent = len(m.group(1))
        text = m.group(2).strip()
        if base_indent is None:
            base_indent = indent
        if indent == base_indent:
            out.append(text)
        else:
            if out and isinstance(out[-1], str):
                out.append([text])
            elif out and isinstance(out[-1], list):
                out[-1].append(text)
            else:
                out.append(text)
        i += 1
    return out, i - start


if __name__ == "__main__":
    raise SystemExit(main())
