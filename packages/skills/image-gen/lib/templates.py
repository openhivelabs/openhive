from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator


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
        errors = sorted(validator.iter_errors(vars), key=lambda e: list(e.absolute_path))
        if errors:
            first = errors[0]
            path = "/".join(str(p) for p in first.absolute_path) or "<root>"
            raise ValidationError(f"{path}: {first.message}")
        filled = dict(vars)
        for key, prop in self.schema.get("properties", {}).items():
            if key not in filled and isinstance(prop, dict) and "default" in prop:
                filled[key] = prop["default"]
        return filled


def list_templates(templates_dir: Path) -> list[str]:
    if not templates_dir.exists():
        return []
    return sorted(
        p.name
        for p in templates_dir.iterdir()
        if p.is_dir() and (p / "template.yaml").exists()
    )


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
