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
import sys


def resolve_out(path: str | pathlib.Path) -> pathlib.Path:
    """Resolve --out against the run's artifact directory.

    Returns an absolute Path. The caller is responsible for `mkdir(parents=...)`
    on the parent — matching the verify.py convention of pure helpers.
    """
    if not path:
        # Caller's argparse should have made this required, but guard anyway.
        raise ValueError("output path is empty")

    raw = str(path)
    out_dir_env = os.environ.get("OPENHIVE_OUTPUT_DIR")
    internal = os.environ.get("OPENHIVE_SKILL_INTERNAL") == "1"

    # CLI / standalone use OR child subprocess of edit_doc.py: pass through.
    if not out_dir_env or internal:
        return pathlib.Path(raw).expanduser().resolve()

    p = pathlib.Path(raw).expanduser()
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
