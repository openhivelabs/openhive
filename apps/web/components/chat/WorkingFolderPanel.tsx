import { FolderOpen } from '@phosphor-icons/react'
import { useT } from '@/lib/i18n'

/**
 * Right panel on the Chat page. Shows files the agents touched during the
 * active conversation (artifacts, uploaded attachments, read-through files).
 * Live-tracking lands with the attachment + artifact pipeline — this is the
 * scaffold UI for that endpoint.
 */
export function WorkingFolderPanel() {
  const t = useT()
  return (
    <aside className="w-[280px] shrink-0 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex flex-col">
      <header className="h-[46px] shrink-0 px-3 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800">
        <FolderOpen className="w-4 h-4 text-neutral-500" />
        <span className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">
          {t('chatPage.workingFolder')}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 p-4 text-center">
          <FolderOpen className="w-6 h-6 mx-auto text-neutral-300 dark:text-neutral-700 mb-2" />
          <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            {t('chatPage.emptyFolder')}
          </div>
          <p className="text-[12px] text-neutral-500 mt-1 leading-relaxed">
            {t('chatPage.folderHint')}
          </p>
        </div>
      </div>
    </aside>
  )
}
