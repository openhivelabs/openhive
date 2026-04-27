#!/usr/bin/env python3
"""Edit an existing PDF.

Two edit tracks (same philosophy as docx skill):

  PAGE ops  — manipulate pages as opaque units (no content change)
              merge, split, extract_pages, rotate, overlay_text, overlay_image
              These run via pypdf — fast, lossless, always safe.

  SPEC ops  — change document content (set_text, replace_block, insert_block,
              delete_block, move_block)
              These rewrite the paired .spec.json and re-run build_doc.py.
              Requires that the PDF was produced by build_doc.py (or that
              extract_doc.py has generated a spec.json first — lossy).

Usage:
    python edit_doc.py --in in.pdf --patch patch.json --out out.pdf
    # patch can also be passed via stdin (preferred — keeps JSON out of the
    # artifact directory):
    echo '{...}' | python edit_doc.py --in in.pdf --out out.pdf
    python edit_doc.py --in in.pdf --patch - --out out.pdf
    # spec auto-loaded from <in>.spec.json if present
    # or explicit: --spec in.pdf.spec.json
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT))
sys.path.insert(0, str(SKILL_ROOT.parent))

from _lib.output_path import resolve_out  # noqa: E402


PAGE_OPS = {"merge", "split", "extract_pages", "rotate",
            "overlay_text", "overlay_image"}
SPEC_OPS = {"set_text", "replace_block", "insert_block", "delete_block",
            "move_block", "update_table_cell"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--patch", default=None,
                    help="Path to patch JSON. '-' or omitted reads stdin.")
    ap.add_argument("--out", required=True)
    ap.add_argument("--spec", default=None)
    ap.add_argument("--scratch", action="store_true",
                    help="Write to --out literally (skip OPENHIVE_OUTPUT_DIR). "
                         "Use for verification renders that should not appear "
                         "in the chat artifact panel.")
    args = ap.parse_args()

    try:
        from helpers import pdf_ops
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"missing dep: {e}"}))
        return 1

    inp = pathlib.Path(args.inp).expanduser()
    out = resolve_out(args.out, scratch=args.scratch)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        patch = _load_patch(args.patch)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"patch load failed: {e}"}))
        return 1

    ops = patch.get("operations")
    if not isinstance(ops, list):
        print(json.dumps({"ok": False, "error": "patch.operations must be an array"}))
        return 1

    page_ops = [o for o in ops if o.get("op") in PAGE_OPS]
    spec_ops = [o for o in ops if o.get("op") in SPEC_OPS]
    unknown = [o for o in ops if o.get("op") not in (PAGE_OPS | SPEC_OPS)]
    if unknown:
        print(json.dumps({
            "ok": False,
            "error": f"unknown op(s): {[o.get('op') for o in unknown]}",
        }))
        return 1

    # spec-level editing first (produces a new PDF via regeneration), then
    # apply page-level ops on top of that PDF. This order matters because
    # spec rebuild reset pages.
    current_source = inp

    # Scratch dir for every interim artifact (rebuilt PDFs, step files,
    # spec snapshots). Lives under /tmp so OPENHIVE_OUTPUT_DIR — and the
    # chat artifact panel that mirrors it — never sees these files.
    work = pathlib.Path(tempfile.mkdtemp(prefix="pdf_edit_"))

    if spec_ops:
        spec_path = pathlib.Path(args.spec) if args.spec else pathlib.Path(str(inp) + ".spec.json")
        if not spec_path.exists():
            print(json.dumps({
                "ok": False,
                "error": f"spec-level op requested but no .spec.json at {spec_path}. "
                         f"Either provide --spec, run extract_doc.py first, or use only page ops.",
            }))
            return 1
        try:
            spec = json.load(open(spec_path, "r", encoding="utf-8"))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"spec load failed: {e}"}))
            return 1

        try:
            spec = _apply_spec_ops(spec, spec_ops)
        except ValueError as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            return 1

        # write spec, rebuild PDF — both into the scratch dir so they never
        # surface as chat attachments
        interim_pdf = work / "interim.pdf"
        interim_spec = work / "interim.pdf.spec.json"
        interim_spec.write_text(json.dumps(spec, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        build_path = pathlib.Path(__file__).resolve().parent / "build_doc.py"
        # Mark the child as an internal call so resolve_out passes the
        # interim path through unchanged. Without this the child would
        # rewrite interim_pdf to <artifact>/<basename> and the parent
        # would later read from a stale path.
        child_env = {**os.environ, "OPENHIVE_SKILL_INTERNAL": "1"}
        proc = subprocess.run(
            [sys.executable, str(build_path), "--spec", str(interim_spec),
             "--out", str(interim_pdf)],
            capture_output=True, text=True, env=child_env,
        )
        if proc.returncode != 0:
            print(json.dumps({
                "ok": False,
                "error": f"spec rebuild failed: {proc.stdout}{proc.stderr}",
            }))
            return 1
        current_source = interim_pdf

    # now apply page ops sequentially. Step files go to the scratch dir;
    # only the final pass writes to `out`.
    for i, op in enumerate(page_ops):
        kind = op["op"]
        next_path = (work / f"step{i}.pdf") if i < len(page_ops) - 1 else out
        try:
            if kind == "merge":
                inputs = [str(current_source)] + list(op.get("append", []))
                pdf_ops.merge(inputs, str(next_path))
            elif kind == "extract_pages":
                pdf_ops.extract_pages(str(current_source), str(next_path),
                                      op["pages"])
            elif kind == "rotate":
                pdf_ops.rotate(str(current_source), str(next_path),
                               op["pages"], int(op["degrees"]))
            elif kind == "overlay_text":
                pdf_ops.overlay_text(
                    str(current_source), str(next_path),
                    text=op["text"], pages=op.get("pages"),
                    x=op.get("x", 72), y=op.get("y", 72),
                    size=op.get("size", 48),
                    color=tuple(op.get("color", [0.85, 0.1, 0.1])),
                    rotation=op.get("rotation", 0),
                    opacity=op.get("opacity", 0.25),
                )
            elif kind == "overlay_image":
                pdf_ops.overlay_image(
                    str(current_source), str(next_path),
                    image_path=op["image"], pages=op.get("pages"),
                    x=op.get("x", 36), y=op.get("y", 36),
                    width=op.get("width", 120), height=op.get("height", 40),
                    opacity=op.get("opacity", 1.0),
                )
            elif kind == "split":
                paths = pdf_ops.split_by_ranges(
                    str(current_source),
                    op.get("out_dir", str(out.parent)),
                    [tuple(r) for r in op["ranges"]],
                )
                # split produces multiple outputs; we stop and report them
                print(json.dumps({
                    "ok": True, "mode": "split",
                    "outputs": paths, "count": len(paths),
                }, ensure_ascii=False))
                return 0
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"op[{i}] ({kind}): {e}"}))
            return 1
        current_source = next_path

    # if no page ops and we did spec-rebuild, move interim → out
    if not page_ops and spec_ops:
        shutil.move(str(current_source), str(out))
        # also save the new spec next to the out file (this one is intentional —
        # downstream spec ops need it to round-trip)
        out_spec = out.with_suffix(out.suffix + ".spec.json")
        scratch_spec = work / "interim.pdf.spec.json"
        if scratch_spec.exists():
            shutil.move(str(scratch_spec), str(out_spec))

    # tear down the scratch dir; everything in it was internal to this run
    shutil.rmtree(work, ignore_errors=True)

    # final report
    try:
        from helpers.pdf_ops import count_pages
        pages = count_pages(str(out))
    except Exception:
        pages = None

    print(json.dumps({
        "ok": True, "path": str(out), "pages": pages,
        "spec_ops": len(spec_ops), "page_ops": len(page_ops),
    }, ensure_ascii=False))
    return 0


def _load_patch(path: str | None) -> dict:
    """Load patch JSON. None or '-' → stdin (preferred — keeps the JSON out of
    OPENHIVE_OUTPUT_DIR and therefore out of the chat artifact panel)."""
    if not path or path == "-":
        return json.load(sys.stdin)
    with open(pathlib.Path(path).expanduser(), "r", encoding="utf-8") as f:
        return json.load(f)


def _apply_spec_ops(spec: dict, ops: list[dict]) -> dict:
    blocks = list(spec.get("blocks", []))
    for i, op in enumerate(ops):
        kind = op["op"]
        if kind == "set_text":
            pos = int(op["position"])
            if not (0 <= pos < len(blocks)):
                raise ValueError(f"op[{i}].position out of range")
            blk = dict(blocks[pos])
            blk["text"] = op["value"]
            blocks[pos] = blk
        elif kind == "replace_block":
            pos = int(op["position"])
            if not (0 <= pos < len(blocks)):
                raise ValueError(f"op[{i}].position out of range")
            blocks[pos] = op["block"]
        elif kind == "insert_block":
            pos = int(op["position"])
            pos = max(0, min(pos, len(blocks)))
            blocks.insert(pos, op["block"])
        elif kind == "delete_block":
            pos = int(op["position"])
            if not (0 <= pos < len(blocks)):
                raise ValueError(f"op[{i}].position out of range")
            blocks.pop(pos)
        elif kind == "move_block":
            fr = int(op["from"]); to = int(op["to"])
            if not (0 <= fr < len(blocks)):
                raise ValueError(f"op[{i}].from out of range")
            blk = blocks.pop(fr)
            to = max(0, min(to, len(blocks)))
            blocks.insert(to, blk)
        elif kind == "update_table_cell":
            pos = int(op["position"])
            r = int(op["r"]); c = int(op["c"])
            if not (0 <= pos < len(blocks)):
                raise ValueError(f"op[{i}].position out of range")
            blk = dict(blocks[pos])
            if blk.get("type") != "table":
                raise ValueError(f"op[{i}]: target block is not a table")
            rows = [list(row) for row in blk.get("rows", [])]
            if not (0 <= r < len(rows)):
                raise ValueError(f"op[{i}].r out of range")
            if not (0 <= c < len(rows[r])):
                raise ValueError(f"op[{i}].c out of range")
            rows[r][c] = op["value"]
            blk["rows"] = rows
            blocks[pos] = blk
    return {**spec, "blocks": blocks}


if __name__ == "__main__":
    raise SystemExit(main())
