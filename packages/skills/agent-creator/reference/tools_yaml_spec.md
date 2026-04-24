# tools.yaml — reference spec

Optional file in a directory-form persona. Declares what skills / MCP / data
access this persona uses. The team-level allow list is the actual gate —
`tools.yaml` can only **restrict**, never **expand** those permissions.

## Shape

```yaml
skills:                  # list of skill names
  - docx
  - pdf

mcp:                     # list of MCP server names
  - notion
  - slack

team_data:
  read: true             # default true
  write: false           # default false
  tables:                # optional — restrict which tables this persona touches
    - customer
    - deal
  write_fields:          # optional — if write=true, allow only these (dotted paths)
    - deal.stage
    - deal.owner

knowledge_exposure: full # full | summary | none. How freely the agent may
                         # quote its own knowledge files back to users.

notes: "Free-form operator note. Appended to the system prompt as an 'Operator notes:' line."

delegation:
  max_depth: 3           # optional. Clamps the engine's delegation depth limit for this persona.
  max_parallel: 2        # optional. Clamps parallel fan-out for this persona.
```

## knowledge_exposure levels

| Level | Behaviour |
|---|---|
| `full` | Agent may paste knowledge file contents verbatim in responses. Default. |
| `summary` | Agent may use knowledge internally but must paraphrase in responses. |
| `none` | Agent may read knowledge but may not surface it at all (useful for internal policies the end user shouldn't see). |

## Precedence

When the same key appears in both `AGENT.md` frontmatter and `tools.yaml`,
frontmatter wins. This lets you keep tools.yaml for operator-facing config
(notes, knowledge_exposure, team_data) and put the lean agent-facing list
(skills, mcp) in AGENT.md frontmatter.

## Intersection with team allow list

```
effective_skills  = (persona.skills ∪ node.skills) ∩ team.allowed_skills
effective_mcp     =  persona.mcp                    ∩ team.allowed_mcp_servers
                    (empty persona.mcp → team allow list passes through)
```

So: the persona cannot use a skill the team hasn't whitelisted. The team can
whitelist skills the persona doesn't explicitly list — those pass through
from the node's inline `skills` field.
