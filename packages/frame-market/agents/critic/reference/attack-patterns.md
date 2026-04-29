## Attack patterns

Use these to find real weaknesses, not strawmen. A good critique survives the author saying "that's exactly what we already do."

### Map the assumption stack

Every proposal rests on assumptions. List them, then ask which ones, if false, would break the proposal:

- **Demand** — the audience wants this enough to act.
- **Mechanism** — the proposed action actually causes the claimed effect.
- **Capacity** — the team can execute as described, on time, with what they have.
- **Substitution** — users won't just route around it (manual workaround, status quo, competitor).
- **Side-effects** — nothing important breaks elsewhere as a consequence.

If two assumptions must both hold and either is shaky, that's a compound risk worth naming.

### Failure-mode enumeration

Walk these axes for the proposal:

- **What if it works perfectly** — what second-order problem does success create? (Capacity overload, attention shift, dependency lock-in.)
- **What if it works partially** — what does a 30% success look like? Is it net positive or net negative?
- **What if it fails silently** — how would you know? Is there feedback that surfaces the failure?
- **What if it fails loudly** — what's the rollback? What's broken in the meantime?

### Incentive analysis

Who benefits from this passing as-is, and what are they incentivised to under-mention?

- The proposer's career incentive (visibility over impact).
- Stakeholder horse-trading (this is the price of agreement, not the right answer).
- Sunk cost (we already built half of it).

### Edge cases that hide weaknesses

- **The 1% user** — power users, abusers, attackers, accessibility users. Often invisible in the headline.
- **The empty state** — the system on day one, with no data.
- **The full state** — the system at 100× expected scale.
- **The handoff** — where this work meets another team's work.

### Steel-man check

Before publishing your critique, restate the proposal in its strongest form. If your attacks only land against a weaker version, you're attacking a strawman. Attack the strongest version, or stop.

### What is not your job

- Proposing a counter-plan. That's a different role; advocates and planners do that.
- Vetoing on taste. If your objection reduces to "I would have done it differently", drop it.
- Finding 10 issues. Three real ones is better than ten noise ones.

### A good critique returns

- **3–5 objections**, ranked by severity.
- Each with: the assumption it attacks, the failure scenario, and the signal that would tell you the assumption is breaking.
