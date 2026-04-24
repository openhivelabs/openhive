import {
  Copy,
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
  PushPin,
  PushPinSlash,
  Rows,
  SquaresFour,
  X,
} from '@phosphor-icons/react'
import { clsx } from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  downloadUrl,
  fetchArtifactsDetailed,
  revealArtifact,
  type ArtifactDetailed,
} from '@/lib/api/artifacts'
import { useT } from '@/lib/i18n'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'

const PINNED_STORAGE_KEY = 'openhive.filebrowser.pinned'

function loadPinned(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function savePinned(set: Set<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // ignore quota / private-mode errors
  }
}

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

type BucketKey =
  | { kind: 'pinned' }
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'thisWeek' }
  | { kind: 'thisMonth' }
  | { kind: 'month'; month: number }
  | { kind: 'year'; year: number }

function dayBucket(ms: number): BucketKey {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return { kind: 'today' }
  if (sameDay(d, yesterday)) return { kind: 'yesterday' }
  const week = 7 * 86400_000
  if (Date.now() - ms < week) return { kind: 'thisWeek' }
  if (Date.now() - ms < 4 * week) return { kind: 'thisMonth' }
  return d.getFullYear() === now.getFullYear()
    ? { kind: 'month', month: d.getMonth() + 1 }
    : { kind: 'year', year: d.getFullYear() }
}

function bucketKeyId(k: BucketKey): string {
  switch (k.kind) {
    case 'pinned':
    case 'today':
    case 'yesterday':
    case 'thisWeek':
    case 'thisMonth':
      return k.kind
    case 'month':
      return `month:${k.month}`
    case 'year':
      return `year:${k.year}`
  }
}

function bucketLabel(k: BucketKey, t: (key: string, vars?: Record<string, string>) => string, locale: 'en' | 'ko'): string {
  switch (k.kind) {
    case 'pinned':
      return t('records.files.bucket.pinned')
    case 'today':
      return t('records.files.bucket.today')
    case 'yesterday':
      return t('records.files.bucket.yesterday')
    case 'thisWeek':
      return t('records.files.bucket.thisWeek')
    case 'thisMonth':
      return t('records.files.bucket.thisMonth')
    case 'month': {
      if (locale === 'ko') return `${k.month}월`
      const label = new Date(2000, k.month - 1, 1).toLocaleDateString('en-US', { month: 'long' })
      return label
    }
    case 'year':
      return t('records.files.bucket.yearLabel', { year: String(k.year) })
  }
}

export function FileBrowser() {
  const t = useT()
  const locale = useAppStore((s) => s.locale)
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
  const [pinned, setPinned] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setPinned(loadPinned())
  }, [])

  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      savePinned(next)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    if (!teamId) {
      setArtifacts([])
      setLoading(false)
      return
    }
    try {
      setArtifacts(await fetchArtifactsDetailed(teamId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setArtifacts([])
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
    const pinnedList = filtered.filter((a) => pinned.has(a.id))
    const rest = filtered.filter((a) => !pinned.has(a.id))
    const byKey = new Map<string, { key: BucketKey; items: ArtifactDetailed[] }>()
    const ensure = (k: BucketKey) => {
      const id = bucketKeyId(k)
      let b = byKey.get(id)
      if (!b) {
        b = { key: k, items: [] }
        byKey.set(id, b)
      }
      return b
    }
    if (pinnedList.length > 0) ensure({ kind: 'pinned' }).items.push(...pinnedList)
    for (const a of rest) {
      ensure(dayBucket(a.createdAt)).items.push(a)
    }
    return Array.from(byKey.values()).map((b) => ({
      ...b,
      label: bucketLabel(b.key, t, locale),
    }))
  }, [filtered, pinned, t, locale])

  // TODO: wire real session title lookup when sessions API lands.
  const sessionLookup = useMemo(() => new Map<string, string>(), [])

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-950">
      {/* Toolbar */}
      <header className="shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="group flex items-center gap-1 h-8 w-[320px] max-w-full pl-2.5 pr-2 rounded-md border bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 focus-within:border-neutral-400 dark:focus-within:border-neutral-600 transition-colors">
            <MagnifyingGlass className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('records.files.searchPlaceholder')}
              className="flex-1 min-w-0 h-6 bg-transparent border-0 outline-none text-[12.5px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
            />
          </div>
          <div className="flex-1" />
          <span className="text-[11.5px] font-mono tabular-nums text-neutral-400">
            {t('records.files.countFiles', { n: String(filtered.length) })}
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
              aria-label={t('records.files.view.grid')}
              title={t('records.files.view.grid')}
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
              aria-label={t('records.files.view.list')}
              title={t('records.files.view.list')}
            >
              <Rows className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-3 rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 text-[12px] px-3 py-2">
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
                  ? t('records.files.loading')
                  : search.trim()
                    ? t('records.files.noResults')
                    : t('records.files.empty')}
              </div>
            </div>
          ) : view === 'grid' ? (
            <GridView buckets={buckets} selected={selected} onSelect={setSelected} />
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
              isPinned={pinned.has(selected.id)}
              onTogglePin={() => togglePin(selected.id)}
              onClose={() => setSelected(null)}
            />
          </aside>
        )}
      </div>
    </div>
  )
}

type Bucket = { key: BucketKey; label: string; items: ArtifactDetailed[] }

function BucketHeading({ bucket }: { bucket: Bucket }) {
  const pinned = bucket.key.kind === 'pinned'
  return (
    <h3 className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-neutral-400 mb-2">
      {pinned && <PushPin className="w-3 h-3 text-neutral-500" weight="fill" />}
      <span>{bucket.label}</span>
    </h3>
  )
}

