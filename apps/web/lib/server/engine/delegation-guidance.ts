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
    '4. You did NOT call ask_user in the previous turn (never chain).',
    '',
    'NOT reasons (DEFAULT instead, do not ask):',
    '- Greetings, small talk, short acknowledgements.',
    "- Tone / register — ALWAYS the formal register of the user's language.",
    "- **Deliverable / document output language** — default to the user's conversation language. If the user wrote in Korean, produce Korean documents; do not ask.",
    '- Deliverable / document tone — same as register rule; always formal. Never ask "한국어(존댓말) vs 한국어(반말)".',
    '- Default formats — Markdown for prose, PDF for reports, A4 for print, 존댓말 for Korean deliverables.',
    '- Enumerable branching — just state your interpretation and proceed ("X 로 해석했습니다; Y 를 원하셨다면 알려주세요" is better than stopping).',
    "- A subordinate's stated assumption — you (not the user) verify and correct.",
    '',
    'Form: bundle ALL pending questions into ONE call. 2-4 option labels per question; put the recommended option first with " (Recommended)" suffix.',
  ].join('\n')
}

export function delegateToGuidance(): string {
  return [
    'Delegate to ONE direct subordinate. Call this tool MULTIPLE times in a single turn to fan out in parallel (engine auto-groups independent delegations).',
    '',
    '## Pick a `mode`',
    '',
    '- `research` — worker investigates and reports **findings in prose**. Any files it writes are internal scratch (hidden from user). Use for "find out X", "survey Y", "what are the options for Z".',
    '- `verify`   — worker checks someone else\'s work and reports **a verdict in prose**. Files internal. Use for "does this data hold up", "is this safe to merge".',
    '- `produce`  — worker creates **THE user-facing deliverable** (one file per produce call). Only delegate in produce mode AFTER you have synthesized the research into a concrete spec the worker can execute without re-researching.',
    '',
    "Research/verify workers CANNOT leak files to the user. Only produce workers can. This is enforced by the engine, not by the worker's discretion.",
    '',
    '## Every `task` MUST contain',
    '',
    '- **Goal** — outcome in one sentence.',
    '- **Context** — concrete facts/numbers/paths/constraints (you carry the synthesis, not the worker).',
    "- **Deliverable** — for research/verify: exact questions to answer + required format of the prose report. For produce: filename, page/length, structure, required sections. **One file per produce delegation** — if you want PDF + PPTX, that's two produce delegations with different filenames.",
    '- **Scope fence** — what NOT to do. Subordinates cannot call ask_user and must not expand scope.',
    '',
    '## Never delegate understanding',
    '',
    'Banned prompts: "based on your findings, make the PDF", "please synthesize and produce X", "decide the structure yourself". Synthesis is YOUR job. A produce-mode brief must already contain the decisions (numbers, section order, tone) the worker needs — the worker just formats and writes.',
    '',
    'After workers return: read their prose, verify, and EITHER reply to the user directly OR craft a produce-mode brief that bakes in what you learned. Never chain research → research on the same question.',
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
