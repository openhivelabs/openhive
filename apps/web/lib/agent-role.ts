/** Normalize an agent role/name for display + storage. Uppercases the first
 *  ASCII letter; leaves non-Latin scripts (Korean, Japanese, …) untouched.
 *  Applied at every write site — manual create, AI generate response, edit
 *  save — so roles are consistent regardless of how they entered the system. */
export function normalizeAgentRole(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const first = trimmed[0]!
  if (first >= 'a' && first <= 'z') {
    return first.toUpperCase() + trimmed.slice(1)
  }
  return trimmed
}
