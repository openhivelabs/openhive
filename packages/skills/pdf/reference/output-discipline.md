# Output discipline

**One user-facing PDF per request.** Whatever the user asked for —
"build me a report", "edit this PDF", "add a watermark" — there should be
exactly one file in the chat artifact panel at the end: the final
deliverable.

## Rules

- **Don't run an op with `--out` for every intermediate step.** Chain page
  ops inside a single `edit_doc.py` call — interim PDFs go to
  `tempfile.mkdtemp()` and are deleted, only the final lands in the
  artifact dir.
- **Pipe patch JSON through stdin.** `edit_doc.py` accepts `--patch -` (or
  no `--patch` at all) and reads from stdin — never write `*_patch.json` to
  disk.
- **Verification renders use `--scratch`.** Pass `--scratch` to
  `build_doc.py` / `edit_doc.py` for sanity-check builds. The file is
  written to `/tmp` and does NOT enter `OPENHIVE_OUTPUT_DIR`.
- **`split` is the one exception** — it intentionally produces N files.
  Run it only when the user asked for split outputs.
- **Reuse the same `--out` name** when iterating ("v1, v2, v3" is noise —
  overwrite `report.pdf`).

## Filename heuristic

Generic names are auto-routed to `/tmp` and do NOT appear in the chat
artifact panel:
`out.pdf`, `tmp.pdf`, `test.pdf`, `probe.pdf`, `check.pdf`, `verify.pdf`,
`preview.pdf`, `debug.pdf`, `scratch.pdf`, `sample.pdf`, `draft.pdf`,
`output.pdf`, `foo.pdf`, `bar.pdf`, `baz.pdf`, plus any `<keyword>*` /
`*_<keyword>*` variant (e.g. `fulltest.pdf`, `tmp_x.pdf`).

A stderr note tells you when the heuristic fires. Pick a semantic filename
like `report.pdf` / `q1-summary.pdf` for the real deliverable.

## Path-based dedup

The artifact registry dedupes by `(skill_name, absolute path)`. Multiple
builds to the same path show as ONE entry that updates in place. Old
records get archived automatically — feel free to overwrite as you iterate.
