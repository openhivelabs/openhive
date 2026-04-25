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


MOJEEK_URL = "https://www.mojeek.com/search"

# Mojeek SERP markers — each result is wrapped in `<!--rs-->...<!--re-->`,
# the title link uses `<a class="title" href="...">`, and the snippet is in
# `<p class="s">`. Markup is stable enough that regex extraction is cleaner
# than a full HTMLParser state machine here.
_MOJEEK_BLOCK_RE = re.compile(r"<!--rs-->(.+?)<!--re-->", re.S)
_MOJEEK_TITLE_RE = re.compile(
    r'<a\s+class="title"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S
)
_MOJEEK_SNIPPET_RE = re.compile(r'<p\s+class="s"[^>]*>(.*?)</p>', re.S)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")


def _mojeek_search(
    query: str,
    region: str,
    timeout: float,
    deadline_monotonic: float,
) -> list[dict]:
    """Fetch + parse Mojeek SERP. Mojeek is an independent index (own
    crawl, no Google/Bing dependency) that — as of this rewrite — serves
    SERP HTML to plain HTTP clients without an anomaly/captcha gate.
    Used as the primary backend after DDG started gating every request
    behind `anomaly.js`. No API key, no auth, no per-IP rate cliff
    observed in testing.

    `region` is best-effort: Mojeek accepts an `arc` (region) param;
    we map a few common DDG-style codes through and otherwise omit it
    so Mojeek returns its global default."""
    _budget_check(deadline_monotonic)
    user_agent = random.choice(USER_AGENTS)
    headers = {
        "User-Agent": user_agent,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    remaining = max(0.5, _remaining_ms(deadline_monotonic) / 1000.0)
    effective_timeout = min(timeout, remaining)
    params: dict[str, str] = {"q": query, "fmt": "html"}
    arc = _mojeek_region(region)
    if arc:
        params["arc"] = arc
    try:
        with httpx.Client(
            timeout=effective_timeout,
            follow_redirects=True,
            headers=headers,
        ) as client:
            resp = client.get(MOJEEK_URL, params=params)
    except httpx.TimeoutException as exc:
        raise SearchError(
            f"mojeek timeout: {exc}", status=None, reason="transport"
        )
    except httpx.HTTPError as exc:
        raise SearchError(
            f"mojeek transport error: {exc}", status=None, reason="transport"
        )
    if resp.status_code != 200:
        raise SearchError(
            f"mojeek HTTP {resp.status_code}", status=resp.status_code
        )
    body = resp.text
    low = body.lower()
    if "captcha" in low or "are you human" in low or "verify you are" in low:
        raise SearchError("mojeek anomaly gate", status=429)

    raw: list[dict] = []
    for block in _MOJEEK_BLOCK_RE.findall(body):
        tm = _MOJEEK_TITLE_RE.search(block)
        if not tm:
            continue
        href = html.unescape(tm.group(1)).strip()
        title = html.unescape(_TAG_STRIP_RE.sub("", tm.group(2))).strip()
        sm = _MOJEEK_SNIPPET_RE.search(block)
        snippet = (
            html.unescape(_TAG_STRIP_RE.sub("", sm.group(1))).strip()
            if sm
            else ""
        )
        if not (title and href.startswith(("http://", "https://"))):
            continue
        raw.append(
            {"title": title, "href": href, "snippet": snippet, "display_url": ""}
        )
    return raw


YAHOO_URL = "https://search.yahoo.com/search"

# Yahoo SERP markers. Each result is `<a href="REDIRECT_URL"><...><h3 class="title..."><span>TITLE</span></h3>...</a>`,
# where REDIRECT_URL embeds the real target URL inside `/RU=<percent-encoded>/`.
# Snippet follows in a `<p class="fc-dustygray ...">` shortly after `</a>`.
# This is the third backend added after Mojeek (2026-04-26 IP block) and DDG
# (2026-04-26 anomaly.js gate). Yahoo (Bing-backed but with its own anti-bot
# layer) currently serves SERPs to plain UA without captcha — verified by
# direct probe against the same IPs that get 403/202 from Mojeek/DDG.
_YAHOO_RESULT_RE = re.compile(
    r'<a[^>]+href="(https?://r\.search\.yahoo\.com/[^"]+)"[^>]*>'
    r'.*?<h3[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>\s*<span[^>]*>(.+?)</span>\s*</h3>'
    r'.*?</a>',
    re.S,
)
_YAHOO_SNIPPET_RES = (
    re.compile(r'<p class="[^"]*fc-dustygray[^"]*"[^>]*>(.+?)</p>', re.S),
    re.compile(r'<p class="[^"]*lh-22[^"]*"[^>]*>(.+?)</p>', re.S),
    re.compile(r'<p class="[^"]*"[^>]*>(.+?)</p>', re.S),
)
_YAHOO_RU_RE = re.compile(r"/RU=([^/]+)/")


def _yahoo_search(
    query: str,
    region: str,
    timeout: float,
    deadline_monotonic: float,
) -> list[dict]:
    """Fetch + parse a Yahoo Search SERP. Yahoo's SERP wraps each result
    in a redirect anchor `r.search.yahoo.com/_ylt=.../RU=<percent-encoded
    target>/RK=...` containing an `<h3 class="title…">` with the title;
    the snippet lives in a `<p class="fc-dustygray…">` immediately after
    the closing `</a>`.

    Region is best-effort via the `vc=country=` param when set; Yahoo
    otherwise serves a global SERP that already includes major non-US
    sources for English queries."""
    _budget_check(deadline_monotonic)
    user_agent = random.choice(USER_AGENTS)
    headers = {
        "User-Agent": user_agent,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    remaining = max(0.5, _remaining_ms(deadline_monotonic) / 1000.0)
    effective_timeout = min(timeout, remaining)
    params: dict[str, str] = {"p": query}
    vc = _yahoo_region(region)
    if vc:
        params["vc"] = vc

    try:
        with httpx.Client(
            timeout=effective_timeout,
            follow_redirects=True,
            headers=headers,
        ) as client:
            resp = client.get(YAHOO_URL, params=params)
    except httpx.TimeoutException as exc:
        raise SearchError(
            f"yahoo timeout: {exc}", status=None, reason="transport"
        )
    except httpx.HTTPError as exc:
        raise SearchError(
            f"yahoo transport error: {exc}", status=None, reason="transport"
        )
    if resp.status_code != 200:
        raise SearchError(
            f"yahoo HTTP {resp.status_code}", status=resp.status_code
        )
    body = resp.text
    low = body.lower()
    # Yahoo's anti-bot page redirects to an interstitial with these markers.
    if (
        "are you a robot" in low
        or "captcha" in low
        or "consent.yahoo.com" in low
    ):
        raise SearchError("yahoo anomaly gate", status=429)

    raw: list[dict] = []
    for m in _YAHOO_RESULT_RE.finditer(body):
        href, title_html = m.group(1), m.group(2)
        if "video.search.yahoo" in href or "images.search.yahoo" in href:
            continue
        title = html.unescape(_TAG_STRIP_RE.sub("", title_html)).strip()
        rm = _YAHOO_RU_RE.search(href)
        real = unquote(rm.group(1)) if rm else href
        if not real.startswith(("http://", "https://")):
            continue
        # Drop Yahoo's own properties — they're internal nav, not results.
        if real.startswith(("https://www.yahoo.com", "https://yahoo.com")):
            continue
        end = m.end()
        nearby = body[end : end + 2000]
        snippet = ""
        for sre in _YAHOO_SNIPPET_RES:
            sm = sre.search(nearby)
            if sm:
                snippet = html.unescape(
                    _TAG_STRIP_RE.sub("", sm.group(1))
                ).strip()
                if snippet:
                    break
        if not title:
            continue
        raw.append(
            {
                "title": title,
                "href": real,
                "snippet": snippet,
                "display_url": "",
            }
        )
    return raw


def _yahoo_region(region: str) -> str:
    """Map a DDG-style region code to Yahoo's `vc=country=XX` value.
    Conservative: only emit when we have a confident mapping; otherwise
    return empty so Yahoo serves its global default."""
    r = (region or "").lower().strip()
    if r in ("", "wt-wt"):
        return ""
    if r.startswith("kr"):
        return "country=KR"
    if r.startswith("us"):
        return "country=US"
    if r.startswith("uk") or r.startswith("gb"):
        return "country=GB"
    if r.startswith("jp"):
        return "country=JP"
    if r.startswith("de"):
        return "country=DE"
    if r.startswith("fr"):
        return "country=FR"
    return ""


def _mojeek_region(region: str) -> str:
    """Map a DDG-style region code (`wt-wt`, `kr-kr`, `us-en`, ...) to
    Mojeek's `arc` param. Mojeek uses ISO country codes; only a small
    map is needed for the regions we actually expose."""
    r = (region or "").lower().strip()
    if r in ("", "wt-wt"):
        return ""
    if r.startswith("kr"):
        return "kr"
    if r.startswith("us"):
        return "us"
    if r.startswith("uk") or r.startswith("gb"):
        return "gb"
    if r.startswith("jp"):
        return "jp"
    if r.startswith("de"):
        return "de"
    if r.startswith("fr"):
        return "fr"
    return ""


def search(
    query: str,
    count: int = 10,
    region: str = "wt-wt",
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[list[dict], str]:
    """Return `(results, source_label)` for `query`, where `source_label`
    is one of `yahoo`, `mojeek`, `duckduckgo-lite`, or `duckduckgo-html`.

    Backend order: Yahoo → Mojeek → DDG lite → DDG `/html/`. Yahoo is the
    primary because, as of 2026-04-26, it serves SERPs to plain HTTP
    clients without a captcha gate from IPs that Mojeek (403) and DDG
    (anomaly.js) actively block. Mojeek and DDG remain as fallbacks for
    when Yahoo eventually gates us too — diversifying the upstream set is
    cheap insurance against any one provider flipping the switch.

    The single wall-clock budget covers the entire chain — a slow upstream
    attempt eats into the next fallback window, by design (we'd rather
    fail fast than blow the engine's tool-call timeout). Non-retriable
    HTTP errors short-circuit the chain to avoid hammering."""
    query = (query or "").strip()
    if not query:
        raise SearchError("query is empty")
    count = max(1, min(int(count), MAX_COUNT))

    # Single wall-clock budget for the entire call. Threaded through the
    # rate limiter, retry sleeps, and httpx timeout so no individual stall
    # can blow past the outer deadline.
    deadline_monotonic = time.monotonic() + (_BUDGET_MS / 1000.0)

    # Cross-process throttle so concurrent sub-agent calls don't burst
    # the upstream search engine. Same lock used regardless of backend
    # since Mojeek is also a small-shop service that deserves spacing.
    _enforce_rate_limit(deadline_monotonic)

    raw: list[dict] | None = None
    source = "yahoo"
    primary_err: SearchError | None = None
    try:
        raw = _yahoo_search(query, region, timeout, deadline_monotonic)
        if not raw:
            # 200 but zero parsed results — markup drift or genuinely no
            # hits. Treat as soft fail and try the next backend.
            raw = None
    except SearchError as exc:
        primary_err = exc
        raw = None

    if raw is None:
        _budget_check(deadline_monotonic)
        try:
            mojeek_raw = _mojeek_search(query, region, timeout, deadline_monotonic)
            if mojeek_raw:
                raw = mojeek_raw
                source = "mojeek"
        except SearchError as exc:
            # Keep the more informative error to surface if every backend bounces.
            if primary_err is None or primary_err.status in (None, 429):
                primary_err = exc

    if raw is None:
        _budget_check(deadline_monotonic)
        ddg_raw = _try_endpoint(
            LITE_URL, query, region, timeout, _LiteResultParser, deadline_monotonic
        )
        if ddg_raw is not None:
            raw = ddg_raw
            source = "duckduckgo-lite"
        else:
            _budget_check(deadline_monotonic)
            ddg_raw = _try_endpoint(
                HTML_URL,
                query,
                region,
                timeout,
                _HtmlResultParser,
                deadline_monotonic,
            )
            if ddg_raw is not None:
                raw = ddg_raw
                source = "duckduckgo-html"

    if raw is None:
        # Every backend bounced. Surface the most informative error.
        if primary_err is not None and primary_err.status not in (None, 429):
            raise primary_err
        raise SearchError("all search backends returned 202/429/403", status=202)

    out: list[dict] = []
    for rank, r in enumerate(raw[:count], start=1):
        href = r["href"]
        # DDG redirect unwrap is a no-op on Mojeek hrefs (already direct).
        url = _unwrap_ddg_redirect(href)
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
    return out, source
