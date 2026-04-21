# Authoring bundled skills — self-check protocol

Spec: `docs/superpowers/specs/2026-04-22-skill-verification.md`

This guide covers how bundled skill scripts under
`packages/skills/<name>/scripts/` should report their outcome so the
engine can surface structured results to the LLM. The goal is that a
failing skill gives the model a `suggestion` it can act on, instead of
a raw traceback that forces a dead-end reply.

## The rule: the final stdout line is the verdict

The runner (`apps/web/lib/server/skills/runner.ts`) parses the **last
non-empty line of stdout**. If that line is a JSON object with an
`ok: boolean` field, the runner treats it as a structured envelope and
propagates it to the engine. Otherwise the run is judged purely by exit
code and directory snapshot — legacy scripts still work.

Diagnostic logging goes to **stderr**. Never print freeform text after
the envelope, or the runner will miss it.

## Envelope shapes

Success:

```json
{
  "ok": true,
  "files": [
    { "name": "report.pdf", "path": "/abs/path/report.pdf", "mime": "application/pdf" }
  ],
  "warnings": ["optional strings"]
}
```

Failure:

```json
{
  "ok": false,
  "error_code": "bad_spec",
  "message": "human-readable cause",
  "suggestion": "concrete next step the LLM can act on"
}
```

When the runner sees a success envelope, its `files` array is preferred
over the output-directory snapshot — the script is the authoritative
source for what it produced. When it sees a failure envelope, the
result is marked not-ok even if the process exit code was 0.

## Python helper (`packages/skills/_lib/verify.py`)

Use the shared helper. It takes care of JSON formatting, exit codes,
and the common "file missing / file too small" checks:

```python
from _lib.verify import EmitError, check_file, emit_success, emit_error

def main():
    try:
        build(...)
        check_file(args.out, min_bytes=1000)
        emit_success(files=[{
            "name": os.path.basename(args.out),
            "path": args.out,
            "mime": "application/pdf",
        }])
    except EmitError as e:
        emit_error(e.code, e.message, e.suggestion)
```

`check_file` raises:

- `EmitError("empty_output", ...)` — file missing
- `EmitError("tiny_output", ...)` — file smaller than `min_bytes`

Each carries a `suggestion` the LLM can follow. Use your own
`EmitError` for domain-specific failures (`bad_spec`, `render_failed`,
`missing_dependency`, etc.) — pick short, snake_case codes.

## Self-check rule of thumb

1. After the write step, call `check_file` with a realistic floor
   (e.g. 1KB for a PDF, 2KB for a PPTX). A zero-byte file on disk +
   exit 0 is a silent failure — the check makes it loud.
2. Wrap the main flow in `try/except EmitError` and let `emit_error`
   do the JSON + exit.
3. Never bury errors under `except Exception: pass`. Convert them to
   `EmitError` with a `suggestion` or let them bubble up to the
   last-resort handler.

## Node scripts

A Node equivalent (`_lib/verify.js`) will be added when the first Node
skill needs it. The protocol is identical — emit the final JSON line to
stdout, exit non-zero on failure.

## Testing

- Python: `python3 -m unittest packages/skills/_lib/verify_test.py`
- TypeScript runner: `pnpm --filter @openhive/web test -- runner`

When you add a new skill script, add a smoke test that forces a failure
(malformed spec, missing output) and asserts the envelope is the
expected `{ok:false}` shape.
