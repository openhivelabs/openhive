/**
 * Rich guidance prose embedded into tool descriptions seen by the LLM every turn.
 *
 * OpenHive's previous tool descriptions were one-liners ("delegate a task to a
 * subordinate"). LLMs treated them loosely — ask_user fired on trivial greetings,
 * delegate_to was used without proper briefs, etc.
 *
 * Inspired by Claude Code's Task tool prose (see
 * docs/reference/claude-code/src/tools/AgentTool/prompt.ts:99-287): embedding
 * discipline into the tool catalog itself makes every LLM turn re-read the
 * rules alongside the tool schema.
 */

export function askUserGuidance(): string {
  return [
    'Ask the human user a clarifying question — but ONLY as a LAST RESORT.',
    '',
    '## Pre-check before calling (all must be true)',
    '1. You have considered 2+ plausible interpretations of the request, and they lead to materially INCOMPATIBLE downstream work (not merely different phrasing).',
    '2. Guessing wrong would cost >5 minutes of agent work, destroy data, or produce a deliverable the user would reject.',
    "3. The answer genuinely cannot be derived from the conversation, the team roster, the team's data DB, or prior artifacts.",
    '4. You did NOT call `ask_user` in your previous turn. Never chain questions across consecutive turns — process the prior answer and proceed.',
    '',
    '## When NOT to use',
    '- Greetings / small talk ("ㅎㅇ", "안녕", "hi", "thanks", "고마워요") — respond conversationally.',
    '- Tone / style decisions ("격식체냐 반말이냐", "자세히 vs 짧게") — pick the safer default; match the user\'s own tone.',
    '- Missing details you can reasonably infer — default to the most common choice (markdown format, 한국어 응답, 표준 PDF) and mention your assumption in the final answer.',
    '- Branching uncertainty — just enumerate in your response: "X 로 해석했습니다; Y 를 원하셨다면 알려주세요" is better than stopping to ask.',
    "- A subordinate's stated assumption — read it, verify, accept or correct yourself. Do NOT forward it as a question to the user.",
    '',
    '## Form',
    'Bundle ALL your questions into ONE call with numbered sub-questions (1-4). Each question needs 2-4 concrete option labels; the UI adds "Other" and "Skip" automatically. Put the recommended option first with " (Recommended)" suffix.',
  ].join('\n')
}

export function delegateToGuidance(): string {
  return [
    'Delegate a task to ONE direct subordinate. To fan out in parallel, call `delegate_to` MULTIPLE times in a single turn — the engine groups independent delegations automatically.',
    '',
    '## When to delegate vs answer directly',
    "Delegate when a subordinate's role actually covers the task. If no subordinate fits, answer yourself — do not force-delegate to a generalist. Trivial conversational turns (greetings, acknowledgements) → answer directly.",
    '',
    '## How to brief (every `task` MUST include)',
    'Subordinates start with ZERO context about this conversation. Brief them like a smart colleague who just walked into the room.',
    '- **Goal** — outcome in one sentence.',
    '- **Context** — file paths, prior attempts, constraints, data they need.',
    '- **Deliverable** — exact format you expect back: length cap ("under 300 words"), structure ("3-column markdown table"), required fields, artifact path if a file.',
    '- **Scope fence** — what they should NOT do. They cannot call `ask_user` (you alone can). They should not expand scope.',
    '',
    '## Never delegate understanding',
    'Do not write "based on your findings, decide X." Decide X yourself after they return evidence. Their job is evidence; synthesis is yours.',
    '',
    '## After they return',
    "Read their stated assumption — they are instructed to self-resolve ambiguity by picking the most plausible interpretation and stating it at the top of their result (\"가정: …\"). Verify; accept or silently correct. When they produce artifacts, ALWAYS cite the artifact:// URIs in your final response; the engine also tracks them in the session manifest.",
    '',
    '## Parallel fan-out (one message, multiple calls)',
    'For independent subtasks, call `delegate_to` MULTIPLE times in one turn — to the same role (fan-out) or to different roles (cross-role parallel). The engine auto-groups and runs concurrently. Do NOT fan out dependent tasks (B needs A\'s output — use serial delegation across turns).',
  ].join('\n')
}

export function activateSkillGuidance(): string {
  return [
    'Activate a skill to expose its guide + files in this conversation.',
    '',
    "`activate_skill({ name })` loads the skill's SKILL.md body (progressive disclosure) and returns its file list. After activation, use `read_skill_file` to read reference docs and `run_skill_script` (or the typed skill tool, if registered) to execute.",
    '',
    'Activate lazily — only when you actually need the skill. Do not activate every skill up front; each activation adds to the working context.',
  ].join('\n')
}
