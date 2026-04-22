import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'

/**
 * Root shell for the Vite/React Router SPA port of OpenHive.
 *
 * The original Next.js `app/layout.tsx` only set <html>/<body> plus metadata.
 * In the SPA, index.html already owns the document shell — this component just
 * renders the matched child route and handles document-level side effects
 * (title) that Next previously handled via metadata.
 */
export function Root() {
  useEffect(() => {
    document.title = 'OpenHive'
  }, [])

  return <Outlet />
}