function GridView({
  buckets,
  selected,
  onSelect,
}: {
  buckets: Bucket[]
  selected: ArtifactDetailed | null
  onSelect: (a: ArtifactDetailed) => void
}) {
  return (
    <div className="px-3 py-5 space-y-5">
      {buckets.map((b) => (
        <section key={bucketKeyId(b.key)}>
          <BucketHeading bucket={b} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
            {b.items.map((a) => {
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
  buckets: Bucket[]
  selected: ArtifactDetailed | null
  onSelect: (a: ArtifactDetailed) => void
  sessionLookup: Map<string, string>
}) {
  const t = useT()
  return (
    <div className="px-2 py-2">
      <div className="grid grid-cols-[1fr_200px_auto_120px] gap-x-4 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400 border-b border-neutral-200 dark:border-neutral-800">
        <span>{t('records.files.col.name')}</span>
        <span>{t('records.files.col.session')}</span>
        <span className="text-right">{t('records.files.col.size')}</span>
        <span>{t('records.files.col.created')}</span>
      </div>
      {buckets.map((b) => (
        <div key={bucketKeyId(b.key)}>
          <div className="px-4 pt-3 pb-1">
            <BucketHeading bucket={b} />
          </div>
          {b.items.map((a) => {
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
  isPinned,
  onTogglePin,
  onClose,
}: {
  artifact: ArtifactDetailed
  sessionTitle: string | null
  companySlug: string | null
  teamSlug: string | null
  isPinned: boolean
  onTogglePin: () => void
  onClose: () => void
}) {
  const t = useT()
  const v = fileVisual(artifact.filename)
  const sessionHref =
    companySlug && teamSlug
      ? `/${companySlug}/${teamSlug}/s/${artifact.sessionId}`
      : null
  const fullPath = `~/.openhive/${artifact.path}`

  const [copied, setCopied] = useState<'path' | 'name' | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)

  const copyText = async (text: string, kind: 'path' | 'name') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
  }

  const openFolder = async () => {
    setRevealError(null)
    try {
      await revealArtifact(artifact.id)
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col">
      <div className="relative px-5 pt-5 pb-4 border-b border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('records.files.close')}
          title={t('records.files.close')}
          className="absolute top-3 right-3 w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
        <div
          className={clsx(
            'w-14 h-16 rounded-lg flex items-center justify-center mb-3',
            v.bg,
          )}
        >
          <v.Icon className={clsx('w-7 h-7', v.fg)} weight="duotone" />
        </div>
        <div className="group/filename flex items-start gap-1 pr-6">
          <div className="text-[14.5px] font-semibold text-neutral-900 dark:text-neutral-100 break-words leading-snug flex-1 min-w-0">
            {artifact.filename}
          </div>
          <button
            type="button"
            onClick={() => void copyText(artifact.filename, 'name')}
            aria-label={t('records.files.copyName')}
            title={t('records.files.copyName')}
            className="shrink-0 w-5 h-5 mt-0.5 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 opacity-0 group-hover/filename:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
          >
            <Copy className="w-3 h-3" />
          </button>
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
        <div className="mt-3 flex items-center gap-1.5">
          <button
            type="button"
            onClick={openFolder}
            className="h-7 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5 flex-1 justify-center bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:opacity-90 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {t('records.files.openFolder')}
          </button>
          <a
            href={downloadUrl(artifact.id)}
            download
            aria-label={t('records.files.download')}
            title={t('records.files.download')}
            className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
          >
            <DownloadSimple className="w-3.5 h-3.5" />
          </a>
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={isPinned ? t('records.files.unpin') : t('records.files.pin')}
            title={isPinned ? t('records.files.unpin') : t('records.files.pin')}
            className={clsx(
              'h-7 w-7 rounded-md border flex items-center justify-center cursor-pointer',
              isPinned
                ? 'border-neutral-400 dark:border-neutral-600 bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'
                : 'border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            {isPinned ? (
              <PushPinSlash className="w-3.5 h-3.5" />
            ) : (
              <PushPin className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        {revealError && (
          <div className="mt-2 text-[11px] text-red-600 dark:text-red-400 break-words">
            {revealError}
          </div>
        )}
        {copied && (
          <div className="mt-2 text-[11px] text-neutral-500">
            {copied === 'path'
              ? t('records.files.copiedPath')
              : t('records.files.copiedName')}
          </div>
        )}
      </div>

      <dl className="px-5 py-4 text-[12px] space-y-2.5">
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">{t('records.files.detail.createdAt')}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300">
            {new Date(artifact.createdAt).toLocaleString()}
          </dd>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">{t('records.files.detail.size')}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 font-mono">
            {formatBytes(artifact.size)}
          </dd>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-2 items-baseline">
          <dt className="text-neutral-400">{t('records.files.detail.session')}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 min-w-0">
            {sessionHref ? (
              <Link
                to={sessionHref}
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
        <div className="grid grid-cols-[70px_1fr] gap-2 items-start group/path">
          <dt className="text-neutral-400 mt-0.5">{t('records.files.detail.path')}</dt>
          <dd className="flex items-start gap-1 min-w-0">
            <span className="text-neutral-500 dark:text-neutral-500 font-mono text-[11px] break-all flex-1 min-w-0">
              {fullPath}
            </span>
            <button
              type="button"
              onClick={() => void copyText(fullPath, 'path')}
              aria-label={t('records.files.copyPath')}
              title={t('records.files.copyPath')}
              className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 opacity-0 group-hover/path:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
            >
              <Copy className="w-3 h-3" />
            </button>
          </dd>
        </div>
      </dl>
    </div>
  )
}
