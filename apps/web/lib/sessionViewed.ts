/** Shared "seen session" set — stored in localStorage so TasksTab (list) and
 *  RunDetailPage (chat) agree on what's been read. Back-end has no viewed flag
 *  yet; this is UI-only. */

const LS_VIEWED_KEY = 'openhive.sessions.viewed'

export function loadViewedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_VIEWED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? new Set(arr.filter((x) => typeof x === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

export function saveViewedIds(ids: Set<string>) {
  try {
    localStorage.setItem(LS_VIEWED_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    /* ignore */
  }
}

export function addViewedId(id: string) {
  const ids = loadViewedIds()
  if (ids.has(id)) return
  ids.add(id)
  saveViewedIds(ids)
}
