"""Resolve skill output paths against OPENHIVE_OUTPUT_DIR.

The runtime sets OPENHIVE_OUTPUT_DIR to the run's artifact directory and uses
that dir as cwd. Some agents (especially smaller models) still pass absolute
paths like '/tmp/foo.pdf' for --out, which historically wrote outside the
artifact dir. text-file rejects those outright; pdf/docx/pptx silently
honored them — an inconsistent contract the model couldn't learn.

`resolve_out` unifies the policy: when OPENHIVE_OUTPUT_DIR is set, any path
with a directory component (absolute or relative) is rewritten to
`<artifact>/<basename>` and a one-line note is logged to stderr so the model
sees what happened. When OPENHIVE_OUTPUT_DIR is unset (CLI / tests), the
path passes through expanduser+resolve unchanged.

Escape hatch: when OPENHIVE_SKILL_INTERNAL=1 the helper short-circuits.
edit_doc.py uses this when spawning build_doc.py with an interim path —
otherwise the child would rewrite the interim file out from under the
parent.
"""

from __future__ import annotations

import os
import pathlib
import re
import sys
import tempfile


# Tokens that almost always mean "verification render, not a deliverable".
# Match strategy: split the basename stem by [_.\-\s] and check whether any
# segment is in this set. Catches `test.pdf`, `q1-test.pdf`, `my_test_v2.pdf`
# while leaving real names alone (`contest.pdf`, `outcome.pdf`, `report.pdf`).
# Includes common compound forms the model likes to invent (`fulltest`,
# `smoketest`, `testrun`) so we don't have to rev this list every time the
# agent finds a new way to spell "throwaway".
_SCRATCH_TOKENS: frozenset[str] = frozenset({
    "test", "probe", "tmp", "temp", "check", "verify", "preview",
    "debug", "scratch", "sample", "draft", "out", "output",
    "foo", "bar", "baz", "qux",
    # compound forms
    "fulltest", "smoketest", "smoketests", "regtest", "inttest",
    "unittest", "sanitytest", "finaltest", "quicktest", "maintest",
    "testrun", "testbuild", "testreport", "testoutput",
    "scratchbuild", "scratchreport", "probebuild", "probereport",
})

_STEM_SPLIT_RE = re.compile(r"[_.\-\s]+")


def _looks_like_scratch_name(basename: str) -> bool:
    stem = basename.rsplit(".", 1)[0].lower()
    if not stem:
        return False
    segments = _STEM_SPLIT_RE.split(stem)
    return any(seg in _SCRATCH_TOKENS for seg in segments)


def is_scratch_target(path: str | pathlib.Path, *, scratch: bool = False) -> bool:
    """Return True iff this --out value will be treated as scratch.

    Scripts call this BEFORE emit_success to decide whether to declare the
    output file in the envelope `files` array. A scratch target must NOT be
    declared — the runner registers any envelope-declared file as a chat
    artifact regardless of where it lives on disk, so just rerouting the
    path to /tmp isn't enough; the script also has to stay quiet about it.

    Mirrors the auto-scratch logic in resolve_out so callers don't drift
    out of sync.
    """
    if scratch:
        return True
    if os.environ.get("OPENHIVE_SKILL_INTERNAL") == "1":
        return False  # internal subprocess — we DO want artifact registration
    if not os.environ.get("OPENHIVE_OUTPUT_DIR"):
        return False  # CLI / standalone — no artifact tracking anyway
    p = pathlib.Path(str(path)).expanduser()
    return _looks_like_scratch_name(p.name)


def resolve_out(path: str | pathlib.Path, *, scratch: bool = False) -> pathlib.Path:
    """Resolve --out against the run's artifact directory.

    Returns an absolute Path. The caller is responsible for `mkdir(parents=...)`
    on the parent — matching the verify.py convention of pure helpers.

    `scratch=True` short-circuits the rewrite — the file lands wherever the
    caller said, completely skipping OPENHIVE_OUTPUT_DIR. Use it for
    verification renders that should not appear in the chat artifact panel.
    """
    if not path:
        # Caller's argparse should have made this required, but guard anyway.
        raise ValueError("output path is empty")

    raw = str(path)
    out_dir_env = os.environ.get("OPENHIVE_OUTPUT_DIR")
    internal = os.environ.get("OPENHIVE_SKILL_INTERNAL") == "1"

    p = pathlib.Path(raw).expanduser()

    # Auto-promote obvious throwaway names (test*.pdf, probe*.pdf, tmp*.pdf,
    # out*.pdf, …) to scratch — even if the caller didn't pass --scratch.
    # The model keeps minting these to "verify the build" and they pile up
    # as chat artifacts. Loud stderr note so the agent learns the rule.
    if not scratch and not internal and out_dir_env \
            and _looks_like_scratch_name(p.name):
        sys.stderr.write(
            f"note: {p.name!r} looks like a verification/test render — "
            f"auto-routed to /tmp so it won't appear in the chat artifact "
            f"panel. If this is actually the deliverable, rename it to "
            f"something descriptive.\n"
        )
        scratch = True

    # CLI / standalone use OR child subprocess of edit_doc.py OR scratch mode:
    # don't redirect into OPENHIVE_OUTPUT_DIR. Scratch mode also forces bare
    # relative names off the artifact dir so a "test.pdf" can't sneak in via
    # cwd resolution.
    if not out_dir_env or internal or scratch:
        if scratch and not p.is_absolute() and len(p.parts) == 1:
            scratch_dir = pathlib.Path(
                tempfile.mkdtemp(prefix="openhive_skill_scratch_")
            )
            return (scratch_dir / p.name).resolve()
        return p.resolve()

    # Bare filename in the run's cwd — already inside artifact dir, nothing
    # to rewrite. (cwd is set to OPENHIVE_OUTPUT_DIR by the runtime.)
    if not p.is_absolute() and len(p.parts) == 1:
        return (pathlib.Path(out_dir_env) / p).resolve()

    out_dir = pathlib.Path(out_dir_env)
    target = (out_dir / p.name).resolve()
    sys.stderr.write(
        f"note: {raw!r} rewritten to {str(target)!r} "
        f"(skill outputs must live under OPENHIVE_OUTPUT_DIR)\n"
    )
    return target
