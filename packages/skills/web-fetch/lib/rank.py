"""Tiny BM25 over chunk list, pure stdlib. We don't pull rank-bm25 — the
implementation is a few lines and avoids one more dep for the whole repo.

BM25 Okapi with k1=1.5, b=0.75 (standard defaults). Tokenizer: lowercase,
split on non-word, drop single-char tokens. English + Korean both work because
split happens on any non-alphanumeric — Hangul syllables stay intact.
"""

from __future__ import annotations

import math
import re
from collections import Counter

_TOK_RE = re.compile(r"[^\w가-힣]+", re.UNICODE)


def _tokenize(s: str) -> list[str]:
    return [t for t in _TOK_RE.split(s.lower()) if len(t) > 1]


def rank(query: str, chunks: list[str], *, top_k: int = 6) -> list[tuple[int, float, str]]:
    """Return top_k (index, score, chunk) sorted desc by BM25 score. Chunks
    with zero score are still returned as fillers if top_k not reached; this
    keeps responses stable and non-empty when the query is far from the text.
    """
    if not chunks:
        return []

    q_terms = _tokenize(query)
    if not q_terms:
        # No usable query terms — fall back to first top_k chunks in order.
        return [(i, 0.0, c) for i, c in enumerate(chunks[:top_k])]

    tokenized = [_tokenize(c) for c in chunks]
    N = len(chunks)
    avgdl = sum(len(d) for d in tokenized) / N if N else 0
    df: dict[str, int] = {}
    for d in tokenized:
        for term in set(d):
            df[term] = df.get(term, 0) + 1
    idf = {t: math.log(1 + (N - n + 0.5) / (n + 0.5)) for t, n in df.items()}

    k1, b = 1.5, 0.75
    scores: list[tuple[int, float]] = []
    for i, d in enumerate(tokenized):
        if not d:
            scores.append((i, 0.0))
            continue
        dl = len(d)
        tf = Counter(d)
        s = 0.0
        for term in q_terms:
            if term not in tf:
                continue
            f = tf[term]
            s += idf.get(term, 0.0) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl))
        scores.append((i, s))

    scores.sort(key=lambda x: x[1], reverse=True)
    top = scores[:top_k]
    # Preserve original order within the returned subset — reading order beats
    # score order for the LLM (context flows naturally).
    top_sorted_by_index = sorted(top, key=lambda x: x[0])
    return [(i, s, chunks[i]) for i, s in top_sorted_by_index]
