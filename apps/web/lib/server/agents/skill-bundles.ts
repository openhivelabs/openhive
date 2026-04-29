/**
 * Role-based skill bundles + coupled-skill rules.
 *
 * Replaces the old "declared-or-fallback-to-all" resolution model. The previous
 * design treated `skills: []` on a persona as "give the LLM every bundled skill
 * (legacy back-compat)" but treated `skills: [pdf, docx]` as "ONLY those" —
 * which silently opted Members out of essentials like web-search whenever the
 * user listed a few file-type skills. Two real sessions burned the entire
 * 24-round budget web-fetching duckduckgo HTML pages because of this.
 *
 * The new model is purely additive:
 *
 *   effectiveSkills(role) =
 *     roleDefaults(role)            ← essentials every agent of this role gets
 *     ∪ persona.tools.skills        ← what the persona file declared
 *     ∪ node.skills                 ← what the team yaml declared on the node
 *     ∪ bundledSkills               ← filesystem scan of packages/skills/ +
 *                                     ~/.openhive/skills/ (source of truth)
 *     | apply COUPLED_SKILLS rule   ← e.g. web-fetch always pulls in web-search
 *     − team.disabled_skills        ← explicit team-level denylist
 *
 * Filesystem-as-source-of-truth: a new SKILL.md directory is visible to every
 * agent with zero hardcoded-array edits. Teams that need to forbid a skill
 * use `disabled_skills`. The legacy `allowed_skills` whitelist field is no
 * longer enforced (kept for round-trip compatibility, ignored at boot).
 */

/** A research worker should always be able to search AND fetch. Coupled below. */
const RESEARCH_BUNDLE = ['web-search', 'web-fetch'] as const

/** Document-authoring fileformats. */
const DOC_AUTHORING_BUNDLE = ['pdf', 'docx', 'pptx', 'text-file'] as const

/** Visual asset generation. */
const MEDIA_BUNDLE = ['image-gen'] as const

/** Plain text only — for agents that just need to drop a note on disk. */
const BASIC_FILES_BUNDLE = ['text-file'] as const

/**
 * Coupled-skill groups. If ANY skill in a group is present after union, ALL
 * are added. The canonical case is `web-fetch` → `web-search`: a model that
 * can fetch URLs but can't search will guess (or worse, fetch search-engine
 * HTML pages, exactly the bug this redesign exists to fix). Encode the
 * coupling in one place so future personas can't split them again by accident.
 */
export const COUPLED_SKILL_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['web-fetch', 'web-search'],
]

/** Map from normalised role → default skill bundle. Roles arrive in arbitrary
 *  case ("Lead", "lead", "리드"); we lowercase + strip non-alphanumerics and
 *  match against the keys below. Unknown roles get an empty default — that's
 *  intentional, the team yaml / persona must opt in for unusual roles. */
const ROLE_BUNDLES: Record<string, readonly string[]> = {
  // Orchestrator: needs research to verify subordinate output and to handle
  // direct user questions without delegation. No file-authoring by default
  // (that's what subordinates are for).
  lead: RESEARCH_BUNDLE,

  // Pure research roles.
  researcher: RESEARCH_BUNDLE,
  researcherlatest: RESEARCH_BUNDLE,
  verifier: RESEARCH_BUNDLE,
  researchverifier: RESEARCH_BUNDLE,
  reviewer: RESEARCH_BUNDLE,
  strictreviewer: RESEARCH_BUNDLE,

  // Generalist worker: research + author + media. The previous bug came from
  // a Member persona declaring [pdf, docx, pptx, image-gen, text-file,
  // web-fetch] and accidentally losing web-search; the role default now
  // guarantees web-search is always present for Members.
  member: [
    ...RESEARCH_BUNDLE,
    ...DOC_AUTHORING_BUNDLE,
    ...MEDIA_BUNDLE,
  ],
  worker: [
    ...RESEARCH_BUNDLE,
    ...DOC_AUTHORING_BUNDLE,
    ...MEDIA_BUNDLE,
  ],

  // Producer roles: author files + research for fact-checking what they write.
  presentationdesigner: [...RESEARCH_BUNDLE, ...DOC_AUTHORING_BUNDLE],
  presentationagent: [...RESEARCH_BUNDLE, ...DOC_AUTHORING_BUNDLE],
  reportwriter: [...RESEARCH_BUNDLE, ...DOC_AUTHORING_BUNDLE],
  writer: [...RESEARCH_BUNDLE, ...DOC_AUTHORING_BUNDLE],
  designer: [...RESEARCH_BUNDLE, ...DOC_AUTHORING_BUNDLE],
}

function normaliseRole(role: string): string {
  return (role ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Look up a role's default skill bundle. Returns [] for roles we don't have
 *  an opinion about — those agents must declare their skills explicitly. */
export function roleDefaultSkills(role: string): readonly string[] {
  return ROLE_BUNDLES[normaliseRole(role)] ?? []
}

/** Apply coupled-skill rules: if any member of a group is present, add the
 *  whole group. Returns a new array preserving insertion order; coupled
 *  partners are appended at the end (so they don't disrupt explicit ordering). */
function applyCoupling(skills: string[]): string[] {
  const present = new Set(skills)
  const out = [...skills]
  for (const group of COUPLED_SKILL_GROUPS) {
    const anyPresent = group.some((s) => present.has(s))
    if (!anyPresent) continue
    for (const s of group) {
      if (!present.has(s)) {
        out.push(s)
        present.add(s)
      }
    }
  }
  return out
}

interface ResolveSkillsOpts {
  role: string
  /** Skills declared on the team-yaml node (`AgentSpec.skills`). */
  nodeSkills?: readonly string[] | null
  /** Skills declared in the persona file (`persona.tools.skills`). */
  personaSkills?: readonly string[] | null
  /**
   * Filesystem-discovered skill names (from `listAllSkillNames()`). When set,
   * every bundled / user-installed skill is part of the candidate pool — this
   * is how new SKILL.md directories become visible to the LLM with zero
   * hardcoded list maintenance. Empty/missing falls back to declared-only.
   */
  bundledSkills?: readonly string[] | null
  /**
   * Team-level explicit denylist (TeamSpec.disabled_skills). Anything listed
   * is removed from the final set. Empty/missing = nothing removed.
   */
  disabledSkills?: readonly string[] | null
}

/**
 * Compute an agent's effective skill set. Pure function — no I/O, no state.
 * Order of operations:
 *   1. Union: roleDefaults ∪ persona.skills ∪ node.skills ∪ bundled
 *      (de-duplicated, first occurrence wins for ordering).
 *   2. Coupling: any present member of a coupled group pulls in the rest.
 *   3. Denylist subtraction: drop anything in team.disabled_skills.
 *
 * Filesystem is the source of truth for what skills *exist*. Role bundles +
 * coupling rules remain as semantic guarantees (essentials, safety pairs).
 * Denial is the only narrowing mechanism — explicit opt-in by the team.
 */
export function resolveEffectiveSkills(opts: ResolveSkillsOpts): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  const push = (s: string) => {
    if (!s || seen.has(s)) return
    seen.add(s)
    merged.push(s)
  }
  for (const s of roleDefaultSkills(opts.role)) push(s)
  for (const s of opts.personaSkills ?? []) push(s)
  for (const s of opts.nodeSkills ?? []) push(s)
  for (const s of opts.bundledSkills ?? []) push(s)

  const coupled = applyCoupling(merged)

  const disabled = opts.disabledSkills ?? []
  if (disabled.length === 0) return coupled
  const disabledSet = new Set(disabled)
  return coupled.filter((s) => !disabledSet.has(s))
}
