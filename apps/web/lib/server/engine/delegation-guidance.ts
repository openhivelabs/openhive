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
    'NOT reasons (DEFAULT instead, do not ask):',
    "- Greetings, small talk, short acknowledgements.",
    "- Tone / register — ALWAYS the formal register of the user's language.",
    "- **Deliverable / document output language** — default to the user's conversation language. If the user wrote in Korean, produce Korean documents; do not ask.",
    '- Deliverable / document tone — same as register rule; always formal. Never ask "한국어(존댓말) vs 한국어(반말)".',
    "- Default formats — Markdown for prose, PDF for reports, A4 for print, 존댓말 for Korean deliverables.",
    "- Enumerable branching — just state your interpretation and proceed (\"X 로 해석했습니다; Y 를 원하셨다면 알려주세요\" is better than stopping).",
    "- A subordinate's stated assumption — you (not the user) verify and correct.",
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
    "Load a skill's SKILL.md guide into context. Returns the guide body only — call `list_skill_files` if you need to see the skill directory tree, `read_skill_file` for specific reference docs, `run_skill_script` to execute. Activate lazily — only when you need the skill.",
  ].join('\n')
}

export function listSkillFilesGuidance(): string {
  return [
    "List the file tree of an already-activated skill (references/, scripts/, assets/, etc.). Call this only when SKILL.md mentions a file you cannot locate by name, or when you need to discover available scripts. Most skills are usable from the SKILL.md guide alone.",
  ].join('\n')
}
