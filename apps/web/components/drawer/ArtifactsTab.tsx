'use client'

import {
  FileArchive,
  FileCode,
  FileDoc,
  FilePdf,
  FilePpt,
  FileXls,
} from '@phosphor-icons/react'
import { useMemo } from 'react'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useDrawerStore } from '@/lib/stores/useDrawerStore'
import type { Artifact } from '@/lib/types'

function iconFor(mime: string) {
  if (mime.includes('pdf')) return FilePdf
  if (mime.includes('presentation') || mime.includes('powerpoint')) return FilePpt
  if (mime.includes('word') || mime.includes('officedocument.wordprocessing')) return FileDoc
  if (mime.includes('sheet') || mime.includes('excel')) return FileXls
  if (mime.includes('markdown') || mime.includes('text/')) return FileCode
  return FileArchive
}

function formatWhen(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function groupByRun(artifacts: Artifact[]) {
  const map = new Map<string, Artifact[]>()
  for (const a of artifacts) {
    if (!map.has(a.runId)) map.set(a.runId, [])
    map.get(a.runId)!.push(a)
  }
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
}

export function ArtifactsTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const artifacts = useDrawerStore((s) => s.artifacts)

  const teamArtifacts = useMemo(
    () => artifacts.filter((a) => a.teamId === currentTeamId),
    [artifacts, currentTeamId],
  )
  const grouped = useMemo(() => groupByRun(teamArtifacts), [teamArtifacts])

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-neutral-200">
        <div className="text-xs text-neutral-500">
          {teamArtifacts.length} artifact{teamArtifacts.length === 1 ? '' : 's'} across{' '}
          {grouped.length} run{grouped.length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {teamArtifacts.length === 0 && (
          <div className="text-sm text-neutral-400 text-center py-10">
            No artifacts yet for this team.
          </div>
        )}
        {grouped.map(([runId, items]) => (
          <div key={runId}>
            <div className="px-1 pb-1.5 text-[11px] font-mono text-neutral-400 uppercase">
              {runId}
            </div>
            <div className="space-y-1">
              {items.map((a) => {
                const Icon = iconFor(a.mime)
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() =>
                      alert(`Preview coming in Phase 6.\n\nPath: ${a.path}`)
                    }
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 text-left"
                  >
                    <div className="w-8 h-8 rounded-md bg-neutral-100 flex items-center justify-center">
                      <Icon className="w-4 h-4 text-neutral-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-neutral-900 truncate">
                        {a.filename}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {formatWhen(a.createdAt)} · {a.mime.split('/').pop()}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
