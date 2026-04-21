'use client'

import { ChatCircleText, Plus } from '@phosphor-icons/react'
import { useT } from '@/lib/i18n'

/**
 * Left panel on the Chat page. Lists prior conversations for the current team.
 * Session-history persistence lands in a later pass — for now this is a scaffold
 * with an empty state.
 */
export function ChatHistoryPanel() {
  const t = useT()
  return (
    <aside className="w-[240px] shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
      <header className="h-[46px] shrink-0 px-3 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800">
        <ChatCircleText className="w-4 h-4 text-neutral-500" />
        <span className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('chatPage.history')}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t('chatPage.newChat')}
          title={t('chatPage.newChat')}
          className="w-7 h-7 flex items-center justify-center rounded-sm text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="text-[13px] text-neutral-400 text-center py-8">
          {t('chatPage.emptyHistory')}
        </div>
      </div>
    </aside>
  )
}
