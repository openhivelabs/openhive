/**
 * Utility skills auto-attached to freshly-created agents (Lead from
 * buildEmptyTeam / buildCompanySpec, Member from CreateAgentModal default).
 *
 * Without this, an agent's `skills: []` is empty and the engine registers
 * zero skill tools — so requests like "pdf 만들어줘" have no way to produce
 * a file. The sub-agent's choice becomes either hallucinate URIs (now
 * blocked by filterRealArtifactPaths) or honestly report "no skill
 * connected" (current behaviour). Neither is what the user wants when the
 * skills are sitting right there in packages/skills/.
 *
 * These 6 cover the common "here's a document / image / web page"
 * workflows users expect out of the box:
 *   - pdf     : build / edit PDF reports (agent-format)
 *   - docx    : build / edit Word docs (agent-format)
 *   - pptx    : build / edit PowerPoint decks (agent-format)
 *   - image-gen : HTML → PNG renderer (typed)
 *   - text-file : write UTF-8 text / markdown / CSV (typed)
 *   - web-fetch : fetch URL → cleaned markdown (typed)
 *   - web-search: search the web → 10 {title, url, snippet} (typed)
 *
 * Users can remove any of these per-agent via the canvas NodeEditor.
 * Teams that want stricter control can set team.allowed_skills to
 * narrow the whitelist.
 */
export const DEFAULT_AGENT_SKILLS: readonly string[] = [
  'pdf',
  'docx',
  'pptx',
  'image-gen',
  'text-file',
  'web-fetch',
  'web-search',
]
