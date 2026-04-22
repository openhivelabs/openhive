"""Render HTML → PNG via headless Chromium (Playwright sync API)."""
from __future__ import annotations
import sys
from pathlib import Path

import jinja2
from playwright.sync_api import sync_playwright


def render_template(template_html_path: Path, vars: dict) -> str:
    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(template_html_path.parent)),
        autoescape=jinja2.select_autoescape(["html", "j2"]),
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
                print(f"image-gen: set_content warning: {exc}", file=sys.stderr)
            page.screenshot(
                path=str(out_path),
                omit_background=False,
                full_page=False,
            )
        finally:
            browser.close()
    return out_path.stat().st_size
