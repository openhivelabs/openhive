# Comparison brief — canonical shape

**Prompt:** "Compare vendor A, B, C on price, integration, support."

**Structure to return:**

```
## Verdict (one sentence)
B is the best fit for teams under 50 seats; A wins on integrations but costs 2x.

## Comparison

| Dimension    | A         | B          | C         |
|--------------|-----------|------------|-----------|
| Price (mo)   | $299      | $99        | $149      |
| Integrations | 150+      | 40         | 80        |
| Support      | 24/7 chat | biz-hours  | email     |

## Notes per vendor

- A: strongest API surface; enterprise-only.
- B: best value; limited Slack integration.
- C: mid-tier; no public roadmap.

## Sources
- [A's pricing page](...)    (retrieved 2026-04-19)
- [B's docs](...)
- [G2 review summary](...)
```

Keep the verdict to one sentence. The user should be able to read just that
line and decide.
