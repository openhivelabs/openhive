"""Chart rendering for the DOCX skill.

Charts are rendered with matplotlib (Agg backend) to a PNG, then embedded
as a regular image. This sidesteps the OOXML chart-part XSD entirely and
gives full control over palette/typography/layout — at the cost of charts
being images (not editable in Word's chart editor).

Variants:
    bar           grouped vertical bars
    hbar          horizontal bars
    stacked_bar   stacked vertical bars
    line          line chart, one line per series
    area          filled area, one per series (auto-stacked when len>1)
    scatter       scatter plot per series
    donut         donut (pie with hole)
    pie           classic pie
    sparkline     compact one-line trend, no axes

Block schema:

    {"type": "chart", "variant": "bar",
     "title": "...",          // optional, drawn inside the figure
     "x": ["Q1", "Q2", ...], // categories (for bar/line/area/scatter)
     "series": [
       {"name": "Revenue", "values": [120, 140, 180]},
       {"name": "Cost",    "values": [80, 90, 110]}
     ],
     "y_label": "...",
     "x_label": "...",
     "show_legend": true,
     "show_values": false,    // bar/hbar: annotate value on each bar
     "width_in": 6.0,
     "height_in": 3.2,
     "caption": "..."}

For donut/pie:
    {"type": "chart", "variant": "donut",
     "slices": [{"label": "A", "value": 42}, ...]}

For sparkline:
    {"type": "chart", "variant": "sparkline",
     "values": [3, 4, 6, 5, 8, 12, 11, 14],
     "width_in": 2.5, "height_in": 0.6}
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
from typing import Any

from .themes import Theme, palette_color


def render_chart_png(block: dict, theme: Theme) -> tuple[str, float, float]:
    """Render the chart to a temp PNG. Returns (path, width_in, height_in)."""
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    # Register the Noto Sans font for whatever script the chart text contains.
    # Without this, matplotlib falls back to DejaVu Sans which has no CJK
    # glyphs → boxes for Korean/Japanese/Chinese.
    chart_text = _gather_text(block)
    cjk_font = _ensure_font_for(chart_text)

    variant = block.get("variant", "bar")
    width_in = float(block.get("width_in") or 6.0)
    height_in = float(block.get("height_in") or _default_height(variant))

    # Map theme fonts to matplotlib. Fall back to DejaVu Sans (matplotlib default
    # bundled font) if the named font isn't installed — matplotlib silently
    # picks a fallback for missing chars anyway, so explicit fallback keeps
    # CJK glyphs from rendering as boxes.
    family_chain = []
    if cjk_font:
        family_chain.append(cjk_font)
    family_chain += [theme.body_font, "Apple SD Gothic Neo", "DejaVu Sans", "Arial"]
    plt.rcParams.update({
        "font.family": family_chain,
        "font.size": theme.size_small,
        "axes.titlesize": theme.size_body,
        "axes.labelsize": theme.size_small,
        "axes.edgecolor": _hex(theme.muted),
        "axes.linewidth": 0.6,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "xtick.color": _hex(theme.muted),
        "ytick.color": _hex(theme.muted),
        "xtick.labelsize": theme.size_small,
        "ytick.labelsize": theme.size_small,
        "axes.grid": True,
        "grid.color": _hex(theme.muted) + "33",
        "grid.linewidth": 0.5,
        "legend.fontsize": theme.size_small,
        "legend.frameon": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
    })

    fig, ax = plt.subplots(figsize=(width_in, height_in), dpi=200)

    if variant == "bar":
        _draw_bar(ax, block, theme, horizontal=False)
    elif variant == "hbar":
        _draw_bar(ax, block, theme, horizontal=True)
    elif variant == "stacked_bar":
        _draw_stacked_bar(ax, block, theme)
    elif variant == "line":
        _draw_line(ax, block, theme, fill=False)
    elif variant == "area":
        _draw_line(ax, block, theme, fill=True)
    elif variant == "scatter":
        _draw_scatter(ax, block, theme)
    elif variant in ("donut", "pie"):
        _draw_pie(ax, block, theme, donut=(variant == "donut"))
    elif variant == "sparkline":
        _draw_sparkline(ax, block, theme)
    else:
        raise ValueError(f"unknown chart variant: {variant}")

    title = block.get("title")
    if title and variant != "sparkline":
        ax.set_title(title, color=_hex(theme.heading),
                     fontsize=theme.size_body, fontweight="bold",
                     loc="left", pad=10)

    if variant not in ("donut", "pie", "sparkline"):
        if block.get("y_label"):
            ax.set_ylabel(block["y_label"], color=_hex(theme.muted))
        if block.get("x_label"):
            ax.set_xlabel(block["x_label"], color=_hex(theme.muted))

    fig.tight_layout()

    h = hashlib.sha1(json.dumps(block, sort_keys=True, default=str)
                     .encode("utf-8")).hexdigest()[:16]
    out = pathlib.Path(tempfile.gettempdir()) / f"docx_chart_{h}.png"
    fig.savefig(str(out), dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return str(out), width_in, height_in


# ---------------------------------------------------------------------------
# variant drawers
# ---------------------------------------------------------------------------


def _draw_bar(ax, block, theme, horizontal: bool) -> None:
    cats = block.get("x") or []
    series = block.get("series") or []
    if not cats:
        cats = [f"#{i+1}" for i in range(len(series[0].get("values", [])))]
    n_groups = len(cats)
    n_series = len(series)
    import numpy as np
    idx = np.arange(n_groups)
    bar_w = 0.8 / max(n_series, 1)
    show_vals = bool(block.get("show_values"))
    for si, s in enumerate(series):
        vals = list(s.get("values", []))
        # pad to len(cats)
        if len(vals) < n_groups:
            vals = vals + [0] * (n_groups - len(vals))
        offsets = idx + (si - (n_series - 1) / 2) * bar_w
        color = _hex(palette_color(theme, si))
        if horizontal:
            bars = ax.barh(offsets, vals, height=bar_w, color=color,
                           label=s.get("name", f"Series {si+1}"))
        else:
            bars = ax.bar(offsets, vals, width=bar_w, color=color,
                          label=s.get("name", f"Series {si+1}"))
        if show_vals:
            for rect, v in zip(bars, vals):
                if horizontal:
                    ax.text(rect.get_width(), rect.get_y() + rect.get_height() / 2,
                            f" {_fmt(v)}", va="center", ha="left",
                            fontsize=theme.size_small, color=_hex(theme.fg))
                else:
                    ax.text(rect.get_x() + rect.get_width() / 2, rect.get_height(),
                            f"{_fmt(v)}", va="bottom", ha="center",
                            fontsize=theme.size_small, color=_hex(theme.fg))
    if horizontal:
        ax.set_yticks(idx); ax.set_yticklabels(cats)
        ax.invert_yaxis()
        ax.grid(axis="y", visible=False)
    else:
        ax.set_xticks(idx); ax.set_xticklabels(cats)
        ax.grid(axis="x", visible=False)
    if n_series > 1 and block.get("show_legend", True):
        ax.legend(loc="best")


def _draw_stacked_bar(ax, block, theme) -> None:
    import numpy as np
    cats = block.get("x") or []
    series = block.get("series") or []
    if not cats:
        cats = [f"#{i+1}" for i in range(len(series[0].get("values", [])))]
    idx = np.arange(len(cats))
    bottom = np.zeros(len(cats))
    for si, s in enumerate(series):
        vals = np.array(list(s.get("values", [])) + [0] * (len(cats) - len(s.get("values", []))))
        ax.bar(idx, vals, bottom=bottom, color=_hex(palette_color(theme, si)),
               label=s.get("name", f"Series {si+1}"), width=0.65)
        bottom = bottom + vals
    ax.set_xticks(idx); ax.set_xticklabels(cats)
    ax.grid(axis="x", visible=False)
    if len(series) > 1 and block.get("show_legend", True):
        ax.legend(loc="best")


def _draw_line(ax, block, theme, fill: bool) -> None:
    cats = block.get("x") or []
    series = block.get("series") or []
    if not cats and series:
        cats = [str(i + 1) for i in range(len(series[0].get("values", [])))]
    for si, s in enumerate(series):
        vals = list(s.get("values", []))
        color = _hex(palette_color(theme, si))
        ax.plot(cats[: len(vals)], vals, marker="o", color=color,
                linewidth=2.0, markersize=4,
                label=s.get("name", f"Series {si+1}"))
        if fill:
            ax.fill_between(cats[: len(vals)], vals, color=color, alpha=0.18)
    if len(series) > 1 and block.get("show_legend", True):
        ax.legend(loc="best")


def _draw_scatter(ax, block, theme) -> None:
    series = block.get("series") or []
    cats = block.get("x") or []
    for si, s in enumerate(series):
        ys = list(s.get("values", []))
        xs = list(s.get("x") or cats[: len(ys)] or list(range(len(ys))))
        color = _hex(palette_color(theme, si))
        ax.scatter(xs, ys, color=color, s=36, alpha=0.85,
                   label=s.get("name", f"Series {si+1}"))
    if len(series) > 1 and block.get("show_legend", True):
        ax.legend(loc="best")


def _draw_pie(ax, block, theme, donut: bool) -> None:
    slices = block.get("slices") or []
    labels = [s.get("label", "") for s in slices]
    values = [float(s.get("value", 0)) for s in slices]
    colors = [_hex(palette_color(theme, i)) for i in range(len(slices))]
    wedge_kw = {"width": 0.42, "edgecolor": "white"} if donut else {"edgecolor": "white"}
    wedges, texts, autotexts = ax.pie(
        values, labels=labels, colors=colors, autopct="%1.0f%%",
        startangle=90, wedgeprops=wedge_kw, pctdistance=0.78 if donut else 0.6,
        textprops={"color": _hex(theme.fg), "fontsize": theme.size_small},
    )
    for at in autotexts:
        at.set_color("white" if not donut else _hex(theme.fg))
        at.set_fontweight("bold")
    ax.set_aspect("equal")
    ax.grid(False)


def _draw_sparkline(ax, block, theme) -> None:
    values = list(block.get("values") or [])
    color = _hex(block.get("color") and tuple(block["color"]) or palette_color(theme, 0))
    ax.plot(values, color=color, linewidth=1.6)
    ax.fill_between(range(len(values)), values, color=color, alpha=0.15)
    last_x = len(values) - 1
    if last_x >= 0:
        ax.scatter([last_x], [values[-1]], color=color, s=18, zorder=5)
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)
    ax.grid(False)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        if v.is_integer():
            return f"{int(v):,}"
        return f"{v:,.1f}"
    if isinstance(v, int):
        return f"{v:,}"
    return str(v)


def _default_height(variant: str) -> float:
    return {
        "sparkline": 0.6,
        "donut": 3.2, "pie": 3.2,
        "scatter": 3.0,
    }.get(variant, 3.2)


def _gather_text(block: dict) -> str:
    buf: list[str] = []

    def _walk(v) -> None:
        if isinstance(v, str):
            buf.append(v)
        elif isinstance(v, dict):
            for x in v.values():
                _walk(x)
        elif isinstance(v, list):
            for x in v:
                _walk(x)

    _walk(block)
    return " ".join(buf)


def _ensure_font_for(text: str) -> str | None:
    """Register the Noto font file for the dominant script and return its
    family name so matplotlib renders CJK/etc characters instead of boxes.

    Returns None on failure; caller falls back to Latin chain.
    """
    try:
        import sys
        import pathlib
        # _lib lives at packages/skills/_lib — two parents up from this file.
        here = pathlib.Path(__file__).resolve()
        skills_root = here.parent.parent.parent  # packages/skills
        if str(skills_root) not in sys.path:
            sys.path.insert(0, str(skills_root))
        from _lib import fonts as _fonts

        script = _fonts.dominant_script(text)
        if script == _fonts.SCRIPT_LATIN:
            return None
        path = _fonts.ensure_font_file(script)
        if not path:
            return None
        from matplotlib import font_manager as fm

        fm.fontManager.addfont(str(path))
        # The family name baked into the TTF — e.g. "Noto Sans KR".
        family = fm.FontProperties(fname=str(path)).get_name()
        return family
    except Exception:
        return None

