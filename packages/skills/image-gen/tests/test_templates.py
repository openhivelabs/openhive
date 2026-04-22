from pathlib import Path
import sys

import pytest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))

from lib.templates import (  # noqa: E402
    TemplateNotFound,
    ValidationError,
    list_templates,
    load_template,
)

TPL_DIR = SKILL / "templates"


def test_list_includes_all_five_starters():
    names = list_templates(TPL_DIR)
    for expected in ("yt-bold-text", "yt-split", "yt-quote", "cover-minimal", "stat-card"):
        assert expected in names, f"missing template {expected!r}; got {names}"


def test_load_yt_bold_text_size_and_schema():
    tpl = load_template(TPL_DIR, "yt-bold-text")
    assert tpl.size == (1280, 720)
    assert "title" in tpl.schema["properties"]
    assert "title" in tpl.schema["required"]


def test_load_missing_raises():
    with pytest.raises(TemplateNotFound):
        load_template(TPL_DIR, "nonexistent")


def test_validate_rejects_missing_required():
    tpl = load_template(TPL_DIR, "yt-bold-text")
    with pytest.raises(ValidationError):
        tpl.validate({})


def test_validate_rejects_bad_accent_pattern():
    tpl = load_template(TPL_DIR, "yt-bold-text")
    with pytest.raises(ValidationError):
        tpl.validate({"title": "hi", "accent": "not-a-color"})


def test_validate_fills_defaults():
    tpl = load_template(TPL_DIR, "yt-bold-text")
    filled = tpl.validate({"title": "Hello"})
    assert filled["accent"] == "#ff4d4d"
    assert filled["bg_style"] == "gradient"


def test_validate_accepts_full_payload():
    tpl = load_template(TPL_DIR, "yt-bold-text")
    filled = tpl.validate(
        {"title": "Hello", "subtitle": "World", "accent": "#ff0044", "bg_style": "solid"}
    )
    assert filled["title"] == "Hello"
    assert filled["bg_style"] == "solid"
