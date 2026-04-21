# AGENT.md — reference spec

Every persona (directory OR single-file) starts with `AGENT.md`. This file
is the only mandatory one. Everything else is optional.

## Frontmatter

YAML between `---` fences. Required fields bolded.

| Field | Type | Description |
|---|---|---|
| **`name`** | string | Unique persona identifier. Lowercase, hyphen-separated preferred. |
| `description` | string | One-line purpose — shown in UI pickers and logs. |
| `model` | string | Override the team's default model for this agent. |
| `skills` | list of strings | Skills to enable (intersected with team allow list). |
| `mcp` | list of strings | MCP servers to use (intersected with team allow list). |

Anything else in frontmatter is passed through to `PersonaDef.meta` for
future extensions — won't break current load.

## Body structure (recommended)

The engine doesn't enforce section order, but this layout is what templates
use and what the runtime's decision-tree hints assume:

```
# Persona
One paragraph. Personality, responsibilities, tone.

# Decision tree
Bullet list of if-then rules. Covers the common 80%.

# Knowledge index
One line per file in knowledge/, explaining when to read it.

# Escalation
When to stop / ask the user / hand back to Lead.
```

Sections you can add when useful:
- `# Examples` — mini few-shot snippets (full examples belong in `examples/`)
- `# Vocabulary` — domain terms the agent should use
- `# Constraints` — hard rules the agent must obey
- `# Output format` — if the agent always returns a specific structure

## Size guidance

- Body body: aim under 2KB. Push details into `knowledge/`.
- Whole AGENT.md: under 4KB. Anything bigger should be split.
- File tree: under 30 files. Bigger than that = restructure.

## Single-file vs directory

Use single-file `.md` when:
- The persona fits in one screen
- No external references or examples
- One-off or throwaway

Use directory when:
- Domain knowledge exceeds ~2KB
- You need few-shot examples
- The persona will be shared across teams
- You want to version-control each aspect independently

The loader picks the right path based on filesystem layout — no separate flag.
