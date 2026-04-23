/**
 * Tool description prose for the Lead's tool catalog.
 *
 * Kept deliberately terse — the full playbook lives in DEFAULT_LEAD_SYSTEM_PROMPT
 * (system prompt, rendered once per turn). Tool descriptions are seen alongside
 * the tools every turn; they carry just the gist + form so the LLM remembers
 * the key rule at the point of use without paying the full playbook twice.
 */

export function askUserGuidance(): string {
  return [
    'Ask the user a clarifying question — LAST RESORT only. Full policy is in your system prompt.',
    '',
    'Pre-check (all must hold):',
    '1. 2+ plausible interpretations lead to INCOMPATIBLE downstream work.',
    '2. Guessing wrong costs >5min or produces a rejectable deliverable.',
    '3. Cannot infer from conversation / roster / DB / artifacts.',
    "4. You did NOT call ask_user in the previous turn (never chain).",
    '',
    "NOT reasons: greetings, tone/register (always 존댓말 in Korean), default formats, enumerable branching, a subordinate's stated assumption.",
    '',
    'Form: bundle ALL pending questions into ONE call. 2-4 option labels per question; put the recommended option first with " (Recommended)" suffix.',
  ].join('\n')
}

export function delegateToGuidance(): string {
  return [
    'Delegate a task to ONE direct subordinate. Call this tool MULTIPLE times in a single turn to fan out parallel (engine auto-groups independent delegations). Do not fan out dependent tasks.',
    '',
    'Every `task` MUST contain:',
    '- **Goal** — outcome in one sentence.',
    '- **Context** — file paths, prior attempts, constraints, data.',
    '- **Deliverable** — exact format (length, structure, required fields, artifact path if a file).',
    '- **Scope fence** — what NOT to do. Subordinates cannot call ask_user and must not expand scope.',
    '',
    'Never delegate understanding ("based on findings, decide X" is banned). Synthesis is yours.',
    '',
    "After they return: read their stated assumption (they self-resolve ambiguity with a short 'Assumption: ...' line), verify, accept or silently correct. Cite any artifact:// URIs they produced when relevant to the user's request (engine tracks them in <session-artifacts>).",
  ].join('\n')
}

export function activateSkillGuidance(): string {
  return [
    "Load a skill's SKILL.md guide into context and expose its files. Use `read_skill_file` for reference docs, `run_skill_script` to execute. Activate lazily — only when you need the skill.",
  ].join('\n')
}
