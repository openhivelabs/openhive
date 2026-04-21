'use client'

import { useEffect } from 'react'

/** Attach a document-level ESC listener that fires onClose while `active` is truthy. */
export function useEscapeClose(active: unknown, onClose: () => void) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, onClose])
}
