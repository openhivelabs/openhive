#!/usr/bin/env python3
"""Scaffold a new agent persona — directory or single-file form.

Usage:
    # directory form (rich persona)
    python scaffold_agent.py --name sales-lead --template lead --out ~/.openhive/agents/sales-lead

    # single-file form (lightweight)
    python scaffold_agent.py --name greeter --template writer --single-file --out ~/.openhive/agents/greeter.md

Templates: lead, researcher, reviewer, writer (see reference/templates.md).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent


TEMPLATES = ("lead", "researcher", "reviewer", "writer")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True,
                    help="persona name (lowercase, hyphen-separated)")
    ap.add_argument("--template", default="writer", choices=TEMPLATES)
    ap.add_argument("--out", required=True)
    ap.add_argument("--single-file", action="store_true",
                    help="Emit one .md file instead of a directory.")
    ap.add_argument("--description", default="",
                    help="One-line persona description (goes into frontmatter).")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if not _valid_name(args.name):
        _fail("name must be lowercase letters/digits/hyphens only")
        return 1

    out = pathlib.Path(args.out).expanduser().resolve()
    template_dir = SKILL_ROOT / "templates" / args.template
    if not template_dir.is_dir():
        _fail(f"unknown template: {args.template}")
        return 1

    description = args.description or _default_description(args.template)

    if args.single_file:
        if out.is_dir() or out.suffix != ".md":
            _fail("--single-file --out must be an .md path (not a directory)")
            return 1
        if out.exists() and not args.force:
            _fail(f"file exists: {out} (use --force to overwrite)")
            return 1
        agent_md = _render_agent_md(template_dir / "AGENT.md", args.name, description)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(agent_md, encoding="utf-8")
        _ok(path=str(out), files=[str(out.name)], mode="single-file")
        return 0

    # directory form
    if out.exists() and not args.force:
        _fail(f"directory exists: {out} (use --force to overwrite)")
        return 1
    out.mkdir(parents=True, exist_ok=True)

    created: list[str] = []
    # AGENT.md — substitute {name} + {description}
    agent_md = _render_agent_md(template_dir / "AGENT.md", args.name, description)
    (out / "AGENT.md").write_text(agent_md, encoding="utf-8")
    created.append("AGENT.md")

    # tools.yaml
    tools_src = template_dir / "tools.yaml"
    if tools_src.is_file():
        (out / "tools.yaml").write_text(tools_src.read_text(encoding="utf-8"), encoding="utf-8")
        created.append("tools.yaml")

    # subdirectories: knowledge, examples, behaviors — copy every file verbatim
    for sub in ("knowledge", "examples", "behaviors"):
        src_dir = template_dir / sub
        if not src_dir.is_dir():
            continue
        dst_dir = out / sub
        dst_dir.mkdir(exist_ok=True)
        for f in sorted(src_dir.rglob("*")):
            if f.is_file():
                rel = f.relative_to(src_dir)
                dst = dst_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
                created.append(f"{sub}/{rel.as_posix()}")

    _ok(path=str(out), files=created, mode="directory", template=args.template)
    return 0


def _render_agent_md(src: pathlib.Path, name: str, description: str) -> str:
    text = src.read_text(encoding="utf-8") if src.is_file() else _DEFAULT_AGENT_MD
    text = text.replace("{NAME}", name).replace("{DESCRIPTION}", description)
    return text


def _valid_name(s: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9\-]*", s))


def _default_description(template: str) -> str:
    return {
        "lead": "Team lead. Plans, delegates, and reviews team output.",
        "researcher": "Research specialist. Gathers information and synthesizes findings.",
        "reviewer": "Reviewer. Inspects outputs for quality, correctness, and compliance.",
        "writer": "Writer. Produces structured documents (memos, reports, summaries).",
    }.get(template, "Agent persona.")


_DEFAULT_AGENT_MD = """---
name: {NAME}
description: {DESCRIPTION}
---

# Persona

(Describe this agent in one paragraph: personality, responsibilities, tone.)

# Decision tree

- If the request is X → do A.
- If the request is Y → do B.
- Otherwise → respond with your best judgement.

# Knowledge index

(List any files in knowledge/ that this agent should consult, with one-line summaries.)

# Escalation

(When this agent should delegate up or ask the user.)
"""


def _ok(**kwargs: object) -> None:
    print(json.dumps({"ok": True, **kwargs}, ensure_ascii=False))


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))


if __name__ == "__main__":
    raise SystemExit(main())
