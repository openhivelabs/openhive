#!/usr/bin/env python3
"""Convert markdown to a PDF-compatible spec JSON.

Same grammar as the docx skill's md_to_spec. Re-uses almost all of its
logic — PDF and docx share the block vocabulary.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--theme", default="default")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    text = pathlib.Path(args.inp).expanduser().read_text(encoding="utf-8")
    blocks: list[dict] = []
    lines = text.splitlines()

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        # fenced code
        if stripped.startswith("```"):
            body = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                body.append(lines[i])
                i += 1
            blocks.append({"type": "code", "text": "\n".join(body)})
            if i < len(lines):
                i += 1
            continue

        m = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if m:
            blocks.append({"type": "heading", "level": len(m.group(1)),
                           "text": m.group(2).strip()})
            i += 1
            continue

        if stripped in {"---", "***", "___"}:
            blocks.append({"type": "horizontal_rule"})
            i += 1
            continue

        if stripped.startswith("> "):
            q_text = stripped[2:]
            attr = None
            m2 = re.match(r"^(.*?)\s+[—\-]\s+(.+)$", q_text)
            if m2:
                q_text, attr = m2.group(1).strip(), m2.group(2).strip()
            blk = {"type": "quote", "text": q_text}
            if attr:
                blk["attribution"] = attr
            blocks.append(blk)
            i += 1
            continue

        m_img = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", stripped)
        if m_img:
            blk = {"type": "image", "path": m_img.group(2)}
            if m_img.group(1):
                blk["caption"] = m_img.group(1)
            blocks.append(blk)
            i += 1
            continue

        if re.match(r"^\s*-\s+", line) or re.match(r"^\s*\d+\.\s+", line):
            ordered = bool(re.match(r"^\s*\d+\.\s+", line))
            items, consumed = _consume_list(lines, i, ordered)
            blocks.append({"type": "numbered" if ordered else "bullets",
                           "items": items})
            i += consumed
            continue

        if "|" in stripped and _looks_like_table(lines, i):
            tbl, consumed = _consume_table(lines, i)
            if tbl:
                blocks.append(tbl)
                i += consumed
                continue

        # paragraph: gather continuation
        para = [stripped]
        j = i + 1
        while j < len(lines) and lines[j].strip() and not _is_new_block(lines[j]):
            para.append(lines[j].strip())
            j += 1
        blocks.append({"type": "paragraph", "text": " ".join(para)})
        i = j

    spec = {
        "meta": {
            "title": args.title or (
                blocks[0]["text"] if blocks and blocks[0].get("type") == "heading"
                else pathlib.Path(args.inp).stem
            ),
            "theme": args.theme,
            "size": "A4",
        },
        "blocks": blocks,
    }
    out = resolve_out(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print(json.dumps({"ok": True, "path": str(out), "blocks": len(blocks)}))
    return 0


def _is_new_block(line: str) -> bool:
    s = line.strip()
    return (
        s.startswith("#") or s.startswith("- ") or s.startswith("> ") or
        bool(re.match(r"^\d+\.\s+", s)) or s.startswith("```") or
        s in {"---", "***", "___"}
    )


def _consume_list(lines: list[str], start: int, ordered: bool) -> tuple[list, int]:
    pat = r"^\s*\d+\.\s+(.+)$" if ordered else r"^\s*-\s+(.+)$"
    out: list = []
    base_indent: int | None = None
    i = start
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            break
        m = re.match(pat, line)
        if not m:
            break
        leading = len(line) - len(line.lstrip())
        if base_indent is None:
            base_indent = leading
        text = m.group(1).strip()
        if leading == base_indent:
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


def _looks_like_table(lines: list[str], start: int) -> bool:
    if start + 1 >= len(lines):
        return False
    sep = lines[start + 1].strip()
    return bool(re.match(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$", sep))


def _consume_table(lines: list[str], start: int) -> tuple[dict | None, int]:
    header_line = lines[start]
    headers = [c.strip() for c in header_line.strip().strip("|").split("|")]
    i = start + 2
    rows = []
    while i < len(lines) and "|" in lines[i]:
        row = [c.strip() for c in lines[i].strip().strip("|").split("|")]
        rows.append(row)
        i += 1
    if not rows:
        return None, 0
    return {"type": "table", "headers": headers, "rows": rows, "style": "grid"}, i - start


if __name__ == "__main__":
    raise SystemExit(main())
