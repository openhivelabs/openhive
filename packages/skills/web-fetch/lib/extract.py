"""Main-content extraction via trafilatura. Returns (title, content_text)
where content_text is either markdown or plain text depending on the format.

We import trafilatura lazily so importing this module is cheap — and so the
SKILL.md body can describe trafilatura as a dep without hard-loading it in
environments that installed web-fetch but not yet run it.
"""

from __future__ import annotations


def extract(html: str, *, fmt: str = "markdown") -> tuple[str | None, str]:
    """Return (title, body). body is markdown if fmt=='markdown', else plain text."""
    import trafilatura
    from trafilatura.settings import use_config

    # trafilatura's default config bundles a 30s hard-kill timer — we already
    # time-bound the subprocess, so disable to avoid competing signals inside
    # the skill.
    cfg = use_config()
    cfg.set("DEFAULT", "EXTRACTION_TIMEOUT", "0")

    output_fmt = "markdown" if fmt == "markdown" else "txt"
    extracted = trafilatura.extract(
        html,
        output_format=output_fmt,
        include_comments=False,
        include_tables=True,
        include_links=(fmt == "markdown"),
        favor_recall=False,  # precision over recall — fewer false-positive chunks
        config=cfg,
    )

    # trafilatura.metadata gives us the title without re-parsing.
    title = None
    try:
        md = trafilatura.extract_metadata(html)
        if md is not None:
            title = md.title or None
    except Exception:
        title = None

    return title, (extracted or "")


def chunk(text: str, *, target_chars: int = 800) -> list[str]:
    """Split on blank-line boundaries, then pack paragraphs into chunks of
    roughly target_chars. Chunking on paragraphs (not fixed windows) keeps
    BM25 scoring intuitive and avoids cutting sentences.
    """
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    out: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for p in paras:
        if buf_len + len(p) > target_chars and buf:
            out.append("\n\n".join(buf))
            buf = [p]
            buf_len = len(p)
        else:
            buf.append(p)
            buf_len += len(p) + 2
    if buf:
        out.append("\n\n".join(buf))
    return out
