/** Load every .md file inside a persona bundle (for the edit tree view). */
export async function getPersonaFiles(personaPath: string): Promise<Record<string, string>> {
  const res = await fetch(
    `/api/agents/persona/files?persona_path=${encodeURIComponent(personaPath)}`,
  )
  if (!res.ok) throw new Error(`GET persona/files ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { files?: Record<string, string> }
  return body.files ?? {}
}

/** Rewrite the full .md file set of an existing persona bundle (add / delete / edit). */
export async function savePersonaFiles(
  personaPath: string,
  files: Record<string, string>,
): Promise<void> {
  const res = await fetch('/api/agents/persona/files', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona_path: personaPath, files }),
  })
  if (!res.ok) throw new Error(`PUT persona/files ${res.status}: ${await res.text()}`)
}
