#!/usr/bin/env python3
"""Summarise a persona — directory or single-file.

Usage:
    python inspect_agent.py --in ~/.openhive/agents/sales-lead
    python inspect_agent.py --in ~/.openhive/agents/greeter.md

Output JSON:
    {
      "ok": true,
      "name": "...",
      "description": "...",
      "kind": "dir" | "file",
      "source_path": "...",
      "body_len": N,
      "frontmatter": {...},
      "files": [{"path": "knowledge/pricing.md", "size": 1234}, ...],
      "tools": {"skills": [...], "mcp": [...], ...}
    }
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    args = ap.parse_args()

    path = pathlib.Path(args.inp).expanduser()
    if not path.exists():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    try:
        import yaml
    except ImportError:
        print(json.dumps({"ok": False, "error": "missing dep: pyyaml"}))
        return 1

    if path.is_file() and path.suffix == ".md":
        data = _inspect_file(path, yaml)
    elif path.is_dir():
        data = _inspect_dir(path, yaml)
    else:
        print(json.dumps({"ok": False, "error": "path must be an .md file or a directory"}))
        return 1

    print(json.dumps(data, ensure_ascii=False))
    return 0


def _split_frontmatter(text: str, yaml) -> tuple[dict | None, str]:
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end < 0:
        return None, text
    block = text[3:end].lstrip("\n")
    body_start = end + len("\n---")
    if body_start < len(text) and text[body_start] == "\n":
        body_start += 1
    body = text[body_start:]
    try:
        data = yaml.safe_load(block)
    except yaml.YAMLError:
        return None, body
    return (data if isinstance(data, dict) else None), body


def _inspect_file(path: pathlib.Path, yaml) -> dict:
    text = path.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text, yaml)
    fm = fm or {}
    return {
        "ok": True,
        "name": fm.get("name") or path.stem,
        "description": fm.get("description", ""),
        "kind": "file",
        "source_path": str(path),
        "body_len": len(body.strip()),
        "frontmatter": fm,
        "files": [],
        "tools": {
            "skills": fm.get("skills") or [],
            "mcp": fm.get("mcp") or [],
        },
    }


def _inspect_dir(path: pathlib.Path, yaml) -> dict:
    md = path / "AGENT.md"
    if not md.is_file():
        return {"ok": False, "error": f"no AGENT.md in {path}"}
    fm, body = _split_frontmatter(md.read_text(encoding="utf-8"), yaml)
    fm = fm or {}

    tools_yaml = path / "tools.yaml"
    tools: dict = {}
    if tools_yaml.is_file():
        try:
            tools = yaml.safe_load(tools_yaml.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            tools = {}

    # walk files
    files = []
    skip = {"__pycache__", ".git", "node_modules"}
    for p in sorted(path.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(path)
        if any(part.startswith(".") or part in skip for part in rel.parts):
            continue
        if rel.name in {"AGENT.md", "tools.yaml"}:
            continue
        files.append({"path": rel.as_posix(), "size": p.stat().st_size})

    return {
        "ok": True,
        "name": fm.get("name") or path.name,
        "description": fm.get("description", ""),
        "kind": "dir",
        "source_path": str(path),
        "body_len": len(body.strip()),
        "frontmatter": fm,
        "files": files,
        "tools": {
            "skills": tools.get("skills") or fm.get("skills") or [],
            "mcp": tools.get("mcp") or tools.get("mcp_servers") or fm.get("mcp") or [],
            "team_data": tools.get("team_data") or {},
            "knowledge_exposure": tools.get("knowledge_exposure", "full"),
        },
    }


if __name__ == "__main__":
    raise SystemExit(main())
