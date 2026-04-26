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
    'Ask the user — LAST RESORT only.',
    '',
    'Pre-check (ALL must hold):',
    '1. 2+ plausible interpretations → INCOMPATIBLE downstream work.',
    '2. Guessing wrong costs >5min or produces a rejectable deliverable.',
    '3. Cannot infer from conversation / roster / DB / artifacts.',
    '4. You did NOT ask_user in the previous turn (never chain).',
    '',
    'NOT reasons (proceed with assumption instead):',
    '- Greetings, small talk, acknowledgements.',
    "- Tone / register — always the formal register of the user's language.",
    "- Deliverable language — default to the user's conversation language.",
    '- Default formats — Markdown prose, PDF reports, A4 print, 존댓말 for Korean.',
    '- Enumerable branching — state your interpretation and proceed ("X 로 해석했습니다; Y 를 원하셨다면 알려주세요").',
    "- A subordinate's assumption — you verify and correct, don't ask the user.",
    '',
    'Form: bundle ALL questions into ONE call. 2-4 options each; recommended first with " (Recommended)" suffix.',
  ].join('\n')
}

export function delegateToGuidance(): string {
  return [
    'Delegate to ONE direct subordinate. Fan-out: call `delegate_to` MULTIPLE times in the SAME response — adjacent calls run concurrently. Use only when subtasks are truly independent.',
    '',
    '## `mode`',
    '- `research` — worker investigates, reports prose. Files private.',
    '- `verify`   — worker checks work, reports verdict. Files private.',
    '- `produce`  — worker creates THE user-facing file (one file per call). Only after synthesis.',
    '',
    'Research/verify files cannot leak to the user — engine-enforced.',
    '',
    '## `task` must contain',
    '- **Goal** — outcome in one sentence.',
    '- **Context** — domain facts the worker needs: numbers, paths, prior findings, formats. NOT orchestration meta ("you run in parallel", "result will be combined") — workers don\'t coordinate.',
    '- **Deliverable** — for research/verify: questions + format. Tight: TL;DR + table + 5-8 bullets, NOT long-form. Long sub-reports balloon downstream tokens. For produce: filename, length, structure, sections. One file per produce call.',
    '- **Scope fence** — what NOT to do. Subordinates can\'t ask_user or expand scope.',
    '',
    '## Never delegate understanding',
    'Banned: "based on findings, make the PDF", "synthesize and produce X". Synthesis is YOUR job. A produce brief carries the decisions; worker just formats.',
    '',
    'After workers return: read, verify, then reply or craft a produce brief. Never chain research → research on the same question.',
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
