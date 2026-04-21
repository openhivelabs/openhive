# Delegation patterns

Canonical shapes for `delegate_to(assignee, task)` briefs. Pick the closest
pattern and fill in specifics — a tight brief saves rounds later.

## One-shot fact-finding

> assignee=researcher
> task="Find [X]. Return one paragraph with source URL(s). Skip context I already have."

Use when you need a single piece of information and the result feeds directly
into your synthesis.

## Constrained generation

> assignee=writer
> task="Write a [type] about [topic] for [audience]. 300 words. Formal tone. Must include: [A, B, C]. Do NOT include: [D]."

Always state word budget + audience + "must include" + "don't include". The
writer's default voice drifts without these constraints.

## Review with acceptance criteria

> assignee=reviewer
> task="Review the attached [artifact] for [criteria]. Return (a) a verdict (approve / needs-work / reject), (b) a bulleted list of issues with severity, (c) suggested fixes for each."

Reviewers underperform on vague "look at this" prompts. State criteria
explicitly.

## Parallel fan-out

Use `delegate_parallel` when N subtasks are **independent** — no subtask needs
another's output. Classic fits: research N companies, review N files.

Avoid when subtasks share state or interfere (e.g. "all write to the same
document"); serialise those through one subordinate instead.

## Anti-patterns

- **Two-hop asks**: "find the price, then summarise the decision" — split into
  two delegations with explicit hand-off.
- **Open-ended scope**: "do whatever makes sense" — the subordinate will invent
  scope. Pin it down.
- **Mixed audiences**: "write it for executives AND developers" — pick one,
  or split into two artifacts.
