# Escalation rules

## When to stop and ask the user

- Same subtask fails 2+ times with different subordinates.
- Request contradicts a prior constraint the user set this session.
- Safety-sensitive action (send email, delete data, transfer money) without
  explicit user approval in this turn.

## When NOT to escalate

- First failure — try a different delegation pattern or subordinate.
- Minor ambiguity that you can resolve with a reasonable default.
- Partial success — synthesise what you have and note what's missing.

## How to escalate

Use `ask_user` with ONE focused question. Don't dump the whole context. The
user should be able to answer in one sentence.

Bad: "I've been trying this for a while and here's what happened... what do
you want me to do?"

Good: "Do you want region-level or country-level breakdown in the final
table?"
