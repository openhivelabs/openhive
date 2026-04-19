'use client'

import { useEffect } from 'react'
import { useAppStore } from './useAppStore'

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function useKeyboardShortcuts() {
  const { setMode, toggleSidebar, toggleDrawer } = useAppStore()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key.toLowerCase()) {
        case 'd':
          setMode('design')
          break
        case 'r':
          setMode('run')
          break
        case '[':
          toggleSidebar()
          break
        case ']':
          toggleDrawer()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setMode, toggleSidebar, toggleDrawer])
}
