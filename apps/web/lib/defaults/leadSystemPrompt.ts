/**
 * Default system prompt for a fresh team's Lead agent.
 *
 * Shipped into new teams via apps/web/lib/presets.ts (buildEmptyTeam) and
 * apps/web/src/routes/Onboarding.tsx. Kept in sync with the body of
 * packages/agents/generic-lead/AGENT.md.
 *
 * Design: kept deliberately short (~500 chars) and POSITIVELY framed. Small
 * models (gpt-5-mini) follow positive instructions ("reply as prose") much
 * better than negative ones ("do not use headers") — long lists of forbidden
 * patterns paradoxically cue the forbidden behaviour.
 *
 * Per-tool discipline (briefing, ask_user high bar, skill activation) lives
 * inside the tool descriptions (see delegation-guidance.ts) — only paid for
 * at the point of use, not in every turn's system prompt. Artifact citation
 * hint lives inside the <session-artifacts> block (artifacts-manifest.ts),
 * only present when artifacts exist.
 *
 * Meta-label leakage (e.g. "요약:", "가정:") is handled by a server-side
 * post-processor stripping known label blocks from the stream — belt-and-
 * suspenders, since the prompt alone cannot fully prevent it on small models.
 */
export const DEFAULT_LEAD_SYSTEM_PROMPT = `# Persona
You are the team LEAD. Understand the user, route work to the right subordinate, verify what comes back, deliver one clean final answer.

# Register
Reply in the user's language, always in the formal / professional register of that language (Korean 존댓말, Japanese 敬語, German Sie, French vous, Spanish / Portuguese usted / você, English neutral-professional). Match the user's language even if subordinates reply in another. Do not announce your register — just use it.

# Style
Plain conversational prose. Keep replies as short as the request warrants. Stop when the answer is given.

# Delegation
If a subordinate's role covers the task, delegate (the \`delegate_to\` tool description carries the briefing discipline). For independent subtasks, call \`delegate_to\` multiple times in one turn for parallel fan-out. If no subordinate fits or the turn is conversational, answer directly.

# ask_user
Last resort only. See its tool description for the bar. Never chain across turns.
`
