"""DuckDuckGo HTML search — parse the static SERP into structured results.

Uses the `html.duckduckgo.com/html/` endpoint which returns server-rendered
HTML with no JavaScript required. Robust to minor markup drift because we
walk the tag structure looking for the three class prefixes DDG has used
consistently for years (`result__a`, `result__url`, `result__snippet`).

Deliberately dependency-minimal: only `httpx` (already a transitive dep
via web-fetch) and stdlib `html.parser`. No selectolax / BeautifulSoup /
lxml requirement.
"""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

SERP_URL = "https://html.duckduckgo.com/html/"
# Browser-ish UA. DDG HTML endpoint 403s blatant bots; matching a real
# Chrome UA keeps us inside the envelope they serve to non-JS users.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0 Safari/537.36 OpenHive/0.1"
)
DEFAULT_TIMEOUT = 10.0
MAX_COUNT = 20


class _ResultParser(HTMLParser):
    """Walks DDG's SERP tree. Emits list of {title, href, snippet, display_url}
    tuples in document order. State machine stays tiny by latching onto the
    three class prefixes DDG uses for each organic result."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        # Pointers for the CURRENT in-progress result (reset when a new
        # result__a is seen). We emit only when we have both a title+href.
        self._title_buf: list[str] = []
        self._snippet_buf: list[str] = []
        self._display_buf: list[str] = []
        self._href: str = ""
        self._in_title: bool = False
        self._in_snippet: bool = False
        self._in_display: bool = False

    def _flush(self) -> None:
        title = "".join(self._title_buf).strip()
        if title and self._href:
            self.results.append(
                {
                    "title": title,
                    "href": self._href,
                    "snippet": "".join(self._snippet_buf).strip(),
                    "display_url": "".join(self._display_buf).strip(),
                }
            )
        self._title_buf.clear()
        self._snippet_buf.clear()
        self._display_buf.clear()
        self._href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        attrd = {k: v or "" for k, v in attrs}
        cls = attrd.get("class", "")
        # New result: seeing `result__a` means previous result (if any) is done.
        if tag == "a" and "result__a" in cls:
            self._flush()
            self._href = attrd.get("href", "")
            self._in_title = True
        elif tag == "a" and "result__snippet" in cls:
            self._in_snippet = True
        elif tag in ("span", "a") and "result__url" in cls:
            self._in_display = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            self._in_title = False
        elif tag == "a" and self._in_snippet:
            self._in_snippet = False
        elif tag in ("span", "a") and self._in_display:
            self._in_display = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_buf.append(data)
        elif self._in_snippet:
            self._snippet_buf.append(data)
        elif self._in_display:
            self._display_buf.append(data)

    def close(self) -> None:  # type: ignore[override]
        super().close()
        self._flush()


def _unwrap_ddg_redirect(raw_href: str) -> str:
    """DDG wraps result URLs as `//duckduckgo.com/l/?uddg=<encoded>&rut=…`.
    Unwrap to the real target URL. Absolute http(s) URLs pass through."""
    if not raw_href:
        return raw_href
    # Some results already give an absolute URL.
    if raw_href.startswith(("http://", "https://")):
        return raw_href
    # Protocol-relative DDG redirect.
    if raw_href.startswith("//"):
        raw_href = "https:" + raw_href
    try:
        parsed = urlparse(raw_href)
    except ValueError:
        return raw_href
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path in ("/l/", "/l"):
        qs = parse_qs(parsed.query)
        uddg = qs.get("uddg", [""])[0]
        if uddg:
            return unquote(uddg)
    return raw_href


_DOMAIN_STRIP = re.compile(r"^(?:https?://)?(?:www\.)?", re.IGNORECASE)


def _domain_of(url: str, fallback_display: str = "") -> str:
    try:
        host = urlparse(url).netloc
        if host:
            return host.lstrip("www.").lower() if host.startswith("www.") else host.lower()
    except ValueError:
        pass
    # Fallback: the display-url string DDG renders under each result, minus
    # http prefixes.
    clean = _DOMAIN_STRIP.sub("", fallback_display.strip()).split("/", 1)[0]
    return clean.lower()


class SearchError(Exception):
    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def search(
    query: str,
    count: int = 10,
    region: str = "wt-wt",
    timeout: float = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Return up to `count` results for `query`. Raises SearchError on
    transport / parse failure — caller translates to {ok:false, error, status}."""
    query = (query or "").strip()
    if not query:
        raise SearchError("query is empty")
    count = max(1, min(int(count), MAX_COUNT))

    params = {"q": query, "kl": region or "wt-wt"}
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    }
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(SERP_URL, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise SearchError(f"network error: {exc}") from exc
    if resp.status_code != 200:
        raise SearchError(
            f"duckduckgo returned HTTP {resp.status_code}",
            status=resp.status_code,
        )

    parser = _ResultParser()
    parser.feed(resp.text)
    parser.close()

    out: list[dict] = []
    for rank, r in enumerate(parser.results[:count], start=1):
        url = _unwrap_ddg_redirect(r["href"])
        # DDG sometimes injects internal ad links / empty hrefs — skip.
        if not url.startswith(("http://", "https://")):
            continue
        out.append(
            {
                "rank": rank,
                "title": html.unescape(r["title"]).strip(),
                "url": url,
                "domain": _domain_of(url, r.get("display_url", "")),
                "snippet": html.unescape(r["snippet"]).strip(),
            }
        )
    # Re-rank after any skipped items so ranks are contiguous.
    for i, item in enumerate(out, start=1):
        item["rank"] = i
    return out
