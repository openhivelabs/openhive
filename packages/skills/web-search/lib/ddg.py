"""DuckDuckGo lite search — parse the lite SERP into structured results.

Switched from `html.duckduckgo.com/html/` (GET) to `lite.duckduckgo.com/lite/`
(POST + warm session cookies) because the `/html/` endpoint started
returning HTTP 202 anti-scraping interstitials on rapid repeat queries.
The lite endpoint targets text-only browsers; it serves the same SERP
through a flatter `<table>` structure (`result-link`, `result-snippet`,
`link-text` classes) and 202's far less often when the request looks
like a real session — cookie jar warmed by a homepage GET, correct
Referer, POST body.

Robust retry layered on top: on 202 / transport errors, back off
1.0–2.0s with jitter and try up to 3 times. A single LLM `web-search`
call therefore makes at most 1+2 retries=3 SERP fetches under the hood,
hidden from the per-turn cap.

Deliberately dependency-minimal: only `httpx` (already a transitive dep
via web-fetch) and stdlib `html.parser` / `random` / `time`.
"""

from __future__ import annotations

import fcntl
import html
import os
import random
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

LITE_URL = "https://lite.duckduckgo.com/lite/"
HTML_URL = "https://html.duckduckgo.com/html/"
HOMEPAGE_URL = "https://duckduckgo.com/"
# Browser-ish UA pool. DDG endpoints 403 blatant bots; matching real
# desktop UAs keeps us inside the envelope they serve to non-JS users.
# Rotated across retries so a flagged fingerprint doesn't lock the whole
# call out — different UA + fresh cookie jar = different fingerprint.
USER_AGENTS = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
)
DEFAULT_TIMEOUT = 10.0
MAX_COUNT = 20
# Per-endpoint attempts. We try lite first (more permissive), and on
# repeated 202 fall back to /html/ once. Worst case: 3 lite attempts +
# 1 html attempt = 4 SERP fetches, with exponential-jittered sleeps
# between them (~1.5s + ~3s + ~5s) — bounded by the skill subprocess
# timeout.
MAX_ATTEMPTS = 3

# Total wall-clock budget for a single `search()` call. DDG can stall in three
# places (rate-limit lock wait, retry backoff sleep, httpx network read) and
# without an outer cap a single web-search subprocess can hang for 60+s while
# the engine sits waiting on the tool_result. The classifier upstream then
# tags the session `provider_silent_exit` and the chat is stuck. Default 20s
# is comfortably above the steady-state path (warm cookies + POST < 3s) but
# well under the engine's tool-call timeout. Env-overridable for power users.
_BUDGET_MS = int(os.environ.get("OPENHIVE_WEB_SEARCH_BUDGET_MS", "20000"))


def _remaining_ms(deadline_monotonic: float) -> float:
    return max(0.0, (deadline_monotonic - time.monotonic()) * 1000.0)


def _budget_check(deadline_monotonic: float) -> None:
    if time.monotonic() >= deadline_monotonic:
        raise SearchError(
            "DuckDuckGo did not respond within 20s budget",
            status=None,
            reason="budget_exceeded",
        )


class _LiteResultParser(HTMLParser):
    """Walks DDG's lite SERP. Each result spans a few `<tr>` rows: the
    link sits inside an `<a class="result-link">`, the snippet inside a
    `<td class="result-snippet">`, the display URL inside a
    `<span class="link-text">`. We collect all three and emit when we
    see the next `result-link` or hit close()."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
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
        if tag == "a" and "result-link" in cls:
            self._flush()
            self._href = attrd.get("href", "")
            self._in_title = True
        elif tag == "td" and "result-snippet" in cls:
            self._in_snippet = True
        elif tag == "span" and "link-text" in cls:
            self._in_display = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            self._in_title = False
        elif tag == "td" and self._in_snippet:
            self._in_snippet = False
        elif tag == "span" and self._in_display:
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


class _HtmlResultParser(HTMLParser):
    """Parser for the legacy `/html/` endpoint. Same shape as the lite
    parser but matches the `result__a` / `result__url` / `result__snippet`
    classes DDG has used on the html SERP for years. Kept around as a
    fallback for the rare cases where lite 202s repeatedly but html
    happens to let us through (different IP/fingerprint envelope)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
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
    if raw_href.startswith(("http://", "https://")):
        return raw_href
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
            return host[4:].lower() if host.startswith("www.") else host.lower()
    except ValueError:
        pass
    clean = _DOMAIN_STRIP.sub("", fallback_display.strip()).split("/", 1)[0]
    return clean.lower()


