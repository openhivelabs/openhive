# OpenHive Architecture Diagrams

Living visual documentation of how OpenHive works. Updated alongside code changes so
the diagrams never drift from reality.

## How to view

Two options:

1. **Open the shareable link** (fastest) — click any link in the table below, the diagram
   opens in excalidraw.com. No account needed. You can pan, zoom, and edit. To save edits
   back into the repo, copy the JSON from File → Save as... and replace the corresponding
   `.excalidraw` file.

2. **Open the local file** — drag any `.excalidraw` file from this directory into
   https://excalidraw.com to view or edit locally. Works offline.

## Diagrams

| # | File | Shareable link | What it shows |
|---|---|---|---|
| 01 | [`01-system-architecture.excalidraw`](./01-system-architecture.excalidraw) | [view](https://excalidraw.com/#json=wOESFSnsafWgjgVG2PPNC,XdBUYOWJJ6oGtH_3mNEtIw) | The layered stack — Browser → Proxy → FastAPI server (Engine / Tools / Providers / Event bus) → Local storage |
| 02 | [`02-delegation-sequence.excalidraw`](./02-delegation-sequence.excalidraw) | [view](https://excalidraw.com/#json=llWPxGWTEUM0b4IBFDJWF,7vznCHsO2xpF569f1E7rLA) | UML sequence — how "get fibonacci and summarize" becomes tokens, tool calls, and bubbles |

## Future diagrams

Planned — add to the list as we draw them:

- `03-engine-call-tree.excalidraw` — `run_team → _run_node → _stream_turn → _run_delegation` recursive structure
- `04-event-to-ui-mapping.excalidraw` — which engine event updates which UI element
- `05-oauth-token-dance.excalidraw` — Copilot 2-stage token flow (GitHub OAuth → copilot_internal → API call)
- `06-provider-comparison.excalidraw` — side-by-side auth flows for Claude Code / Codex / Copilot
- `07-file-system-layout.excalidraw` — `~/.openhive/` directory tree

## Update workflow

When architecture changes:

1. Edit the `.excalidraw` file directly (drag into excalidraw.com, make changes,
   Save as... → overwrite file) **OR** ask Claude to regenerate via the Excalidraw MCP.
2. Re-upload to get a fresh shareable link (`export_to_excalidraw` tool).
3. Update the link in this README.
4. Commit the `.excalidraw` file and this README together.

## Why Excalidraw

- Files are plain JSON — diffable, Git-friendly, no binary lock-in
- Hand-drawn aesthetic matches the "real company" vibe of OpenHive
- Free forever for our use (no paid plan needed)
- Export to PNG/SVG works if we ever need to embed in slides/posts
