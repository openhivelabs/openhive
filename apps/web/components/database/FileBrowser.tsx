'use client'

import {
  DotsThree,
  DownloadSimple,
  File as FileIcon,
  FileCode,
  FileCsv,
  FileDoc,
  FileImage,
  FilePdf,
  FilePpt,
  FileText,
  FileXls,
  FolderOpen,
  MagnifyingGlass,
  Rows,
  SquaresFour,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  downloadUrl,
  fetchArtifactsDetailed,
  type ArtifactDetailed,
} from '@/lib/api/artifacts'
import { MOCK_ARTIFACTS, MOCK_SESSIONS } from '@/lib/mockRecords'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'

type ViewMode = 'grid' | 'list'

function formatBytes(n: number | null): string {
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function relTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

function extOf(name: string): string {
  const m = name.match(/\.([^.]+)$/)
  return m ? m[1]!.toLowerCase() : ''
}

interface FileVisual {
  Icon: typeof FileIcon
  bg: string
  fg: string
  label: string
}

function fileVisual(name: string): FileVisual {
  const e = extOf(name)
  const map: Record<string, FileVisual> = {
    pdf: { Icon: FilePdf, bg: 'bg-rose-50 dark:bg-rose-950/30', fg: 'text-rose-600 dark:text-rose-400', label: 'PDF' },
    doc: { Icon: FileDoc, bg: 'bg-blue-50 dark:bg-blue-950/30', fg: 'text-blue-600 dark:text-blue-400', label: 'DOC' },
    docx: { Icon: FileDoc, bg: 'bg-blue-50 dark:bg-blue-950/30', fg: 'text-blue-600 dark:text-blue-400', label: 'DOCX' },
    ppt: { Icon: FilePpt, bg: 'bg-orange-50 dark:bg-orange-950/30', fg: 'text-orange-600 dark:text-orange-400', label: 'PPT' },
    pptx: { Icon: FilePpt, bg: 'bg-orange-50 dark:bg-orange-950/30', fg: 'text-orange-600 dark:text-orange-400', label: 'PPTX' },
    xls: { Icon: FileXls, bg: 'bg-emerald-50 dark:bg-emerald-950/30', fg: 'text-emerald-600 dark:text-emerald-400', label: 'XLS' },
    xlsx: { Icon: FileXls, bg: 'bg-emerald-50 dark:bg-emerald-950/30', fg: 'text-emerald-600 dark:text-emerald-400', label: 'XLSX' },
    csv: { Icon: FileCsv, bg: 'bg-emerald-50 dark:bg-emerald-950/30', fg: 'text-emerald-600 dark:text-emerald-400', label: 'CSV' },
    tsv: { Icon: FileCsv, bg: 'bg-emerald-50 dark:bg-emerald-950/30', fg: 'text-emerald-600 dark:text-emerald-400', label: 'TSV' },
    md: { Icon: FileText, bg: 'bg-neutral-100 dark:bg-neutral-900', fg: 'text-neutral-600 dark:text-neutral-400', label: 'MD' },
    txt: { Icon: FileText, bg: 'bg-neutral-100 dark:bg-neutral-900', fg: 'text-neutral-600 dark:text-neutral-400', label: 'TXT' },
    json: { Icon: FileCode, bg: 'bg-amber-50 dark:bg-amber-950/30', fg: 'text-amber-600 dark:text-amber-400', label: 'JSON' },
    yaml: { Icon: FileCode, bg: 'bg-amber-50 dark:bg-amber-950/30', fg: 'text-amber-600 dark:text-amber-400', label: 'YAML' },
    yml: { Icon: FileCode, bg: 'bg-amber-50 dark:bg-amber-950/30', fg: 'text-amber-600 dark:text-amber-400', label: 'YML' },
    png: { Icon: FileImage, bg: 'bg-violet-50 dark:bg-violet-950/30', fg: 'text-violet-600 dark:text-violet-400', label: 'PNG' },
    jpg: { Icon: FileImage, bg: 'bg-violet-50 dark:bg-violet-950/30', fg: 'text-violet-600 dark:text-violet-400', label: 'JPG' },
    jpeg: { Icon: FileImage, bg: 'bg-violet-50 dark:bg-violet-950/30', fg: 'text-violet-600 dark:text-violet-400', label: 'JPEG' },
    gif: { Icon: FileImage, bg: 'bg-violet-50 dark:bg-violet-950/30', fg: 'text-violet-600 dark:text-violet-400', label: 'GIF' },
    webp: { Icon: FileImage, bg: 'bg-violet-50 dark:bg-violet-950/30', fg: 'text-violet-600 dark:text-violet-400', label: 'WEBP' },
  }
  return (
    map[e] ?? {
      Icon: FileIcon,
      bg: 'bg-neutral-100 dark:bg-neutral-900',
      fg: 'text-neutral-500',
      label: e.toUpperCase() || 'FILE',
    }
  )
}

function dayBucket(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return '오늘'
  if (sameDay(d, yesterday)) return '어제'
  const week = 7 * 86400_000
  if (Date.now() - ms < week) return '이번 주'
  if (Date.now() - ms < 4 * week) return '이번 달'
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}월`
    : `${d.getFullYear()}년`
}

export function FileBrowser() {
  const team = useCurrentTeam()
  const teamId = useAppStore((s) => s.currentTeamId)
  const companySlug = useAppStore((s) => {
    const company = s.companies.find((c) => c.id === s.currentCompanyId)
    return company?.slug ?? null
  })
  const [artifacts, setArtifacts] = useState<ArtifactDetailed[] | null>(null)
  const [selected, setSelected] = useState<ArtifactDetailed | null>(null)
  const [view, setView] = useState<ViewMode>('grid')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isMock, setIsMock] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    if (!teamId) {
      setArtifacts(MOCK_ARTIFACTS)
      setIsMock(true)
      setLoading(false)
      return
    }
    try {
      const real = await fetchArtifactsDetailed(teamId)
      if (real.length < MOCK_ARTIFACTS.length) {
        // Design-preview mode: show mock while there aren't many real
        // artifacts yet. As soon as the real list outgrows the mock, we
        // flip to real automatically.
        setArtifacts(MOCK_ARTIFACTS)
        setIsMock(true)
      } else {
        setArtifacts(real)
        setIsMock(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setArtifacts(MOCK_ARTIFACTS)
      setIsMock(true)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void load()
  }, [load])

  // When the artifact list changes, make sure the currently-selected item
  // still exists (switching teams, refresh, etc.)
  useEffect(() => {
    if (!selected || !artifacts) return
    if (!artifacts.some((a) => a.id === selected.id)) setSelected(null)
  }, [artifacts, selected])

  const filtered = useMemo(() => {
    if (!artifacts) return []
    const q = search.trim().toLowerCase()
    if (!q) return artifacts
    return artifacts.filter(
      (a) =>
        a.filename.toLowerCase().includes(q) ||
        (a.skillName ?? '').toLowerCase().includes(q),
    )
  }, [artifacts, search])

  const buckets = useMemo(() => {
    const out = new Map<string, ArtifactDetailed[]>()
    for (const a of filtered) {
      const key = dayBucket(a.createdAt)
      const arr = out.get(key) ?? []
      arr.push(a)
      out.set(key, arr)
    }
    return Array.from(out.entries())
  }, [filtered])

  const sessionLookup = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of MOCK_SESSIONS) m.set(s.id, s.title)
    return m
  }, [])

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-950">
      {/* Toolbar */}
      <header className="shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-6 py-2.5">
        <div className="flex items-center gap-3">
          <div className="relative w-[320px] max-w-full">
            <MagnifyingGlass className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="파일명 또는 스킬 검색…"
              className="w-full h-8 pl-8 pr-2 rounded-md bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-[13px] placeholder:text-neutral-400 focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-600"
            />
          </div>
          <div className="flex-1" />
          <span className="text-[11.5px] font-mono tabular-nums text-neutral-400">
            {filtered.length} files
          </span>
          <div className="inline-flex h-8 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-0.5">
            <button
              type="button"
              onClick={() => setView('grid')}
              className={clsx(
                'h-7 w-7 rounded flex items-center justify-center cursor-pointer',
                view === 'grid'
                  ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-900',
              )}
              aria-label="그리드 보기"
              title="그리드 보기"
            >
              <SquaresFour className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              className={clsx(
                'h-7 w-7 rounded flex items-center justify-center cursor-pointer',
                view === 'list'
                  ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-900',
              )}
              aria-label="리스트 보기"
              title="리스트 보기"
            >
              <Rows className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-3 rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 text-[12px] px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          {filtered.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[13px] text-neutral-400">
              <div className="text-center">
                <FolderOpen className="w-10 h-10 mx-auto text-neutral-300 dark:text-neutral-700 mb-2" />
                {loading
                  ? '로딩 중…'
                  : search.trim()
                    ? '검색 결과가 없습니다'
                    : '아직 생성된 아티팩트가 없습니다'}
              </div>
            </div>
          ) : view === 'grid' ? (
            <GridView
              buckets={buckets}
              selected={selected}
              onSelect={setSelected}
              sessionLookup={sessionLookup}
            />
          ) : (
            <ListView
              buckets={buckets}
              selected={selected}
              onSelect={setSelected}
              sessionLookup={sessionLookup}
            />
          )}
        </div>

        {selected && (
          <aside className="w-[340px] shrink-0 border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950 overflow-y-auto">
            <Preview
              artifact={selected}
              sessionTitle={sessionLookup.get(selected.sessionId) ?? null}
              companySlug={companySlug}
              teamSlug={team?.slug ?? null}
              isMock={isMock}
              onClose={() => setSelected(null)}
            />
          </aside>
        )}
      </div>
    </div>
  )
}

function GridView({
  buckets,
  selected,
  onSelect,
  sessionLookup,
}: {
  buckets: [string, ArtifactDetailed[]][]
  selected: ArtifactDetailed | null
  onSelect: (a: ArtifactDetailed) => void
  sessionLookup: Map<string, string>
}) {
  return (
    <div className="px-6 py-5 space-y-5">
      {buckets.map(([label, items]) => (
        <section key={label}>
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-neutral-400 mb-2">
            {label}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
            {items.map((a) => {
              const v = fileVisual(a.filename)
              const active = selected?.id === a.id
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onSelect(a)}
                  className={clsx(
                    'group text-left rounded-xl border transition-all px-3 py-3 cursor-pointer',
                    active
                      ? 'border-neutral-900 dark:border-neutral-100 bg-white dark:bg-neutral-900 shadow-[0_2px_8px_rgba(0,0,0,0.06)]'
                      : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-neutral-300 dark:hover:border-neutral-700 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={clsx(
                        'w-10 h-12 rounded-md flex items-center justify-center shrink-0',
                        v.bg,
                      )}
                    >
                      <v.Icon className={clsx('w-5 h-5', v.fg)} weight="duotone" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium text-neutral-900 dark:text-neutral-100 leading-tight break-words line-clamp-2">
                        {a.filename}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-neutral-400 font-mono">
                        <span>{formatBytes(a.size)}</span>
                        <span>·</span>
                        <span>{relTime(a.createdAt)}</span>
                      </div>
                      <div className="mt-1.5 text-[11px] text-neutral-500 truncate">
                        {sessionLookup.get(a.sessionId) ?? a.sessionId}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function ListView({
  buckets,
  selected,
  onSelect,
  sessionLookup,
}: {
  buckets: [string, ArtifactDetailed[]][]
  selected: ArtifactDetailed | null
  onSelect: (a: ArtifactDetailed) => void
  sessionLookup: Map<string, string>
}) {
  return (
    <div className="px-2 py-2">
      <div className="grid grid-cols-[1fr_200px_auto_120px] gap-x-4 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400 border-b border-neutral-200 dark:border-neutral-800">
        <span>이름</span>
        <span>세션</span>
        <span className="text-right">크기</span>
        <span>생성</span>
      </div>
      {buckets.map(([label, items]) => (
        <div key={label}>
          <div className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
            {label}
          </div>
          {items.map((a) => {
            const v = fileVisual(a.filename)
            const active = selected?.id === a.id
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onSelect(a)}
                className={clsx(
                  'w-full grid grid-cols-[1fr_200px_auto_120px] gap-x-4 px-4 py-2 items-center text-left rounded-md cursor-pointer transition-colors',
                  active
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60',
                )}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={clsx(
                      'w-6 h-6 rounded flex items-center justify-center shrink-0',
                      v.bg,
                    )}
                  >
                    <v.Icon className={clsx('w-3.5 h-3.5', v.fg)} weight="duotone" />
                  </span>
                  <span className="text-[13px] text-neutral-900 dark:text-neutral-100 truncate">
                    {a.filename}
                  </span>
                </span>
                <span className="text-[11.5px] text-neutral-600 dark:text-neutral-400 truncate">
                  {sessionLookup.get(a.sessionId) ?? a.sessionId}
                </span>
                <span className="text-[11.5px] font-mono tabular-nums text-neutral-500 text-right whitespace-nowrap">
                  {formatBytes(a.size)}
                </span>
                <span className="text-[11.5px] text-neutral-500 whitespace-nowrap">
                  {relTime(a.createdAt)}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function Preview({
  artifact,
  sessionTitle,
  companySlug,
  teamSlug,
  isMock,
  onClose,
}: {
  artifact: ArtifactDetailed
  sessionTitle: string | null
  companySlug: string | null
  teamSlug: string | null
  isMock: boolean
  onClose: () => void
}) {
  const v = fileVisual(artifact.filename)
  const sessionHref =
    !isMock && companySlug && teamSlug
      ? `/${companySlug}/${teamSlug}/s/${artifact.sessionId}`
      : null

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-5 pb-4 border-b border-neutral-200 dark:border-neutral-800">
        <div
          className={clsx(
            'w-14 h-16 rounded-lg flex items-center justify-center mb-3',
            v.bg,
          )}
        >
          <v.Icon className={clsx('w-7 h-7', v.fg)} weight="duotone" />
        </div>
        <div className="text-[14.5px] font-semibold text-neutral-900 dark:text-neutral-100 break-words leading-snug">
          {artifact.filename}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-neutral-500 font-mono">
          <span
            className={clsx(
              'inline-flex items-center h-4 px-1 rounded text-[10px] font-semibold',
              v.bg,
              v.fg,
            )}
          >
            {v.label}
          </span>
          <span>·</span>
          <span>{formatBytes(artifact.size)}</span>
        </div>
        <div className="mt-3 flex gap-1.5">
          <a
            href={isMock ? undefined : downloadUrl(artifact.id)}
            download={!isMock}
            aria-disabled={isMock}
            className={clsx(
              'h-7 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5',
              isMock
                ? 'bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed'
                : 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:opacity-90 cursor-pointer',
            )}
          >
            <DownloadSimple className="w-3.5 h-3.5" />
            다운로드
          </a>
          <button
            type="button"
            className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center justify-center cursor-pointer"
          >
            <DotsThree className="w-4 h-4" weight="bold" />
          </button>
        </div>
      </div>

      <dl className="px-5 py-4 text-[12px] space-y-2.5">
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">생성 일시</dt>
          <dd className="text-neutral-700 dark:text-neutral-300">
            {new Date(artifact.createdAt).toLocaleString()}
          </dd>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">크기</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 font-mono">
            {formatBytes(artifact.size)}
          </dd>
        </div>
        {artifact.mime && (
          <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
            <dt className="text-neutral-400">MIME</dt>
            <dd className="text-neutral-700 dark:text-neutral-300 font-mono break-all">
              {artifact.mime}
            </dd>
          </div>
        )}
        {artifact.skillName && (
          <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
            <dt className="text-neutral-400">스킬</dt>
            <dd className="text-neutral-700 dark:text-neutral-300 font-mono">
              {artifact.skillName}
            </dd>
          </div>
        )}
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">세션</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 min-w-0">
            {sessionHref ? (
              <Link
                href={sessionHref}
                className="text-blue-600 dark:text-blue-400 hover:underline break-words"
              >
                {sessionTitle ?? artifact.sessionId}
              </Link>
            ) : (
              <span className="break-words">
                {sessionTitle ?? artifact.sessionId}
              </span>
            )}
          </dd>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">경로</dt>
          <dd className="text-neutral-500 dark:text-neutral-500 font-mono text-[11px] break-all">
            ~/.openhive/{artifact.path}
          </dd>
        </div>
      </dl>

      <div className="px-5 pb-5">
        <button
          type="button"
          onClick={onClose}
          className="w-full h-7 rounded-md border border-neutral-200 dark:border-neutral-800 text-[12px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
        >
          닫기
        </button>
      </div>
    </div>
  )
}