class SearchError(Exception):
    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.reason = reason


# Global cross-process rate limiter — every `web-search` skill subprocess
# coordinates on a single timestamp file so that multiple sub-agents
# firing in the same turn don't burst DDG and trip its anti-scraping
# heuristic (HTTP 202). The LLM still sees N independent calls; we just
# space the actual HTTP requests by ~MIN_INTERVAL_S + jitter.
_RATE_DIR = Path.home() / ".openhive" / "skills" / "web-search"
_RATE_FILE = _RATE_DIR / "last_call.txt"
# Targets a steady-state of ~2.5–4.0s between requests from this machine.
# Tunable via env for power users on different ISPs / network conditions.
_MIN_INTERVAL_S = float(os.environ.get("OPENHIVE_WEB_SEARCH_MIN_INTERVAL", "2.5"))
_JITTER_S = float(os.environ.get("OPENHIVE_WEB_SEARCH_JITTER", "1.5"))


def _enforce_rate_limit(deadline_monotonic: float) -> None:
    """Block until at least the configured interval has passed since the
    last web-search call on this machine. Implementation: an `fcntl`
    advisory lock around a tiny timestamp file — concurrent sub-agent
    calls serialize cleanly, each one waiting its turn rather than all
    bursting DDG together.

    Honors the search() wall-clock budget — caps any sleep at the
    remaining budget and raises SearchError(reason='budget_exceeded')
    if we'd otherwise sleep past the deadline. Without this guard a
    burst of N concurrent sub-agents could each queue behind the lock
    for _MIN_INTERVAL_S, blowing the budget without ever issuing an
    HTTP request."""
    if _MIN_INTERVAL_S <= 0:
        return
    _budget_check(deadline_monotonic)
    try:
        _RATE_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(_RATE_FILE), os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        # Filesystem hiccup — don't fail the search because of the rate
        # limiter. Best-effort throttle only.
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _budget_check(deadline_monotonic)
        target = _MIN_INTERVAL_S + random.random() * _JITTER_S
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 64).decode("utf-8", "ignore").strip()
        try:
            last = float(raw) if raw else 0.0
        except ValueError:
            last = 0.0
        now = time.time()
        wait = target - (now - last)
        if wait > 0:
            remaining_s = _remaining_ms(deadline_monotonic) / 1000.0
            if wait >= remaining_s:
                # Sleeping the full throttle would blow the budget. Bail
                # now with a clear reason rather than silently stalling.
                raise SearchError(
                    "DuckDuckGo did not respond within 20s budget",
                    status=None,
                    reason="budget_exceeded",
                )
            time.sleep(wait)
            now = time.time()
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, f"{now:.6f}".encode("ascii"))
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _fetch_serp(
    endpoint: str,
    query: str,
    region: str,
    timeout: float,
    user_agent: str,
) -> str:
    """One SERP attempt against the given endpoint (lite or html). Warms
    cookies on the homepage with this UA, then POSTs the SERP with the
    cookie jar attached. Returns the HTML body on 200, raises SearchError
    on anything else."""
    base_headers = {
        "User-Agent": user_agent,
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    }
    origin = endpoint.rstrip("/").rsplit("/", 1)[0]
    referer = origin + "/"
    with httpx.Client(
        timeout=timeout, follow_redirects=True, headers=base_headers
    ) as client:
        # Warm cookies — tiny GET to the homepage. DDG sets `dcm` (default
        # consent marker) and `kl` (region) here; sending the subsequent
        # POST with these cookies makes us look like a session the user is
        # already inside, not a one-shot scraper. A failed warm-up isn't
        # fatal — fall through and let the POST attempt itself surface the
        # real error.
        try:
            client.get(HOMEPAGE_URL, headers={"Accept": "text/html"})
        except httpx.HTTPError:
            pass
        post_headers = {
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            ),
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": origin,
            "Referer": referer,
        }
        data = {"q": query, "kl": region or "wt-wt", "df": ""}
        try:
            resp = client.post(endpoint, data=data, headers=post_headers)
        except httpx.HTTPError as exc:
            raise SearchError(f"network error: {exc}") from exc
    if resp.status_code != 200:
        raise SearchError(
            f"duckduckgo returned HTTP {resp.status_code}",
            status=resp.status_code,
        )
    return resp.text


