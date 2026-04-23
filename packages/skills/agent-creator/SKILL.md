---
name: agent-creator
description: Scaffold an OpenHive agent persona as AGENT.md plus an optional flat reference/ directory. Use when the user asks to design a new reusable agent rather than wiring an inline prompt on the canvas.
---

# agent-creator

Skill for producing an OpenHive agent persona as **`AGENT.md` + a flat `reference/`** bundle. The 3-pass pipeline in `/api/agents/generate` follows this format.

> Naming: a capability is `SKILL.md`; a persona is `AGENT.md`. This file (`packages/skills/agent-creator/SKILL.md`) is a skill; its output is an `AGENT.md` bundle.

## Folder layout

```
<agent-name>/
├── AGENT.md              # Required. Entry point (frontmatter + Persona + Decision tree + Reference index + Escalation).
└── reference/            # Optional. Create only when needed. Flat — no nested folders.
    ├── <topic-a>.md
    └── <topic-b>.md
```

Retired structure: the legacy `knowledge/` + `behaviors/` + `examples/` split is gone. Everything flattens into `reference/`.

## When to create reference files

- Only when the user's description **names specific** research methods, deliverables, situations, or domains.
- Generic roles (e.g. "summariser agent", "translation agent") fit entirely in `AGENT.md`. Do not create reference files.
- Each reference file covers **one independent topic**. Merge overlapping topics into one file.

## Generation pipeline (3-pass)

The server (`apps/web/server/api/agents.ts`) takes the user's one-line description and produces the bundle via three LLM calls. All three run on the user's **defaultModel**.

1. **Planner** — extracts reference topics from the description. Each topic must carry an `evidence` field quoted verbatim from the description; the server validates this as a substring match. If no concrete cues exist, `references: []`.
2. **AGENT.md writer** — takes role / label / reference filename list as context and writes the body. Do **not** inline reference contents here.
3. **Reference writer (parallel)** — one call per topic from Pass 1, via `Promise.allSettled`. One failure does not block AGENT.md or the surviving files.

Numeric caps (e.g. "up to 5") are **never exposed to the prompt** — the model would treat them as targets. Caps are enforced only by server-side JSON validation.

## AGENT.md canonical format

```markdown
---
name: <slug>
description: <routing hint — see rules below>
model: <provider:model>   # optional — overrides the team default
skills: [pptx, docx]      # optional — tools.yaml takes precedence
mcp: [notion, gmail]      # optional
---

# Persona
One paragraph. Personality, responsibilities, tone.

# Decision tree
If-then rules. Cover the top 80% of cases only.

# Reference index          ← omit this section entirely if there are no reference files.
- reference/<file>.md — <one-line purpose>

# Escalation
When to stop, confirm with the user, or escalate to Lead.
```

- Under ~2KB total.
- Imperative voice, concrete wording.
- Do not inline reference contents — filenames only.

### `description` field (critical)

The **only signal** a parent agent reads when deciding whether to delegate to this sub-agent. Treat it as a routing hint, not a UI label.

- Concrete verb + object. Name the input, output, or domain.
- Must distinguish this agent from siblings with similar roles.
- One sentence, in the user's language.
- Bad: `research agent`, `Copilot`, `helps with tasks`
- Good: `researches academic papers and returns citations with DOI`
- Good: `summarises long PDFs into 3-bullet TL;DRs`
- Good: `extracts article body from a URL and formats it as markdown`

## Reference file rules

- Filename: lowercase, hyphens, `.md`. Examples: `academic-paper-search.md`, `citation-style.md`.
- Body: 200–600 words. Checklists, procedures, named sources / tools. No abstract pep talk.
- No YAML frontmatter, no level-1 heading.
- One topic per file — no overlap with AGENT.md or sibling reference files.

## Constraints

- `tools.yaml` is optional and only for persona-level permission narrowing — usually unnecessary. The team allow list governs permissions at the higher level.
- Filenames must match `[a-z0-9][a-z0-9-]*\.md`. No spaces, uppercase, or special characters.
- Persona `name` must be unique within a team.
