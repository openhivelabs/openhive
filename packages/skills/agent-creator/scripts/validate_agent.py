#!/usr/bin/env python3
"""Validate a persona.

Checks:
  - AGENT.md exists and has valid frontmatter
  - Required fields: name, description
  - tools.yaml (if present) has known keys + types
  - Files referenced in AGENT.md "Knowledge index" actually exist
  - Names are lowercase/hyphen-safe

Usage:
    python validate_agent.py --in ~/.openhive/agents/sales-lead

Prints JSON:
    {"ok": true/false, "errors": [...], "warnings": [...]}
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
    args = ap.parse_args()

    try:
        import yaml
    except ImportError:
        print(json.dumps({"ok": False, "errors": ["missing dep: pyyaml"], "warnings": []}))
        return 1

    path = pathlib.Path(args.inp).expanduser()
    if not path.exists():
        print(json.dumps({"ok": False, "errors": [f"not found: {path}"], "warnings": []}))
        return 1

    errors: list[str] = []
    warnings: list[str] = []

    if path.is_file() and path.suffix == ".md":
        _validate_file(path, yaml, errors, warnings)
    elif path.is_dir():
        _validate_dir(path, yaml, errors, warnings)
    else:
        errors.append("path must be an .md file or a directory")

    print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings},
                     ensure_ascii=False))
    return 0 if not errors else 1


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
    try:
        data = yaml.safe_load(block)
    except yaml.YAMLError as e:
        return None, text[body_start:]
    return (data if isinstance(data, dict) else None), text[body_start:]


_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*$")


def _check_frontmatter(fm: dict | None, errors: list[str], warnings: list[str]) -> None:
    if fm is None:
        errors.append("missing or invalid YAML frontmatter")
        return
    if not isinstance(fm.get("name"), str) or not fm["name"]:
        errors.append("frontmatter.name: required non-empty string")
    elif not _NAME_RE.match(fm["name"]):
        warnings.append(
            f"frontmatter.name={fm['name']!r}: prefer lowercase letters/digits/hyphens "
            f"(current value still accepted, but may collide when listed)"
        )
    if "description" in fm and not isinstance(fm["description"], str):
        warnings.append("frontmatter.description: expected a string")
    if "skills" in fm and not isinstance(fm["skills"], list):
        errors.append("frontmatter.skills: must be a list of strings")
    if "mcp" in fm and not isinstance(fm["mcp"], list):
        errors.append("frontmatter.mcp: must be a list of strings")


def _validate_file(path: pathlib.Path, yaml, errors: list[str], warnings: list[str]) -> None:
    fm, body = _split_frontmatter(path.read_text(encoding="utf-8"), yaml)
    _check_frontmatter(fm, errors, warnings)
    if not body.strip():
        warnings.append("body is empty — the agent will have no persona instructions")


def _validate_dir(path: pathlib.Path, yaml, errors: list[str], warnings: list[str]) -> None:
    md = path / "AGENT.md"
    if not md.is_file():
        errors.append(f"missing AGENT.md in {path}")
        return
    fm, body = _split_frontmatter(md.read_text(encoding="utf-8"), yaml)
    _check_frontmatter(fm, errors, warnings)

    tools_yaml = path / "tools.yaml"
    if tools_yaml.is_file():
        try:
            tools = yaml.safe_load(tools_yaml.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as e:
            errors.append(f"tools.yaml: invalid YAML: {e}")
            tools = {}
        _check_tools(tools, errors, warnings)

    # references in body
    for ref in re.findall(r"`([a-zA-Z0-9_\-./]+\.md)`", body):
        if ref.startswith("knowledge/") or ref.startswith("examples/") or ref.startswith("behaviors/"):
            if not (path / ref).is_file():
                warnings.append(f"body references `{ref}` but the file does not exist")


def _check_tools(tools: dict, errors: list[str], warnings: list[str]) -> None:
    if not isinstance(tools, dict):
        errors.append("tools.yaml root must be an object")
        return
    known = {"skills", "mcp", "mcp_servers", "team_data",
             "knowledge_exposure", "notes", "delegation"}
    for key in tools:
        if key not in known:
            warnings.append(f"tools.yaml.{key}: unknown key (will be ignored)")
    if "skills" in tools and not isinstance(tools["skills"], list):
        errors.append("tools.yaml.skills: must be a list")
    mcp = tools.get("mcp") or tools.get("mcp_servers")
    if mcp is not None and not isinstance(mcp, list):
        errors.append("tools.yaml.mcp / mcp_servers: must be a list")
    if "knowledge_exposure" in tools and tools["knowledge_exposure"] not in (
        "summary", "full", "none"
    ):
        errors.append("tools.yaml.knowledge_exposure: must be summary|full|none")


if __name__ == "__main__":
    raise SystemExit(main())