def _try_endpoint(
    endpoint: str,
    query: str,
    region: str,
    timeout: float,
    parser_cls: type[HTMLParser],
    deadline_monotonic: float,
) -> Optional[list[dict[str, str]]]:
    """Run the retry loop against one endpoint. Returns parsed raw results
    (pre-redirect-unwrap) on success, or None if every attempt failed with
    a retriable error (caller may then try the other endpoint). Raises
    SearchError immediately on non-retriable errors. Raises
    SearchError(reason='budget_exceeded') if the wall-clock budget is
    exhausted at any check-point (before fetch, before backoff sleep)."""
    last_exc: Optional[SearchError] = None
    for attempt in range(MAX_ATTEMPTS):
        _budget_check(deadline_monotonic)
        ua = USER_AGENTS[attempt % len(USER_AGENTS)]
        # Clamp httpx timeout to what's left of the budget so a stalled
        # connect/read can't outlast the outer deadline.
        remaining_s = _remaining_ms(deadline_monotonic) / 1000.0
        effective_timeout = min(timeout, max(0.5, remaining_s))
        try:
            body = _fetch_serp(endpoint, query, region, effective_timeout, ua)
        except SearchError as exc:
            last_exc = exc
            retriable = exc.status == 202 or exc.status is None
            if not retriable:
                raise
            if attempt == MAX_ATTEMPTS - 1:
                return None
            # Exponential backoff with jitter: ~1.5s, ~3s, ~5s. Long enough
            # for DDG's per-fingerprint 202 label to often clear; short
            # enough that 3 retries fit inside a sane skill timeout. Jitter
            # avoids a synchronized retry storm when multiple sub-agents
            # fail at the same time.
            base = 1.0 * (2 ** attempt)
            sleep_s = base + random.random()
            remaining_s = _remaining_ms(deadline_monotonic) / 1000.0
            if sleep_s >= remaining_s:
                # No point sleeping past the budget — bail with a clear
                # reason instead of stalling and timing out.
                raise SearchError(
                    "DuckDuckGo did not respond within 20s budget",
                    status=None,
                    reason="budget_exceeded",
                ) from exc
            time.sleep(sleep_s)
            continue
        parser = parser_cls()
        parser.feed(body)
        parser.close()
        return parser.results  # type: ignore[attr-defined]
    # Loop exited without success — should be unreachable but keep the type
    # checker happy.
    if last_exc:
        raise last_exc
    return None


def search(
    query: str,
    count: int = 10,
    region: str = "wt-wt",
    timeout: float = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Return up to `count` results for `query`. Tries the lite endpoint
    with retry first; on repeated 202 falls back to the legacy /html/
    endpoint once per UA in the rotation. Non-retriable errors (4xx/5xx
    other than 202) propagate immediately to avoid hammering DDG."""
    query = (query or "").strip()
    if not query:
        raise SearchError("query is empty")
    count = max(1, min(int(count), MAX_COUNT))

    # Single wall-clock budget for the entire call. Threaded through the
    # rate limiter, retry sleeps, and httpx timeout so no individual stall
    # can blow past the outer deadline.
    deadline_monotonic = time.monotonic() + (_BUDGET_MS / 1000.0)

    # Cross-process throttle so concurrent sub-agent calls don't burst DDG.
    # See `_enforce_rate_limit` for the lock-based mechanism.
    _enforce_rate_limit(deadline_monotonic)

    raw = _try_endpoint(
        LITE_URL, query, region, timeout, _LiteResultParser, deadline_monotonic
    )
    if raw is None:
        # Budget check before paying for an endpoint switch.
        _budget_check(deadline_monotonic)
        # Lite kept 202'ing — try /html/ once with a single attempt.
        raw = _try_endpoint(
            HTML_URL, query, region, timeout, _HtmlResultParser, deadline_monotonic
        )
    if raw is None:
        raise SearchError("duckduckgo returned HTTP 202", status=202)

    out: list[dict] = []
    for rank, r in enumerate(raw[:count], start=1):
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
