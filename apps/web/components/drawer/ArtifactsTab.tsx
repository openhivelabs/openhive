'use client'

import {
  FileArchive,
  FileCode,
  FileDoc,
  FilePdf,
  FilePpt,
  FileXls,
} from '@phosphor-icons/react'
import { useEffect, useMemo } from 'react'
import { downloadUrl } from '@/lib/api/artifacts'
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
    if (!map.has(a.sessionId)) map.set(a.sessionId, [])
    map.get(a.sessionId)!.push(a)
  }
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
}

export function ArtifactsTab() {
  const currentTeamId = useAppStore((s) => s.currentTeamId)
  const artifacts = useDrawerStore((s) => s.artifacts)
  const loadTeamArtifacts = useDrawerStore((s) => s.loadTeamArtifacts)
  const refreshTeamArtifacts = useDrawerStore((s) => s.refreshTeamArtifacts)

  useEffect(() => {
    if (!currentTeamId) return
    void loadTeamArtifacts(currentTeamId)
  }, [currentTeamId, loadTeamArtifacts])

  const teamArtifacts = useMemo(
    () => artifacts.filter((a) => a.teamId === currentTeamId),
    [artifacts, currentTeamId],
  )
  const grouped = useMemo(() => groupByRun(teamArtifacts), [teamArtifacts])

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-neutral-200 flex items-center justify-between">
        <div className="text-[15px] text-neutral-500">
          {teamArtifacts.length} artifact{teamArtifacts.length === 1 ? '' : 's'} across{' '}
          {grouped.length} session{grouped.length === 1 ? '' : 's'}
        </div>
        <button
          type="button"
          onClick={() => currentTeamId && void refreshTeamArtifacts(currentTeamId)}
          className="text-[13px] text-neutral-500 hover:text-neutral-800"
        >
          ↻
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {teamArtifacts.length === 0 && (
          <div className="text-[15px] text-neutral-400 text-center py-10">
            No artifacts yet for this team.
          </div>
        )}
        {grouped.map(([sessionId, items]) => (
          <div key={sessionId}>
            <div className="px-1 pb-1.5 text-[14px] font-mono text-neutral-400 uppercase">
              {sessionId}
            </div>
            <div className="space-y-1">
              {items.map((a) => {
                const Icon = iconFor(a.mime)
                return (
                  <a
                    key={a.id}
                    href={downloadUrl(a.id)}
                    download={a.filename.split('/').pop()}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded border border-neutral-200 bg-white hover:bg-neutral-50 text-left"
                  >
                    <div className="w-8 h-8 rounded-sm bg-neutral-100 flex items-center justify-center">
                      <Icon className="w-4 h-4 text-neutral-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-medium text-neutral-900 truncate">
                        {a.filename}
                      </div>
                      <div className="text-[15px] text-neutral-500">
                        {formatWhen(a.createdAt)} · {a.mime.split('/').pop()}
                      </div>
                    </div>
                  </a>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
