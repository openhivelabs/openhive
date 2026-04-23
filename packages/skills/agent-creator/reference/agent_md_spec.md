# AGENT.md — reference spec

Every persona (directory OR single-file) starts with `AGENT.md`. This is
the only mandatory file. Everything else is optional and lives under a
flat `reference/` subdirectory.

## Frontmatter

YAML between `---` fences. Required fields bolded.

| Field | Type | Description |
|---|---|---|
| **`name`** | string | Unique persona identifier. Lowercase, hyphen-separated preferred. |
| `description` | string | Routing hint parent agents read to decide delegation. Concrete verb + object, distinguishable from siblings. See "Description rules" below. |
| `model` | string | Override the team's default model for this agent. |
| `skills` | list of strings | Skills to enable (intersected with team allow list). |
| `mcp` | list of strings | MCP servers to use (intersected with team allow list). |

Anything else in frontmatter passes through to `PersonaDef.meta`.

## Description rules

`description` is the only signal a parent agent reads when deciding whether to delegate. Treat it as a routing hint, not a UI label.

- Concrete verb + object — name the input, output, or domain.
- Must distinguish this agent from siblings with similar roles.
- One sentence, in the user's language.
- Bad: `research agent`, `Copilot`, `helps with tasks`
- Good: `researches academic papers and returns citations with DOI`
- Good: `summarises long PDFs into 3-bullet TL;DRs`
- Good: `extracts article body from a URL and formats it as markdown`

## Body structure

```
# Persona
One paragraph. Personality, responsibilities, tone.

# Decision tree
Bullet list of if-then rules. Covers the common 80%.

# Reference index            ← OMIT entirely when no reference files exist.
- reference/<file>.md — <one-line purpose>

# Escalation
When to stop, ask the user, or hand back to Lead.
```

Optional sections (add only when they earn their keep):
- `# Vocabulary` — domain terms the agent should use
- `# Constraints` — hard rules the agent must obey
- `# Output format` — when the agent always returns a specific structure

## Reference directory

Flat layout only — no sub-folders. Each file is one independent topic.

```
<agent>/
├── AGENT.md
└── reference/
    ├── topic-a.md
    └── topic-b.md
```

If you need to signal intent beyond topic name, prefix the filename:
`example-*.md`, `rule-*.md`, `checklist-*.md`. Do NOT introduce
category folders (`knowledge/`, `behaviors/`, `examples/` — all legacy
and removed).

Each reference file:
- 200–600 words.
- Plain markdown. No YAML frontmatter. No level-1 heading.
- Concrete: checklists, procedures, named sources, heuristics.
- Covers exactly one topic — no overlap with AGENT.md or siblings.

## Size guidance

- AGENT.md body: under ~2KB. Push details into `reference/`.
- Each reference file: 200–600 words (≈1–3KB).
- Whole directory: under 30 files.

## Single-file vs directory

Use single-file `.md` when the persona fits on one screen with no
external references. Use a directory when the agent benefits from
on-demand reference material. The loader picks the right path from
filesystem layout — no separate flag.
