import { CircleNotch, Sparkle, X } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useT } from '@/lib/i18n'
import { type GenerationJob, useAgentGenerationStore } from '@/lib/stores/useAgentGenerationStore'

interface ChipProps {
  job: GenerationJob
  onDismiss: () => void
  onRetry: () => void
}

function Chip({ job, onDismiss, onRetry }: ChipProps) {
  const t = useT()
  const isError = Boolean(job.error)
  const preview =
    job.description.length > 64 ? `${job.description.slice(0, 64)}…` : job.description

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-[320px] max-w-[92vw] rounded-md border border-neutral-200 bg-white shadow-lg px-3 py-2 flex items-start gap-2"
    >
      {isError ? (
        <Sparkle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
      ) : (
        <CircleNotch className="w-4 h-4 text-neutral-500 shrink-0 mt-0.5 animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-neutral-800">
          {isError ? t('canvas.askAiFailed') : t('canvas.askAiGenerating')}
        </div>
        <div
          className="text-[11px] text-neutral-500 truncate"
          title={isError ? job.error : job.description}
        >
          {isError ? job.error : preview}
        </div>
        {isError && (
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="text-[11px] font-medium text-neutral-700 hover:text-neutral-900 underline-offset-2 hover:underline"
            >
              {t('canvas.askAiRetry')}
            </button>
          </div>
        )}
      </div>
      {/* X only while errored — a pending job runs to completion no matter what. */}
      {isError && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('canvas.close')}
          className="p-0.5 rounded-sm hover:bg-neutral-100 text-neutral-500 shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

/** Global floating status stack for async AI agent generation. Mounted at
 *  app shell level so it survives route navigation. */
export function AgentGenerationChipStack() {
  const jobs = useAgentGenerationStore((s) => s.jobs)
  const dismiss = useAgentGenerationStore((s) => s.dismiss)
  const retry = useAgentGenerationStore((s) => s.retry)
  const hydrate = useAgentGenerationStore((s) => s.hydrate)
  useEffect(() => {
    hydrate()
  }, [hydrate])
  if (jobs.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {jobs.map((job) => (
        <Chip
          key={job.id}
          job={job}
          onDismiss={() => dismiss(job.id)}
          onRetry={() => retry(job.id)}
        />
      ))}
    </div>
  )
}
