## Risk taxonomy

Plans fail in patterned ways. Use this list to surface the risks worth naming, instead of generic "things might go wrong".

### Schedule risks

- **Hidden dependency** — a step depends on a person, system, or approval not on the plan.
- **Unsized work** — a step has no estimate; almost always means it's larger than expected.
- **Critical-path single owner** — one person blocks multiple downstream steps; if they're out, everything stops.
- **Optimistic estimate** — the estimate assumes nothing goes wrong; add a buffer or split the step.
- **Sequential where parallel was possible** — flag for re-planning rather than accepting the slowdown.

### Resource risks

- **Capacity assumed, not confirmed** — owner is named but their availability hasn't been checked against their other commitments.
- **Skill gap** — the work needs expertise the team doesn't have; needs hire, contract, or training time built in.
- **Shared resource contention** — DBA, design, legal, security review queues that other teams also use.

### Scope risks

- **Acceptance criteria undefined** — "done" is whatever the loudest stakeholder says.
- **Multi-objective conflict** — two goals will collide; the plan needs to pick a tiebreaker.
- **Stakeholder not aligned** — a key approver hasn't actually signed off on the goal yet.

### Technical and external risks

- **Vendor or API dependency** — third party can change pricing, deprecate, or rate-limit you.
- **Data quality unknown** — you're assuming the data shape; verify before building on it.
- **Regulatory or legal review** — adds calendar time you can't compress.
- **Rollback plan missing** — what happens if the launch goes wrong on day one.

### How to surface a risk

For each named risk, write three short lines:

1. **What** — one sentence describing the risk.
2. **Trigger** — what would tell you it's happening.
3. **Mitigation** — what to do now (or what would buy you optionality later).

A risk without a trigger is a worry. A risk without a mitigation is a complaint.

### Risks not worth naming

- Generic "what if priorities change" with no specific signal.
- "What if the team gets sick" unless the plan has a critical-path single owner.
- Risks the plan already mitigates structurally — naming them is noise.

Aim for **3 named risks**, not a long list. A long risk register reads as defensive and gets ignored.
