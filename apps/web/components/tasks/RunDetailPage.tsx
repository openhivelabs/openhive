import {
  ArrowBendDownRight,
  ArrowLeft,
  ArrowSquareOut,
  ArrowUp,
  Article,
  CaretDown,
  Check,
  CircleNotch,
  Coins,
  Copy,
  DownloadSimple,
  FileText,
  Globe,
  MagnifyingGlass,
  Paperclip,
  Plus,
  Warning,
  Wrench,
  X,
} from '@phosphor-icons/react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { flushSync } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AskInlineCard } from '@/components/tasks/AskInlineCard'
import { useT } from '@/lib/i18n'
import { postAnswer, type AskUserQuestion } from '@/lib/api/sessions'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useSessionsStore } from '@/lib/stores/useSessionsStore'
import { useTasksStore } from '@/lib/stores/useTasksStore'
import { addViewedId } from '@/lib/sessionViewed'

interface SessionArtifact {
  id: string
  filename: string
  size: number | null
  mime: string | null
  /** Epoch ms from the server. Used to slice artifacts per assistant message
   *  in buildChat — Claude-Desktop-style "attachments appear below the
   *  message that produced them". */
  created_at?: number | null
}

interface SessionUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost_cents: number
  n: number
}

export interface ChatSource {
  title: string
  url: string
  domain: string
  snippet?: string
  rank?: number
}

interface TranscriptEntry {
  kind: string
  ts?: number
  text?: string
  result?: unknown
  agent_role?: string
  questions?: unknown
  node_id?: string
  tool?: string
  args?: Record<string, unknown>
  /** Set by server-side transcript builder for web-search / web-fetch tool
   *  calls. Presence triggers the SourceCard renderer instead of the generic
   *  tool chip. Absence = parse failure or tool didn't produce sources. */
  sources?: ChatSource[]
  /** Set when the underlying skill returned `ok:false` (e.g. DDG timeout,
   *  rate limit). FE renders a warning chip with tooltip so the user
   *  understands why no results showed instead of assuming the UI broke. */
  error_code?: string
  error_message?: string
  /** Set alongside sources — we allow non-depth-0 tool calls for these
   *  specific tools because research happens in sub-agents but users still
   *  want to see "what was searched / fetched" in the main chat. */
  depth?: number
  /** delegate_parallel correlation — same group id across all N concurrent
   *  siblings + a per-instance index 0..N-1. Engine sets these on every
   *  tool_called emitted inside a parallel sibling so the FE can
   *  disambiguate which instance owned a given child call (all N share
   *  the same node_id). */
  sibling_group_id?: string
  sibling_index?: number
}

interface SessionSummary {
  id: string
  session_id: string
  goal: string
  title?: string | null
  output: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  status: string
  artifacts: SessionArtifact[]
  transcript: TranscriptEntry[]
  usage: SessionUsage | null
  pending_ask: {
    toolCallId: string
    questions: unknown[]
    agentRole?: string
  } | null
  /** Frozen team snapshot taken when the session started. Authoritative
   *  for resolving `delegate_to(assignee)` against the agent ids that
   *  actually ran — `useCurrentTeam` can drift if the user edits the
   *  team or switches teams while viewing an old session. */
  team_snapshot?: {
    id?: string
    agents?: { id: string; role: string; label?: string }[]
  }
}

function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function fmtBytes(b: number | null): string {
  if (b == null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function agentLabel(
  team: ReturnType<typeof useCurrentTeam>,
  nodeId: string | undefined,
  fallback = 'agent',
): string {
  if (!nodeId) return fallback
  const a = team?.agents.find((x) => x.id === nodeId)
  return a?.role ?? a?.label ?? nodeId
}

/** Items that can appear nested under a delegate chip's dropdown — what a
 *  subordinate did while serving the delegation. Same `tool` / `sources`
 *  shapes as the top-level stream, including the recursive `children`
 *  field so a sub-agent's own delegations stack one level deeper. */
type NestableChild =
  | {
      kind: 'tool'
      id: string
      author: string
      tool: string
      summary: string
      depth: number
      /** node_id of the agent that EMITTED this tool_call. Used by the
       *  nesting pass to disambiguate sibling delegates: if the Lead
       *  fan-outs delegate_to(Researcher) + delegate_to(Member) in the
       *  same turn, both delegates share depth=0, but their children's
       *  node_ids (a-122bbb vs a-1mm0vs) tell us who did what. */
      nodeId: string
      /** delegate_parallel correlation — same id across all N concurrent
       *  siblings, distinct index per instance. Set on every tool_call
       *  emitted inside a parallel sibling AND on each virtual chip we
       *  expand a delegate_parallel into. Lets the nesting pass match
       *  N same-node siblings 1:1 with their N children groups. */
      siblingGroupId?: string
      siblingIndex?: number
      delegate?: { mode: string; tasks: string[] }
      /** Todo-tool payload — set when this chip is `set_todos` /
       *  `add_todo` / `complete_todo`. The expanded view renders the
       *  full plan so the user can see WHAT the agent decided to track
       *  instead of just the bare tool name. `kind` distinguishes which
       *  tool, `items` is the list of plan strings (one entry for
       *  add_todo/complete_todo, the full plan for set_todos), and the
       *  optional `completedIndex` highlights which item in the plan a
       *  `complete_todo` finished — so the dropdown reads as a checklist
       *  with one line just struck through. */
      todo?: {
        kind: 'set' | 'add' | 'complete'
        items: string[]
        completedIndex?: number
      }
      /** Resolved node_id of the sub-agent THIS delegate spawned —
       *  populated only for delegate_to/delegate_parallel chips so the
       *  nesting pass knows which children belong here. Looked up from
       *  the team snapshot via the `assignee` arg. */
      expectedChildNode?: string
      children?: NestableChild[]
      errorCode?: string
      errorMessage?: string
    }
  | {
      kind: 'sources'
      id: string
      author: string
      variant: 'search' | 'fetch'
      query: string
      sources: ChatSource[]
      depth: number
      nodeId: string
      siblingGroupId?: string
      siblingIndex?: number
    }

type ChatItem =
  | { kind: 'user'; id: string; text: string; pending?: boolean }
  | {
      kind: 'assistant'
      id: string
      author: string
      text: string
      /** Artifacts produced during the turn that ended with this assistant
       *  message. Rendered as a card stack BELOW the prose, Claude-Desktop-
       *  style, so the user sees "here's the answer, here are the files"
       *  without the agent having to manually list download links in the
       *  body. */
      attachments: SessionArtifact[]
    }
  | {
      kind: 'tool'
      id: string
      author: string
      /** Raw tool name (`delegate_to`, `web-search`, …) — kept so the
       *  renderer can pick a tool-specific icon instead of using the
       *  generic wrench for everything. */
      tool: string
      summary: string
      /** For skill-related tool calls (`activate_skill`,
       *  `list_skill_files`, `read_skill_file`, `run_skill_script`), the
       *  skill name pulled straight from `args` — locale-independent so
       *  the group-summarizer doesn't have to parse the i18n'd summary. */
      skillName?: string
      /** Stack depth this tool_call ran at — 0 = Lead, 1 = direct
       *  subordinate, 2 = sub-sub. Used by the nesting pass to attach
       *  depth ≥ 1 items as children of the most recent delegate. */
      depth: number
      /** node_id of the agent that emitted this tool_call (see
       *  NestableChild for full rationale). */
      nodeId: string
      /** delegate_parallel correlation (see NestableChild). */
      siblingGroupId?: string
      siblingIndex?: number
      /** Delegation-specific payload — populated for `delegate_to` /
       *  `delegate_parallel` so the chip can drop down and show the
       *  actual task brief the Lead sent to the subordinate. Not all
       *  tool chips have one. `tasks` is an array even for `delegate_to`
       *  (single element) so the renderer can iterate uniformly. */
      delegate?: { mode: string; tasks: string[] }
      /** Resolved node_id of the sub-agent this delegate spawned. */
      expectedChildNode?: string
      /** Tool / source items the subordinate called while serving this
       *  delegation — populated by the nesting pass so the delegate
       *  chip's dropdown can show the actual work the sub-agent did,
       *  not just the brief. Empty / absent for non-delegation chips. */
      children?: NestableChild[]
      /** Skill failure metadata — set for failed web-search / web-fetch
       *  calls so the chip can render a warning indicator + tooltip
       *  instead of looking like a chip with hidden results. */
      errorCode?: string
      errorMessage?: string
    }
  | {
      // web-search / web-fetch rendered as a Claude-style source card:
      // collapsed header + stacked rows with favicon + title + domain.
      kind: 'sources'
      id: string
      author: string
      variant: 'search' | 'fetch'
      /** Original query for web-search, or fetched URL for web-fetch. Shown
       *  on the collapsed chip so the user can see what was searched
       *  without opening the source list. */
      query: string
      sources: ChatSource[]
      depth: number
      nodeId: string
      siblingGroupId?: string
      siblingIndex?: number
    }
  | {
      // 2+ consecutive tool / sources steps fold into one expandable bar.
      // Rendered as "진행 내역 N개 ∨" when collapsed, expands into the
      // original chip + source-card list when clicked. Mixing sources into
      // the group (not just plain tool chips) ensures a web-search turn
      // collapses as a single unit — otherwise "Searched the web" cards
      // escape the group and linger on screen when the user collapses it.
      kind: 'tool_group'
      id: string
      items: (
        | {
            kind: 'tool'
            id: string
            author: string
            tool: string
            summary: string
            skillName?: string
            depth: number
            nodeId: string
            siblingGroupId?: string
            siblingIndex?: number
            delegate?: { mode: string; tasks: string[] }
            todo?: {
              kind: 'set' | 'add' | 'complete'
              items: string[]
              completedIndex?: number
            }
            expectedChildNode?: string
            children?: NestableChild[]
            errorCode?: string
            errorMessage?: string
          }
        | {
            kind: 'sources'
            id: string
            author: string
            variant: 'search' | 'fetch'
            query: string
            sources: ChatSource[]
            depth: number
            nodeId: string
            siblingGroupId?: string
            siblingIndex?: number
          }
      )[]
    }
  | {
      kind: 'ask'
      id: string
      toolCallId: string
      questions: AskUserQuestion[]
      agentRole?: string
    }
  | { kind: 'error'; id: string; text: string }

/** Has the server recorded this pending user message? We match by text AND
 *  by timestamp — a retyped duplicate ("hi" twice in the same chat) must
 *  NOT be dedup'd against the earlier entry, or the optimistic bubble
 *  vanishes until the refetch lands. The transcript carries `ts` in seconds,
 *  so convert and give a couple-second buffer for clock skew between the
 *  client that stamped createdAt and the server that stamped ts. */
function isPendingConfirmed(
  summary: SessionSummary,
  pending: { text: string; createdAt: number },
): boolean {
  const wanted = pending.text.trim()
  if (!wanted) return true
  const cutoffMs = pending.createdAt - 2000
  // goal is the FIRST user message; it shares the session's started_at.
  // `started_at` is already in ms (unlike transcript event `ts`, which is
  // seconds) — don't re-scale it.
  if (summary.goal && summary.goal.trim() === wanted) {
    if (summary.started_at >= cutoffMs) return true
  }
  for (const e of summary.transcript) {
    // Drop the optimistic bubble as soon as ANY server-side bubble for the
    // same text lands — confirmed (`user_message`) OR queued
    // (`user_message_queued`). The queued one is what survives a page
    // reload, so once it's in the transcript the FE-only optimistic state
    // is redundant and would render a duplicate pending bubble.
    if (
      e.kind !== 'user_message' &&
      e.kind !== 'goal' &&
      e.kind !== 'user_message_queued'
    )
      continue
    if (String(e.text ?? '').trim() !== wanted) continue
    const tsMs = typeof e.ts === 'number' ? e.ts * 1000 : 0
    if (tsMs >= cutoffMs) return true
  }
  return false
}

/** Normalise a URL down to `host + path` so we can compare a URL the Lead
 *  wrote in prose against the URLs actually fetched this session. We drop
 *  scheme, `www.` prefix, trailing slash, query string, fragment — things
 *  the model routinely varies without meaning to reference a different page.
 *  `apple.com/investor` and `https://www.apple.com/investor/` collapse to
 *  the same key; `apple.com/investor-relations` stays distinct (correctly). */
function normalizeUrlForVerification(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    const path = u.pathname.replace(/\/$/, '')
    return `${host}${path}`
  } catch {
    return ''
  }
}

/** Collect every URL this session's workers actually web-searched or
 *  web-fetched — the "verified" set. Links in assistant prose that DON'T
 *  match any entry here are almost certainly hallucinated paths, and get
 *  a warning indicator in the UI. */
function collectVerifiedUrls(items: ChatItem[]): Set<string> {
  const out = new Set<string>()
  for (const it of items) {
    if (it.kind !== 'sources') continue
    for (const s of it.sources) {
      const key = normalizeUrlForVerification(s.url)
      if (key) out.add(key)
    }
  }
  return out
}

/** Context carrying the per-session set of verified URLs down to the
 *  Markdown component's custom `a` renderer. Defaults to an empty set so
 *  Markdown outside a chat (if any) behaves as "trust by default". */
const VerifiedUrlsContext = createContext<Set<string>>(new Set())

function summarizeTool(
  e: TranscriptEntry,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const tool = e.tool ?? 'tool'
  if (tool === 'delegate_to' || tool === 'delegate_parallel') {
    const assignee = String(e.args?.assignee ?? '?')
    return t('session.tool.delegate', { assignee })
  }
  if (tool === 'run_skill_script') {
    const skill = String(e.args?.skill ?? '')
    const script = e.args?.script as string | undefined
    return script
      ? t('session.tool.skillRunWithScript', { skill, script })
      : t('session.tool.skillRun', { skill })
  }
  if (tool === 'activate_skill') {
    return t('session.tool.skillActivate', { name: String(e.args?.name ?? '?') })
  }
  if (tool === 'read_skill_file') {
    return t('session.tool.skillReadFile', { path: String(e.args?.path ?? '?') })
  }
  if (tool === 'ask_user') {
    return t('session.tool.askUser')
  }
  if (tool === 'set_todos') {
    const raw = Array.isArray(e.args?.items) ? (e.args!.items as unknown[]) : []
    const n = raw.filter((x) => typeof x === 'string' && x.trim()).length
    return t('session.tool.todoSet', { count: n })
  }
  if (tool === 'add_todo') {
    return t('session.tool.todoAdd')
  }
  if (tool === 'complete_todo') {
    return t('session.tool.todoComplete')
  }
  if (tool === 'read_artifact') {
    return t('session.tool.readArtifact')
  }
  if (tool === 'web-search') {
    const query = String(e.args?.query ?? '').trim()
    return query ? `web-search "${truncate(query, 60)}"` : 'web-search'
  }
  if (tool === 'web-fetch') {
    const url = String(e.args?.url ?? '').trim()
    return url ? `web-fetch ${truncate(url, 60)}` : 'web-fetch'
  }
  return t('session.tool.generic', { tool })
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Pull the skill name out of a skill-related tool call's args, locale-
 *  free. `activate_skill` carries it as `name`; the other three carry it
 *  as `skill`. Returns undefined for non-skill tools or malformed args. */
function extractSkillName(
  tool: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined
  if (tool === 'activate_skill') {
    const v = args.name
    return typeof v === 'string' && v ? v : undefined
  }
  if (
    tool === 'list_skill_files' ||
    tool === 'read_skill_file' ||
    tool === 'run_skill_script'
  ) {
    const v = args.skill
    return typeof v === 'string' && v ? v : undefined
  }
  return undefined
}

/** Browser-side domain extractor — mirror of the server's domainFromUrl
 *  so we can synthesize a fetch-source when the server didn't attach one
 *  (older sessions, or fetches whose result body wasn't parseable). */
function domainFromBrowserUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Pull the task brief out of a delegate_to / delegate_parallel call's
 *  args so the chip can drop down and show what the Lead actually
 *  dispatched. Returns undefined for non-delegation tools or when the
 *  args are malformed (defensive — transcripts come from disk and
 *  could be old / partially written during a crash). */
/** Resolve a delegate_to / delegate_parallel `assignee` value (a role
 *  name, optionally `Role#id` for disambiguation) to the spawned
 *  sub-agent's node_id. Used by the nesting pass to match a delegate
 *  chip with its actual children when sibling delegates share a depth.
 *  Returns undefined if the team snapshot doesn't carry the role —
 *  caller falls back to depth-only matching. */
function resolveAssigneeNode(
  agents: { id: string; role: string }[] | undefined,
  assignee: unknown,
): string | undefined {
  const raw = String(assignee ?? '').trim()
  if (!raw || !agents || agents.length === 0) return undefined
  if (raw.includes('#')) {
    const [role, id] = raw.split('#', 2) as [string, string]
    const exact = agents.find((a) => a.id === id && a.role === role)
    if (exact) return exact.id
  }
  const byRole = agents.find((a) => a.role === raw)
  return byRole?.id
}

/** Resolve a todo-tool call into a renderable payload. Returns undefined
 *  for non-todo tools or when args don't carry usable data. The caller
 *  passes the running plan + cursor so `complete_todo` can show which
 *  item it just finished — the engine sends an opaque id that the FE
 *  has no way to map back to text otherwise. */
function extractTodoPayload(
  tool: string,
  args: Record<string, unknown> | undefined,
  plan: string[],
  cursor: number,
): { kind: 'set' | 'add' | 'complete'; items: string[]; completedIndex?: number } | undefined {
  if (!args) return undefined
  if (tool === 'set_todos') {
    const raw = Array.isArray(args.items) ? (args.items as unknown[]) : []
    const items = raw
      .map((x) => String(x ?? '').trim())
      .filter((s) => s.length > 0)
    if (!items.length) return undefined
    return { kind: 'set', items }
  }
  if (tool === 'add_todo') {
    const text = String(args.text ?? '').trim()
    if (!text) return undefined
    return { kind: 'add', items: [text] }
  }
  if (tool === 'complete_todo') {
    if (!plan.length) return { kind: 'complete', items: [] }
    const idx = Math.min(cursor, plan.length - 1)
    return { kind: 'complete', items: [plan[idx] ?? ''], completedIndex: idx }
  }
  return undefined
}


function extractDelegatePayload(
  tool: string,
  args: Record<string, unknown> | undefined,
): { mode: string; tasks: string[] } | undefined {
  if (!args) return undefined
  if (tool === 'delegate_to') {
    const task = String(args.task ?? '').trim()
    if (!task) return undefined
    return { mode: String(args.mode ?? ''), tasks: [task] }
  }
  if (tool === 'delegate_parallel') {
    const raw = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
    const tasks = raw
      .map((t) => String(t ?? '').trim())
      .filter((t) => t.length > 0)
    if (tasks.length === 0) return undefined
    return { mode: String(args.mode ?? ''), tasks }
  }
  return undefined
}

/** Tool chip — generic step-stream row used for both inline (inside a
 *  ToolGroupBar) and standalone renderings. For delegations carries an
 *  expand affordance: clicking drops down the actual task brief the
 *  Lead sent to the subordinate, indented under a left rail so it
 *  visually nests under the chip. Non-delegation chips render as plain
 *  text rows with no interaction. */
function ToolChip({
  tool,
  summary,
  delegate,
  todo,
  children,
  errorCode,
  errorMessage,
}: {
  tool: string
  summary: string
  delegate?: { mode: string; tasks: string[] }
  todo?: {
    kind: 'set' | 'add' | 'complete'
    items: string[]
    completedIndex?: number
  }
  children?: NestableChild[]
  errorCode?: string
  errorMessage?: string
}) {
  const t = useT()
  const Icon = iconForTool(tool)
  const [expanded, setExpanded] = useState(false)
  const hasChildren = !!children && children.length > 0
  const hasTodo = !!todo && todo.items.length > 0
  const expandable = !!delegate || hasChildren || hasTodo
  const failed = !!errorCode
  const failedReason =
    errorCode === 'search_unavailable'
      ? t('session.tool.failed.timeout')
      : errorCode === 'search_rate_limited'
        ? t('session.tool.failed.rateLimited')
        : null
  const failedTitle = failed
    ? errorMessage
      ? `${errorCode}: ${errorMessage}`
      : errorCode
    : undefined
  const baseRow = (
    <span
      className="inline-flex max-w-full items-center gap-2 text-[12.5px] font-mono text-neutral-500 dark:text-neutral-400"
      title={failedTitle}
    >
      <Icon className="w-3 h-3 shrink-0 opacity-60" />
      <span className="truncate text-neutral-600 dark:text-neutral-300">
        {summary}
      </span>
      {failed && (
        <span className="inline-flex items-center gap-1 shrink-0 rounded border border-neutral-200 dark:border-neutral-800 px-1.5 py-px text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          <span>{t('session.tool.failed')}</span>
          {failedReason && (
            <>
              <span className="opacity-50">·</span>
              <span className="normal-case tracking-normal">
                {failedReason}
              </span>
            </>
          )}
        </span>
      )}
      {expandable && (
        <CaretDown
          className={`w-3 h-3 shrink-0 opacity-50 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      )}
    </span>
  )
  if (!expandable) return baseRow
  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
      >
        {baseRow}
      </button>
      {expanded && (
        <div className="mt-2 ml-[7px] pl-3 border-l border-neutral-200 dark:border-neutral-800 space-y-2">
          {hasTodo && (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-900/40 px-3 py-2.5">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 font-mono mb-1.5">
                {todo!.kind === 'set'
                  ? t('session.tool.todoSetTitle')
                  : todo!.kind === 'add'
                    ? t('session.tool.todoAddTitle')
                    : t('session.tool.todoCompleteTitle')}
              </div>
              <ol className="space-y-1">
                {todo!.items.map((item, i) => {
                  const isCompletedRow =
                    todo!.kind === 'complete' ||
                    (todo!.kind === 'set' && todo!.completedIndex === i)
                  return (
                    <li
                      key={`todo-${i}`}
                      className="flex gap-2 text-[12.5px] leading-relaxed font-sans text-neutral-700 dark:text-neutral-200"
                    >
                      <span className="shrink-0 text-neutral-400 dark:text-neutral-500 font-mono">
                        {todo!.kind === 'set' ? `${i + 1}.` : '•'}
                      </span>
                      <span
                        className={
                          isCompletedRow
                            ? 'line-through text-neutral-400 dark:text-neutral-500'
                            : ''
                        }
                      >
                        {item}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
          {delegate?.tasks.map((task, i) => (
            <div
              key={`task-${i}`}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-900/40 px-3 py-2.5"
            >
              {(delegate.tasks.length > 1 || delegate.mode) && (
                <div className="flex items-center gap-2 mb-1.5 text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 font-mono">
                  {delegate.tasks.length > 1 && (
                    <span>
                      task {i + 1}/{delegate.tasks.length}
                    </span>
                  )}
                  {delegate.mode && (
                    <span className="rounded-full border border-neutral-200 dark:border-neutral-700 px-1.5 py-px text-neutral-500 dark:text-neutral-400 normal-case tracking-normal">
                      {delegate.mode}
                    </span>
                  )}
                </div>
              )}
              <div className="text-[12.5px] text-neutral-700 dark:text-neutral-200 leading-relaxed whitespace-pre-wrap font-sans">
                {task}
              </div>
            </div>
          ))}
          {hasChildren && (
            <ul className="space-y-1.5 pt-1">
              {partitionNestedChildren(children!).map((slot) => (
                <li key={slot.key} className="flex">
                  {slot.kind === 'fetch_strip' ? (
                    <FetchStrip sources={slot.sources} />
                  ) : (
                    <NestedChild item={slot.item} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Render a child step inside a delegate dropdown — same chip shape as
 *  the top-level stream so the user reads "what the sub-agent did" with
 *  the exact same visual grammar (icon + mono text, web-search pill,
 *  web-fetch link row). Nested delegates recurse via ToolChip. */
function NestedChild({ item }: { item: NestableChild }) {
  if (item.kind === 'tool') {
    return (
      <ToolChip
        tool={item.tool}
        summary={item.summary}
        delegate={item.delegate}
        todo={item.todo}
        children={item.children}
        errorCode={item.errorCode}
        errorMessage={item.errorMessage}
      />
    )
  }
  return (
    <SourceCard
      variant={item.variant}
      query={item.query}
      sources={item.sources}
    />
  )
}

/** Icon to use on a tool chip. Delegations get the ↘ arrow (matches the
 *  hand-off semantics and the textual `↘ delegating to …` prefix used
 *  elsewhere); everything else falls back to the generic wrench. */
function iconForTool(tool: string) {
  if (tool === 'delegate_to' || tool === 'delegate_parallel') {
    return ArrowBendDownRight
  }
  if (tool === 'web-search') return MagnifyingGlass
  if (tool === 'web-fetch') return Article
  return Wrench
}

/**
 * Split a session's artifacts into (user-visible, hidden-helpers).
 *
 * Some skills emit helper side-outputs alongside their primary deliverable
 * (pdf's `build_doc.py` always writes a `.pdf.spec.json` next to the PDF
 * for round-trip edits). Those helpers shouldn't appear as chat
 * attachments — the user asked for "one PDF", not "a PDF and a JSON
 * blueprint". Rule: any artifact whose filename is
 * `<primary>.spec.json` is hidden when `<primary>` also exists.
 *
 * The helpers still live on disk at ~/.openhive/sessions/{id}/artifacts/
 * so power users with round-trip editing needs can find them.
 */
function partitionArtifacts(artifacts: SessionArtifact[]): {
  visible: SessionArtifact[]
  hidden: SessionArtifact[]
} {
  const filenames = new Set(artifacts.map((a) => a.filename))
  const visible: SessionArtifact[] = []
  const hidden: SessionArtifact[] = []
  for (const a of artifacts) {
    if (a.filename.endsWith('.spec.json')) {
      const parent = a.filename.slice(0, -'.spec.json'.length)
      if (filenames.has(parent)) {
        hidden.push(a)
        continue
      }
    }
    visible.push(a)
  }
  return { visible, hidden }
}

function buildChat(
  summary: SessionSummary,
  team: ReturnType<typeof useCurrentTeam>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): ChatItem[] {
  const out: ChatItem[] = []
  if (summary.goal) {
    out.push({ kind: 'user', id: 'goal', text: summary.goal })
  }
  // Track the timestamp of each assistant message as we go so we can slice
  // artifacts into "created between prev assistant and this one" buckets.
  // Assistant messages without an explicit ts (e.g. the `final` legacy
  // fallback) get Number.POSITIVE_INFINITY so they absorb any tail artifacts.
  const assistantTsByIndex: number[] = []

  // Running view of the session's todo plan, walked forward. `set_todos`
  // returns ids in its result envelope but the engine doesn't surface
  // those back into the transcript args, so we approximate by indexing
  // the items[] array — `complete_todo` passes the engine-side id which
  // we can't resolve from the FE side. To still give the user a useful
  // dropdown for `complete_todo`, we remember the most recent plan and
  // mark "this row is the Nth one from that plan" — see todoCursor.
  let todoPlan: string[] = []
  let todoCursor = 0  // next un-completed index from todoPlan
  summary.transcript.forEach((e, i) => {
    const id = `t-${i}`
    switch (e.kind) {
      case 'goal':
        // already rendered as the first user bubble
        break
      case 'agent_message': {
        const txt = String(e.text ?? '').trim()
        if (!txt) break
        out.push({
          kind: 'assistant',
          id,
          author: agentLabel(team, e.node_id, e.agent_role ?? 'agent'),
          text: txt,
          attachments: [],
        })
        assistantTsByIndex.push(
          typeof e.ts === 'number' ? e.ts : Number.POSITIVE_INFINITY,
        )
        break
      }
      case 'tool_call': {
        const tool = e.tool ?? ''
        if (
          (tool === 'web-search' || tool === 'web-fetch') &&
          Array.isArray(e.sources) &&
          e.sources.length > 0
        ) {
          out.push({
            kind: 'sources',
            id,
            author: agentLabel(team, e.node_id, e.agent_role ?? 'agent'),
            variant: tool === 'web-search' ? 'search' : 'fetch',
            query: String(
              tool === 'web-search' ? e.args?.query ?? '' : e.args?.url ?? '',
            ).trim(),
            sources: e.sources,
            depth: typeof e.depth === 'number' ? e.depth : 0,
            nodeId: String(e.node_id ?? ''),
            siblingGroupId: e.sibling_group_id,
            siblingIndex: e.sibling_index,
          })
          break
        }
        // web-fetch without extracted sources: synthesize one from the URL
        // arg so EVERY fetch flows through the compact SourceCard renderer
        // (icon-only, clickable). Avoids the noisy "web-fetch <full-url>"
        // generic chip path that clutters research turns.
        if (tool === 'web-fetch' && !e.error_code) {
          const url = String(e.args?.url ?? '').trim()
          if (url) {
            out.push({
              kind: 'sources',
              id,
              author: agentLabel(team, e.node_id, e.agent_role ?? 'agent'),
              variant: 'fetch',
              query: url,
              sources: [
                { title: url, url, domain: domainFromBrowserUrl(url) },
              ],
              depth: typeof e.depth === 'number' ? e.depth : 0,
              nodeId: String(e.node_id ?? ''),
              siblingGroupId: e.sibling_group_id,
              siblingIndex: e.sibling_index,
            })
            break
          }
        }
        const author = agentLabel(team, e.node_id, e.agent_role ?? 'agent')
        const depth = typeof e.depth === 'number' ? e.depth : 0
        const nodeId = String(e.node_id ?? '')
        const childNode =
          tool === 'delegate_to' || tool === 'delegate_parallel'
            ? resolveAssigneeNode(
                // Prefer the session's frozen snapshot — it has the
                // exact agent ids that ran. Fall back to the live
                // team store only if the snapshot is missing (older
                // sessions written before the snapshot field landed).
                summary.team_snapshot?.agents ?? team?.agents,
                e.args?.assignee,
              )
            : undefined
        // Expand `delegate_parallel` into N independent chips — one per
        // task — so the user sees three "delegating to Member" rows
        // instead of one chip with three task boxes inside. Each virtual
        // chip carries (siblingGroupId, siblingIndex) matching what the
        // engine stamps on every nested tool_called inside that sibling,
        // so `nestUnderDelegates` can attach grandchildren 1:1.
        if (tool === 'delegate_parallel') {
          const tasks = Array.isArray(e.args?.tasks)
            ? (e.args!.tasks as unknown[]).map((x) => String(x ?? '').trim())
            : []
          // The engine stamps `sibling_group_id` on the delegate_parallel
          // event itself (and on every nested tool_called), surfaced by
          // the transcript builder as `e.sibling_group_id`. NOT under
          // `args` — `args` is only the call's `arguments`.
          const groupId = e.sibling_group_id ?? `g-${id}`
          const mode = String(e.args?.mode ?? '')
          const assignee = String(e.args?.assignee ?? '?')
          tasks.forEach((task, idx) => {
            out.push({
              kind: 'tool',
              id: `${id}-${idx}`,
              author,
              tool: 'delegate_to',
              summary: t('session.tool.delegate', { assignee }),
              depth,
              nodeId,
              siblingGroupId: groupId,
              siblingIndex: idx,
              delegate: { mode, tasks: [task] },
              expectedChildNode: childNode,
            })
          })
          break
        }
        const todo = extractTodoPayload(tool, e.args, todoPlan, todoCursor)
        // Advance the running plan view BEFORE emitting the chip so a
        // chained set_todos → complete_todo pair stays consistent.
        if (todo?.kind === 'set') {
          todoPlan = [...todo.items]
          todoCursor = 0
        } else if (todo?.kind === 'add') {
          todoPlan = [...todoPlan, ...todo.items]
        } else if (todo?.kind === 'complete') {
          todoCursor = Math.min(todoCursor + 1, todoPlan.length)
        }
        out.push({
          kind: 'tool',
          id,
          author,
          tool,
          summary: summarizeTool(e, t),
          skillName: extractSkillName(tool, e.args),
          depth,
          nodeId,
          siblingGroupId: e.sibling_group_id,
          siblingIndex: e.sibling_index,
          delegate: extractDelegatePayload(tool, e.args),
          todo,
          expectedChildNode: childNode,
          errorCode: e.error_code,
          errorMessage: e.error_message,
        })
        break
      }
      case 'ask_user':
        // Pending ask (if any) is rendered as a live inline card below, after
        // the base transcript loop. Already-answered asks don't need a
        // standalone bubble — the following `user_answer` entry renders the
        // user's choice, which is self-explanatory in context.
        break
      case 'user_answer': {
        const r =
          typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '')
        out.push({ kind: 'user', id, text: r })
        break
      }
      case 'user_message': {
        // Follow-up user message in a continuous chat session.
        const txt = String(e.text ?? '').trim()
        if (txt) out.push({ kind: 'user', id, text: txt })
        break
      }
      case 'user_message_queued': {
        // Server-side pending bubble — the message landed in the engine
        // inbox but hasn't been popped into a turn yet. The transcript
        // builder already drops queued entries that have a matching
        // confirmed `user_message`, so anything that reaches here is
        // genuinely still pending. Render below the spinner via the
        // existing `pending: true` partition.
        const txt = String(e.text ?? '').trim()
        if (txt) out.push({ kind: 'user', id, text: txt, pending: true })
        break
      }
      default:
        break
    }
  })
  if (summary.output) {
    // The session's "output" mirrors the latest top-level agent_message.
    // Skip if the transcript already rendered that bubble (the common case);
    // push only for legacy sessions that stored `output` without emitting the
    // streamed message event.
    const lastAssistant = [...out].reverse().find((x) => x.kind === 'assistant')
    if (!lastAssistant || lastAssistant.text.trim() !== summary.output.trim()) {
      out.push({
        kind: 'assistant',
        id: 'final',
        author: team?.agents[0]?.role ?? 'lead',
        text: summary.output,
        attachments: [],
      })
      assistantTsByIndex.push(Number.POSITIVE_INFINITY)
    }
  }
  if (summary.error) {
    out.push({ kind: 'error', id: 'error', text: summary.error })
  }

  // Attach artifacts to whichever assistant message was "the answer that
  // produced this file" — by timestamp. An artifact with created_at T goes
  // to the first assistant whose ts >= T (i.e. the one that wraps the tool
  // calls that generated it). Artifacts without created_at (older sessions)
  // fall through to the final assistant so they're still reachable. Hidden
  // helper artifacts (e.g. pdf's sidecar `.spec.json`) are filtered out
  // here too.
  const assistantItems = out.flatMap((x) =>
    x.kind === 'assistant' ? [x] : [],
  )
  if (assistantItems.length > 0) {
    const { visible } = partitionArtifacts(summary.artifacts ?? [])
    const sorted = [...visible].sort((a, b) => {
      const ta = typeof a.created_at === 'number' ? a.created_at : Number.POSITIVE_INFINITY
      const tb = typeof b.created_at === 'number' ? b.created_at : Number.POSITIVE_INFINITY
      return ta - tb
    })
    for (const art of sorted) {
      // Transcript event ts is in seconds; artifact.created_at is in ms
      // (see lib/server/artifacts.ts — populated from `created_at_ms`).
      // Normalize to seconds before comparing or every comparison underflows
      // and all artifacts dump on the final assistant.
      const tSec =
        typeof art.created_at === 'number'
          ? art.created_at / 1000
          : Number.POSITIVE_INFINITY
      let idx = assistantTsByIndex.findIndex((ts) => ts >= tSec)
      if (idx < 0) idx = assistantItems.length - 1
      assistantItems[idx]!.attachments.push(art)
    }
  }

  // Collapse consecutive tool steps (≥2) into a single expandable group.
  // User asked for a Claude-Desktop-style "N steps ∨" bar — raw chip
  // stream gets visually noisy once a turn runs 10+ tools.
  return collapseToolRuns(nestUnderDelegates(out))
}

/** Move depth ≥ 1 tool/sources items into the `children` array of the
 *  most recent ancestor `delegate_to` / `delegate_parallel`, so the chat
 *  stream only shows the Lead's actions at the top level — the sub-
 *  agent's actions live inside their delegate chip's dropdown.
 *
 *  Approach: linear pass with a stack of currently-open delegates keyed
 *  by their CHILD depth (`item.depth + 1`). For each tool/sources item,
 *  pop until the stack top's child depth ≤ item.depth, then either
 *  attach to that top (depth match) or leave at root. New delegates push
 *  themselves onto the stack so subsequent deeper items nest under them.
 *  Non-tool / non-sources items reset the stack — an assistant message
 *  always closes any open delegations from the user's POV. */
function nestUnderDelegates(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  type Frame = {
    item: NestableChild & { kind: 'tool' }
    childDepth: number
    /** node_id of the sub-agent THIS delegate spawned. Children whose
     *  `nodeId` matches attach here. Multiple sibling delegates at the
     *  same depth are disambiguated primarily by this field. */
    expectedChildNode?: string
    /** delegate_parallel siblings share `expectedChildNode` (same role),
     *  so we additionally match by sibling group + index to route each
     *  N children groups to its correct N parents. */
    siblingGroupId?: string
    siblingIndex?: number
  }
  const stack: Frame[] = []

  // Find the open frame that owns this child. Matching priority:
  //   1. exact (depth, nodeId, siblingGroupId, siblingIndex) — both the
  //      child and frame name the same parallel-sibling slot.
  //   2. (depth, nodeId) — non-parallel parent with matching agent.
  //   3. (depth) with no expectedChildNode — legacy fallback.
  const findOwner = (
    depth: number,
    nodeId: string,
    siblingGroupId: string | undefined,
    siblingIndex: number | undefined,
  ): Frame | undefined => {
    if (siblingGroupId !== undefined && siblingIndex !== undefined) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const f = stack[i]!
        if (f.childDepth !== depth) continue
        if (f.expectedChildNode && f.expectedChildNode !== nodeId) continue
        if (
          f.siblingGroupId === siblingGroupId &&
          f.siblingIndex === siblingIndex
        ) {
          return f
        }
      }
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!
      if (f.childDepth !== depth) continue
      // Skip parallel-sibling frames when the child has no sibling info —
      // we can't tell which slot it belongs to, falling through avoids
      // arbitrarily attaching to the first sibling's bucket.
      if (f.siblingGroupId && siblingGroupId === undefined) continue
      if (f.expectedChildNode && f.expectedChildNode === nodeId) return f
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!
      if (f.childDepth === depth && !f.expectedChildNode && !f.siblingGroupId)
        return f
    }
    return undefined
  }

  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'sources') {
      // No pop based on depth — sibling delegates share `childDepth` with
      // parents in nested cases AND with each other in fan-out cases.
      // `nodeId` + `siblingGroupId/Index` matching in `findOwner`
      // disambiguates correctly. Stale frames clear naturally on the
      // next assistant_message reset (end of Lead's turn).
      const owner = findOwner(
        it.depth,
        it.nodeId,
        it.siblingGroupId,
        it.siblingIndex,
      )
      if (owner) {
        if (!owner.item.children) owner.item.children = []
        owner.item.children.push(it as NestableChild)
      } else {
        // depth=0, or no matching open delegate — root level.
        out.push(it)
      }
      if (
        it.kind === 'tool' &&
        (it.tool === 'delegate_to' || it.tool === 'delegate_parallel')
      ) {
        stack.push({
          item: it,
          childDepth: it.depth + 1,
          expectedChildNode: it.expectedChildNode,
          siblingGroupId: it.siblingGroupId,
          siblingIndex: it.siblingIndex,
        })
      }
      continue
    }
    // Non-tool item (assistant, user, ask, error) — close any open
    // delegations and emit at root.
    stack.length = 0
    out.push(it)
  }
  return out
}

function collapseToolRuns(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  type Groupable = Extract<ChatItem, { kind: 'tool' } | { kind: 'sources' }>
  let run: Groupable[] = []
  // Skill-cluster tracking: when the run consists of consecutive
  // skill-tool calls all referencing the same skill, we collapse it into
  // one chip ("X 스킬 사용"), even if it's a single call. A skill name
  // change OR a non-skill tool flushes the cluster — the user explicitly
  // asked for "one step per skill use", not "one step per tool call".
  let runSkillName: string | undefined
  const flush = () => {
    if (run.length === 0) return
    // Skill clusters always collapse (so a single activate_skill still
    // renders as the compact "X 스킬 사용" line, not a noisy chip).
    // Non-skill clusters keep the legacy "≥2 to collapse" rule so single
    // delegate / web chips don't get hidden behind a dropdown for no reason.
    const shouldGroup = !!runSkillName || run.length >= 2
    if (shouldGroup) {
      out.push({
        kind: 'tool_group',
        id: `g-${run[0]!.id}`,
        items: run.map((r) =>
          r.kind === 'tool'
            ? {
                kind: 'tool',
                id: r.id,
                author: r.author,
                tool: r.tool,
                summary: r.summary,
                skillName: r.skillName,
                depth: r.depth,
                nodeId: r.nodeId,
                siblingGroupId: r.siblingGroupId,
                siblingIndex: r.siblingIndex,
                delegate: r.delegate,
                todo: r.todo,
                expectedChildNode: r.expectedChildNode,
                children: r.children,
                errorCode: r.errorCode,
                errorMessage: r.errorMessage,
              }
            : {
                kind: 'sources',
                id: r.id,
                author: r.author,
                variant: r.variant,
                query: r.query,
                sources: r.sources,
                depth: r.depth,
                nodeId: r.nodeId,
                siblingGroupId: r.siblingGroupId,
                siblingIndex: r.siblingIndex,
              },
        ),
      })
    } else {
      out.push(run[0]!)
    }
    run = []
    runSkillName = undefined
  }
  const itemSkillName = (it: Groupable): string | undefined =>
    it.kind === 'tool' ? it.skillName : undefined
  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'sources') {
      const sn = itemSkillName(it)
      // Skill name changed OR transitioning between skill ↔ non-skill —
      // flush before joining the new run so each skill stays one chip.
      if (run.length > 0 && sn !== runSkillName) flush()
      if (run.length === 0) runSkillName = sn
      run.push(it)
    } else {
      flush()
      out.push(it)
    }
  }
  flush()
  return out
}

export function RunDetailPage() {
  const params = useParams<{
    companySlug: string
    teamSlug: string
    sessionId: string
  }>()
  const navigate = useNavigate()
  const t = useT()
  const team = useCurrentTeam()
  // Left sidebar (TeamPanel) is 220px expanded / 52px collapsed; right
  // artifacts aside is fixed at 272px. To keep the chat column centered to
  // the viewport regardless of collapse state, we pad the chat column's
  // left by the difference (168px) when the team panel is collapsed.
  const teamPanelCollapsed = useAppStore((s) => s.teamPanelCollapsed)
  const chatColOffsetPx = teamPanelCollapsed ? 168 : 0
  const tasks = useTasksStore((s) => s.tasks)
  const id = params?.sessionId ?? null
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [sending, setSending] = useState(false)
  // Bumped by sendMessage after a successful POST so the stream effect re-runs
  // and re-opens the SSE subscription. Idle sessions close the stream on
  // `[DONE]`; without a reconnect hook, a follow-up message's events never
  // reach the client and the optimistic bubble has nothing to resolve to
  // until a manual page refresh.
  const [streamEpoch, setStreamEpoch] = useState(0)
  const [pendingUserMessages, setPendingUserMessages] = useState<
    { id: string; text: string; createdAt: number }[]
  >(() => {
    // Seed from NewChatPage handoff: the user's first message was typed there
    // but the session only exists now. Without this, the bubble briefly
    // disappears between /new navigation and the first summary fetch.
    if (typeof window === 'undefined' || !params?.sessionId) return []
    try {
      const key = `openhive:pending:${params.sessionId}`
      const text = sessionStorage.getItem(key)
      if (text) {
        sessionStorage.removeItem(key)
        // createdAt=0 so the goal event (which has ts ≈ session started_at
        // before this seed was created) still dedup's this handoff bubble.
        return [{ id: `handoff-${Date.now()}`, text, createdAt: 0 }]
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return []
  })
  const [sendError, setSendError] = useState<string | null>(null)
  // True only while the AI is actively producing output in the current turn.
  // Flips on node_started/token/tool_call/ask_user, off on turn_finished/
  // run_finished/run_error. A chat session parks in running status between
  // turns, so we can't use summary.status for the spinner.
  const [aiActive, setAiActive] = useState(false)

  useEffect(() => {
    if (!id) {
      setSummary(null)
      setLoading(false)
      setAiActive(false)
      return
    }
    let cancelled = false
    let es: EventSource | null = null
    let refetchTimer: ReturnType<typeof setTimeout> | null = null
    let inflight = false
    let viewedMarked = false
    let missing = false
    // If events arrive while a fetch is inflight, set this so we kick off
    // one more fetch when the current one resolves — otherwise late events
    // (tokens after the first refetch started) never get reflected.
    let dirty = false
    setAiActive(false)

    const fetchSummary = async () => {
      if (cancelled) return
      if (inflight) {
        dirty = true
        return
      }
      inflight = true
      dirty = false
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
        if (!res.ok) {
          if (!cancelled) {
            if (res.status === 404) {
              missing = true
              setNotFound(true)
              // Purge stale references so the sidebar / task list don't keep
              // showing this dead session. SSE-stream 404s have their own
              // purge, but a direct deep-link visit never reaches that path.
              useSessionsStore.getState().removeSession(id)
              const owner = useTasksStore
                .getState()
                .tasks.find((t) => t.sessions.some((r) => r.id === id))
              if (owner) useTasksStore.getState().removeSession(id)
            }
          }
          return
        }
        missing = false
        const data = (await res.json()) as SessionSummary
        if (!cancelled) {
          setSummary(data)
          // Mark the session as read — previously only TasksTab.openSession did
          // this, so a user who landed on /s/:id directly (deep link, nav from
          // the chat, etc.) would see the run stuck as "new result" forever.
          if (!viewedMarked && id) {
            viewedMarked = true
            useSessionsStore.getState().markViewed(id)
            const owner = useTasksStore
              .getState()
              .tasks.find((t) => t.sessions.some((r) => r.id === id))
            if (owner) useTasksStore.getState().markRunViewed(owner.id, id)
            addViewedId(id)
          }
        }
      } catch {
        /* transient — will refetch on next event */
      } finally {
        inflight = false
        if (!cancelled) setLoading(false)
        if (dirty && !cancelled) {
          dirty = false
          void fetchSummary()
        }
      }
    }

    const scheduleRefetch = () => {
      if (refetchTimer) return
      refetchTimer = setTimeout(() => {
        refetchTimer = null
        void fetchSummary()
      }, 60)
    }

    setLoading(true)
    setNotFound(false)

    void fetchSummary().then(() => {
      if (cancelled || missing) return
      es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`)
      es.onmessage = (ev) => {
        if (ev.data === '[DONE]') {
          es?.close()
          es = null
          setAiActive(false)
          void fetchSummary()
          return
        }
        try {
          const evt = JSON.parse(ev.data) as { kind?: string }
          switch (evt.kind) {
            case 'run_started':
            case 'node_started':
            case 'token':
            case 'tool_call':
            case 'native_tool':
              setAiActive(true)
              break
            case 'turn_finished':
            case 'run_finished':
            case 'run_error':
            case 'ask_user':
            case 'user_question':
              setAiActive(false)
              break
            case 'user_message':
              // New user input kicks off the next turn; the matching
              // node_started will flip aiActive on immediately after.
              break
          }
        } catch {
          /* non-JSON frame (shouldn't happen) */
        }
        scheduleRefetch()
      }
      es.onerror = () => {
        // EventSource fires onerror on transient hiccups too (the browser is
        // about to auto-reconnect — readyState === CONNECTING). Only tear
        // down when the connection is permanently closed; otherwise
        // previously we killed the subscription on the first blip and the
        // user had to hard-refresh to see any further AI output.
        if (es && es.readyState === EventSource.CLOSED) {
          es = null
          // Connection is gone for good — do a final refetch so any events
          // that arrived during the teardown are reflected.
          void fetchSummary()
        }
      }
    })

    return () => {
      cancelled = true
      if (refetchTimer) clearTimeout(refetchTimer)
      if (es) es.close()
    }
  }, [id, streamEpoch])

  // 드래프트/세션 분리 이후 session 은 sessions store 의 1급 레코드로 관리됨.
  // 이 화면의 데이터 소스는 서버 summary — task 참조는 오직 화면 컨텍스트
  // (제목/참고자료 등) 용도. pendingAsk 는 서버 summary 를 truth 로 사용한다.
  const task =
    (summary?.session_id
      ? tasks.find((x) => x.sessions.some((r) => r.id === summary.session_id))
      : null) ?? null
  const pendingAsk = summary?.pending_ask ?? null
  const [answerBusy, setAnswerBusy] = useState(false)

  const submitAnswers = async (answers: Record<string, string>) => {
    if (!pendingAsk || !id) return
    const snapshot = pendingAsk
    // Optimistic: drop the ask card this frame. Network + resume can take
    // hundreds of ms; leaving the card visible reads as a UI glitch.
    flushSync(() => {
      setAnswerBusy(true)
      setSummary((prev) => (prev ? { ...prev, pending_ask: null } : prev))
    })
    try {
      await postAnswer(snapshot.toolCallId, {
        answers,
        sessionId: id,
        locale: useAppStore.getState().locale,
      })
    } catch (e) {
      console.error(e)
      // Restore so the user can retry.
      setSummary((prev) =>
        prev ? { ...prev, pending_ask: snapshot } : prev,
      )
    } finally {
      setAnswerBusy(false)
    }
  }

  const skipAsk = async () => {
    if (!pendingAsk || !id) return
    const snapshot = pendingAsk
    flushSync(() => {
      setAnswerBusy(true)
      setSummary((prev) => (prev ? { ...prev, pending_ask: null } : prev))
    })
    try {
      await postAnswer(snapshot.toolCallId, {
        skipped: true,
        sessionId: id,
        locale: useAppStore.getState().locale,
      })
    } catch (e) {
      console.error(e)
      setSummary((prev) =>
        prev ? { ...prev, pending_ask: snapshot } : prev,
      )
    } finally {
      setAnswerBusy(false)
    }
  }

  const chat = useMemo(() => {
    if (!summary) {
      // Summary hasn't loaded yet — still render handoff pending bubbles so
      // the message stays visible across the /new → /s/{id} transition.
      return pendingUserMessages.map((m) => ({
        kind: 'user' as const,
        id: m.id,
        text: m.text,
        pending: true,
      }))
    }
    const base = buildChat(summary, team, t)
    // Drop pending bubbles only when the server has recorded a matching
    // user_message/goal AFTER the pending was created. Text-only dedup would
    // silently eat the optimistic bubble whenever the user retyped the same
    // message (e.g. "hi" twice) — collapsing to a ~1s gap until the refetch
    // brought in the real transcript entry.
    for (const m of pendingUserMessages) {
      if (isPendingConfirmed(summary, m)) continue
      base.push({ kind: 'user', id: m.id, text: m.text, pending: true })
    }
    if (pendingAsk) {
      base.push({
        kind: 'ask',
        id: `ask-${pendingAsk.toolCallId}`,
        toolCallId: pendingAsk.toolCallId,
        questions: (pendingAsk.questions as AskUserQuestion[]) ?? [],
        agentRole: pendingAsk.agentRole,
      })
    }
    return base
  }, [summary, team, pendingUserMessages, pendingAsk, t])

  // Every URL the session's workers actually web-searched or web-fetched —
  // passed through context to the Markdown component so the `a` renderer
  // can tag unverified links (i.e. links the Lead wrote in prose that the
  // workers never touched) with a warning indicator. Recomputed only when
  // the source set changes — NOT on every token stream tick.
  const verifiedUrls = useMemo(() => collectVerifiedUrls(chat), [chat])

  // Once the server transcript catches up with a pending bubble, drop it
  // from state so it doesn't linger as a stale entry.
  useEffect(() => {
    if (!summary || pendingUserMessages.length === 0) return
    const next = pendingUserMessages.filter(
      (m) => !isPendingConfirmed(summary, m),
    )
    if (next.length !== pendingUserMessages.length) {
      setPendingUserMessages(next)
    }
  }, [summary, pendingUserMessages])

  async function sendMessage(raw: string) {
    const text = raw.trim()
    if (!text || !id || sending) return
    const now = Date.now()
    const localId = `pending-${now}`
    // Force the optimistic bubble to paint this frame — otherwise React
    // batches these sets with the subsequent setSummary/refetch work and
    // the user perceives a ~1s gap before their message appears.
    flushSync(() => {
      setPendingUserMessages((prev) => [
        ...prev,
        { id: localId, text, createdAt: now },
      ])
      setSending(true)
      setSendError(null)
    })
    // After the optimistic bubble is committed, force scroll to bottom so the
    // user always sees their just-sent message — the chat-length useEffect
    // can race with streaming-token updates and skip the jump otherwise.
    scrollChatToBottom()
    requestAnimationFrame(scrollChatToBottom)
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, locale: useAppStore.getState().locale }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // POST returns as soon as the engine accepts the inbox push — the
      // user_message event is written asynchronously moments later. Bump
      // streamEpoch to force the SSE effect to tear down + re-subscribe, so
      // the engine's events (user_message, tokens, agent_message) flow into
      // this client even for a previously-idle session whose first stream
      // closed on `[DONE]`. The scheduled refetches on each SSE frame will
      // swap the optimistic bubble for the real transcript entry — do NOT
      // remove it here, otherwise there's a visible gap between "POST ok"
      // and "events actually persisted".
      setStreamEpoch((n) => n + 1)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'send failed')
      // Keep the optimistic bubble so the user can see what they tried to send.
    } finally {
      setSending(false)
    }
  }

  // Auto-scroll chat to bottom whenever new items arrive OR the last
  // assistant bubble grows via streaming tokens (same bubble id, growing
  // text — chat.length alone would miss this).
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const scrollChatToBottom = useCallback(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [])
  const lastAssistantText = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      const item = chat[i]
      if (item?.kind === 'assistant') return item.text.length
      // Stop at the first non-assistant item so we don't scan the whole
      // history every token — scroll only follows the freshest turn.
      if (item?.kind === 'user' || item?.kind === 'ask') break
    }
    return 0
  }, [chat])
  useEffect(() => {
    scrollChatToBottom()
  }, [
    chat.length,
    lastAssistantText,
    aiActive,
    pendingAsk,
    sending,
    scrollChatToBottom,
  ])

  const backHref = params
    ? `/${params.companySlug}/${params.teamSlug}/tasks`
    : '/'
  const teamHomeHref = params
    ? `/${params.companySlug}/${params.teamSlug}/team`
    : '/'

  useEffect(() => {
    if (!notFound || !id) return
    useSessionsStore.getState().removeSession(id)
    useTasksStore.getState().removeSession(id)
    const timer = setTimeout(() => {
      navigate(teamHomeHref, { replace: true })
    }, 3000)
    return () => clearTimeout(timer)
  }, [id, navigate, notFound, teamHomeHref])

  if (loading && !summary) {
    return <div className="h-full w-full bg-neutral-50 dark:bg-neutral-950" />
  }

  if (notFound || !summary) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-4">
        <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-5 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="text-[14px] font-medium text-neutral-900 dark:text-neutral-100">
            {t('runDetail.notFound')}
          </div>
          <button
            type="button"
            onClick={() => navigate(teamHomeHref, { replace: true })}
            className="mt-4 inline-flex h-9 items-center justify-center rounded bg-neutral-900 px-4 text-[14px] font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {t('runDetail.newChat')}
          </button>
        </div>
      </div>
    )
  }

  // Show the "진행 중…" spinner only when the AI is actively generating.
  // A chat session's server-side status stays 'running' while idle between
  // turns, so we drive this from live engine events instead.
  const running = aiActive && !pendingAsk
  const title =
    summary.title ??
    task?.title ??
    summary.goal.split('\n')[0]?.slice(0, 80) ??
    'Session'
  const references = task?.references ?? []

  return (
    <div className="h-full w-full flex flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-12 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate(backHref)}
            aria-label={t('tasks.backToList')}
            title={t('tasks.backToList')}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {title}
          </h1>
        </div>
      </div>

      {/* Split: chat | artifacts */}
      <div className="flex-1 min-h-0 flex">
        {/* Chat column — scroll area + composer are regular flex children so
         *  the scrollbar never sits behind the input. paddingLeft keeps the
         *  chat centered to the viewport when the left sidebar collapses. */}
        <div
          className="flex-1 min-w-0 flex flex-col transition-[padding]"
          style={{ paddingLeft: chatColOffsetPx }}
        >
          <div
            ref={chatScrollRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-quiet"
          >
            <div className="max-w-[760px] mx-auto px-6 pt-6 pb-4 space-y-4">
              <VerifiedUrlsContext.Provider value={verifiedUrls}>
              {(() => {
                // Pending user bubbles (typed while a previous turn is still
                // running, server hasn't confirmed yet) render BELOW the
                // loading spinner. Once the transcript catches up they leave
                // `pendingUserMessages` and reappear above the spinner via
                // the normal chat flow.
                const main: typeof chat = []
                const queued: typeof chat = []
                for (const item of chat) {
                  if (item.kind === 'user' && item.pending) queued.push(item)
                  else main.push(item)
                }
                return (
                  <>
                    {main.map((item) => {
                      if (item.kind === 'ask') {
                        return (
                          <AskInlineCard
                            key={item.id}
                            questions={item.questions}
                            agentRole={item.agentRole}
                            onSubmit={submitAnswers}
                            onSkip={skipAsk}
                            busy={answerBusy}
                          />
                        )
                      }
                      return <ChatBubble key={item.id} item={item} />
                    })}
                    {running && (
                      <div className="flex items-center px-1 text-neutral-400">
                        <CircleNotch
                          className="w-4 h-4 animate-spin"
                          weight="bold"
                        />
                      </div>
                    )}
                    {queued.map((item) => (
                      <ChatBubble key={item.id} item={item} />
                    ))}
                  </>
                )
              })()}
              </VerifiedUrlsContext.Provider>
              <div ref={chatEndRef} />
            </div>
          </div>
          <div className="shrink-0 px-6 pb-4">
            <div className="max-w-[760px] mx-auto">
              {sendError && (
                <div className="mb-2 text-[12px] text-red-600">
                  {t('runDetail.sendFailed', { error: sendError })}
                </div>
              )}
              <Composer sending={sending} onSend={sendMessage} />
            </div>
          </div>
        </div>

        {/* Artifacts column */}
        <aside className="w-[272px] shrink-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-quiet px-3 py-4 space-y-3">
            {/* Artifacts — hide sidecar helpers (e.g. pdf's .spec.json)
             *  so the count/list match what the user actually cares about. */}
            {(() => {
              const visibleArtifacts = partitionArtifacts(summary.artifacts).visible
              return (
            <SidePanel
              icon={<FileText className="w-4 h-4" />}
              title={t('session.artifactsTitle')}
              count={visibleArtifacts.length}
            >
              {visibleArtifacts.length === 0 ? (
                <EmptyNote>{t('session.artifactsEmpty')}</EmptyNote>
              ) : (
                <ul className="space-y-0.5">
                  {visibleArtifacts.map((a) => (
                    <li key={a.id}>
                      <a
                        href={`/api/artifacts/${encodeURIComponent(a.id)}/download`}
                        download
                        className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                      >
                        <FileText className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="flex-1 truncate">{a.filename}</span>
                        <DownloadSimple className="w-3.5 h-3.5 text-neutral-400 opacity-0 group-hover:opacity-100 shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>
              )
            })()}

            {/* References */}
            <SidePanel
              icon={<Paperclip className="w-4 h-4" />}
              title={t('session.referencesTitle')}
              count={references.length}
            >
              {references.length === 0 ? (
                <EmptyNote>{t('session.referencesEmpty')}</EmptyNote>
              ) : (
                <ul className="space-y-0.5">
                  {references.map((ref) => (
                    <li
                      key={ref.id}
                      className="px-2 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                    >
                      <div className="flex items-center gap-2 text-[13px] text-neutral-700 dark:text-neutral-300">
                        <FileText className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="flex-1 truncate">{ref.name}</span>
                        <span className="text-[11px] text-neutral-400 font-mono shrink-0">
                          {fmtBytes(ref.size)}
                        </span>
                      </div>
                      {ref.note && (
                        <div className="mt-0.5 ml-5 text-[11.5px] text-neutral-500 italic leading-snug">
                          {ref.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>

            {/* Usage */}
            <SidePanel
              icon={<Coins className="w-4 h-4" />}
              title={t('session.usageTitle')}
            >
              {!summary.usage || summary.usage.n === 0 ? (
                <EmptyNote>{t('session.usageEmpty')}</EmptyNote>
              ) : (
                <div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <TokenStat label="in" value={fmtK(summary.usage.input_tokens)} />
                    <TokenStat label="out" value={fmtK(summary.usage.output_tokens)} />
                    <TokenStat label="cache read" value={fmtK(summary.usage.cache_read)} />
                    <TokenStat label="cache write" value={fmtK(summary.usage.cache_write)} />
                  </div>
                  {summary.usage.cost_cents > 0 && (
                    <div className="mt-3 pt-3 border-t border-neutral-200/70 dark:border-neutral-800/70 flex items-baseline justify-between">
                      <span className="text-[12px] text-neutral-500">
                        {t('session.costLabel')}
                      </span>
                      <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 font-mono">
                        ${(summary.usage.cost_cents / 100).toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </SidePanel>
          </div>
        </aside>
      </div>

    </div>
  )
}

function SidePanel({
  icon,
  title,
  count,
  collapsible = true,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode
  title: string
  count?: number
  collapsible?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const expanded = collapsible ? open : true
  return (
    <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/50 px-3.5 py-3">
      <header
        className={`flex items-center gap-2 ${expanded ? 'mb-2.5' : ''} ${
          collapsible ? 'cursor-pointer select-none' : ''
        }`}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        role={collapsible ? 'button' : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen((v) => !v)
                }
              }
            : undefined
        }
      >
        <span className="text-neutral-500 dark:text-neutral-400">{icon}</span>
        <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200">
          {title}
        </span>
        {typeof count === 'number' && count > 0 && (
          <span className="text-[11px] font-mono text-neutral-400 tabular-nums">
            {count}
          </span>
        )}
        {collapsible && (
          <CaretDown
            className={`ml-auto w-3.5 h-3.5 text-neutral-400 transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
        )}
      </header>
      {expanded && (
        <div className="max-h-[320px] overflow-y-auto overscroll-contain scrollbar-quiet">
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * Claude-Desktop-style file attachment stack — rendered BELOW the assistant
 * prose. Each card is a horizontal row: icon · filename + type label ·
 * size · download affordance. Clicking anywhere on the card downloads via
 * /api/artifacts/{id}/download.
 */
function AttachmentStack({ attachments }: { attachments: SessionArtifact[] }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {attachments.map((a) => (
        <AttachmentCard key={a.id} artifact={a} />
      ))}
    </div>
  )
}

const ATTACHMENT_TYPE_KEYS: Record<string, string> = {
  pdf: 'attachment.type.pdf',
  docx: 'attachment.type.docx',
  pptx: 'attachment.type.pptx',
  xlsx: 'attachment.type.xlsx',
  md: 'attachment.type.md',
  txt: 'attachment.type.txt',
  json: 'attachment.type.json',
  csv: 'attachment.type.csv',
  html: 'attachment.type.html',
  png: 'attachment.type.png',
  jpg: 'attachment.type.jpg',
  jpeg: 'attachment.type.jpeg',
  gif: 'attachment.type.gif',
  webp: 'attachment.type.webp',
  svg: 'attachment.type.svg',
}

function AttachmentCard({ artifact }: { artifact: SessionArtifact }) {
  const t = useT()
  const ext = (artifact.filename.split('.').pop() ?? '').toLowerCase()
  const typeKey = ATTACHMENT_TYPE_KEYS[ext]
  const typeLabel = typeKey
    ? t(typeKey)
    : ext
      ? t('attachment.type.fileWith', { ext: ext.toUpperCase() })
      : t('attachment.type.file')
  const size = fmtBytes(artifact.size)
  const downloadUrl = `/api/artifacts/${artifact.id}/download`
  return (
    <a
      href={downloadUrl}
      download={artifact.filename}
      className="group/card flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 px-3.5 py-3 w-full hover:bg-neutral-100 dark:hover:bg-neutral-800/80 transition-colors no-underline"
      title={`Download ${artifact.filename}`}
    >
      <span
        className="shrink-0 w-10 h-10 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 flex items-center justify-center"
        aria-hidden
      >
        <FileText className="w-5 h-5 text-neutral-500" />
      </span>
      <span className="flex-1 min-w-0 leading-tight">
        <span className="block font-semibold text-[14px] text-neutral-900 dark:text-neutral-100 truncate group-hover/card:underline">
          {artifact.filename}
        </span>
        <span className="block text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5">
          {typeLabel}
          {size ? ` · ${size}` : ''}
        </span>
      </span>
      <span
        className="shrink-0 p-1.5 rounded-md text-neutral-400 group-hover/card:text-neutral-700 group-hover/card:bg-neutral-200 dark:group-hover/card:text-neutral-200 dark:group-hover/card:bg-neutral-700"
        aria-hidden
      >
        <DownloadSimple className="w-4 h-4" />
      </span>
    </a>
  )
}

/**
 * Collapsible bar that stands in for a run of 2+ consecutive tool chips.
 * Collapsed: "진행 내역 N개 ∨". Expanded: the original chip list with a
 * left rail connecting line, so a long research turn doesn't bury the
 * assistant's actual answer under 20 vertical rows.
 *
 * Wording is intentionally neutral ("진행 내역" / "N steps") rather than
 * Claude Desktop's "명령 N개 실행함" — OpenHive tool steps aren't always
 * shell commands (delegation, ask_user, artifact reads, etc.). Swap the
 * i18n value when a better word surfaces.
 */
/** Within a tool_group's expanded list, fold runs of ≥2 consecutive
 *  web-fetch sources items into a single horizontal favicon strip. A long
 *  research turn that fetches 8 pages becomes one compact row instead of
 *  8 individual chips. Lone fetches (1 in a row) keep their normal
 *  SourceCard render so they don't lose their click affordance. */
type GroupSlot =
  | { kind: 'item'; key: string; item: Extract<ChatItem, { kind: 'tool_group' }>['items'][number] }
  | { kind: 'fetch_strip'; key: string; sources: ChatSource[] }

function partitionGroupItems(
  items: Extract<ChatItem, { kind: 'tool_group' }>['items'],
): GroupSlot[] {
  const out: GroupSlot[] = []
  let run: { id: string; source: ChatSource }[] = []
  const flush = () => {
    if (run.length >= 2) {
      out.push({
        kind: 'fetch_strip',
        key: `strip-${run[0]!.id}`,
        sources: run.map((r) => r.source),
      })
    } else if (run.length === 1) {
      const r = run[0]!
      out.push({
        kind: 'item',
        key: r.id,
        item: {
          kind: 'sources',
          id: r.id,
          author: '',
          variant: 'fetch',
          query: r.source.url,
          sources: [r.source],
          depth: 0,
          nodeId: '',
        },
      })
    }
    run = []
  }
  for (const it of items) {
    if (
      it.kind === 'sources' &&
      it.variant === 'fetch' &&
      it.sources.length === 1
    ) {
      run.push({ id: it.id, source: it.sources[0]! })
      continue
    }
    flush()
    out.push({ kind: 'item', key: it.id, item: it })
  }
  flush()
  return out
}

/** Collapsible bundle for ≥2 consecutive web-fetch calls. Header shows
 *  the count; clicking expands a vertical list of full URL rows
 *  (favicon + URL + extlink). Keeps the chat scannable when an agent
 *  fetches 8+ pages in a row instead of dumping a wall of URLs. */
/** Same idea as partitionGroupItems, but for the children-list inside a
 *  delegate dropdown. Sub-agent fetches were rendering as a long flat
 *  URL wall — fold consecutive ≥2 fetch sources into the collapsible
 *  FetchStrip so a research delegation reads as "search · search · 9
 *  fetched ⌄". */
type NestedSlot =
  | { kind: 'item'; key: string; item: NestableChild }
  | { kind: 'fetch_strip'; key: string; sources: ChatSource[] }

function partitionNestedChildren(items: NestableChild[]): NestedSlot[] {
  const out: NestedSlot[] = []
  let run: { id: string; source: ChatSource }[] = []
  const flush = () => {
    if (run.length >= 2) {
      out.push({
        kind: 'fetch_strip',
        key: `strip-${run[0]!.id}`,
        sources: run.map((r) => r.source),
      })
    } else if (run.length === 1) {
      const r = run[0]!
      out.push({
        kind: 'item',
        key: r.id,
        item: {
          kind: 'sources',
          id: r.id,
          author: '',
          variant: 'fetch',
          query: r.source.url,
          sources: [r.source],
          depth: 0,
          nodeId: '',
        },
      })
    }
    run = []
  }
  for (const it of items) {
    if (
      it.kind === 'sources' &&
      it.variant === 'fetch' &&
      it.sources.length === 1
    ) {
      run.push({ id: it.id, source: it.sources[0]! })
      continue
    }
    flush()
    out.push({ kind: 'item', key: it.id, item: it })
  }
  flush()
  return out
}

function FetchStrip({ sources }: { sources: ChatSource[] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400 font-mono hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
      >
        <Article className="w-3 h-3 shrink-0 opacity-60" />
        <span className="text-neutral-600 dark:text-neutral-300 shrink-0">
          web-fetch
        </span>
        <span className="text-neutral-400 dark:text-neutral-500 shrink-0">
          · {sources.length}
        </span>
        <CaretDown
          className={`w-3 h-3 shrink-0 opacity-50 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <ul className="mt-2 ml-[7px] pl-3 border-l border-neutral-200 dark:border-neutral-800 flex flex-col gap-1.5">
          {sources.map((s, i) => (
            <li key={`${i}-${s.url}`}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.url}
                className="group inline-flex max-w-full items-center gap-2 text-[12.5px] font-mono text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                <SourceFavicon domain={s.domain} />
                <span className="truncate min-w-0">{s.url}</span>
                <ArrowSquareOut className="w-3 h-3 shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** If every tool step in the group is one of the four skill-related
 *  tools, return the unique skill name(s) used. We hide all the per-step
 *  noise behind a single "X 스킬 사용" line in that case — the user
 *  explicitly asked for a one-line summary, not the full trace.
 *
 *  Returns null if the group has any non-skill step (delegations, web
 *  fetches, ask_user, etc.) so those still get the expandable list. */
function summarizeSkillRun(
  group: Extract<ChatItem, { kind: 'tool_group' }>,
): string[] | null {
  const skillTools = new Set([
    'activate_skill',
    'list_skill_files',
    'read_skill_file',
    'run_skill_script',
  ])
  const names: string[] = []
  for (const it of group.items) {
    if (it.kind !== 'tool') return null
    if (!skillTools.has(it.tool)) return null
    const name = it.skillName
    if (name && !names.includes(name)) names.push(name)
  }
  return names.length ? names : null
}

function ToolGroupBar({
  group,
}: {
  group: Extract<ChatItem, { kind: 'tool_group' }>
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  // Skill-only group → single static line, no expand.
  const skillNames = summarizeSkillRun(group)
  if (skillNames) {
    const label =
      skillNames.length === 1
        ? t('session.tool.skillUsed', { name: skillNames[0]! })
        : t('session.tool.skillsUsed', { names: skillNames.join(', ') })
    return (
      <div className="inline-flex items-center gap-1.5 text-[13px] text-neutral-500 dark:text-neutral-400">
        <Wrench className="w-3.5 h-3.5 shrink-0 opacity-60" />
        <span className="font-medium">{label}</span>
      </div>
    )
  }

  const label = t('session.tool.groupLabel', { count: group.items.length })
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={
          expanded ? t('session.tool.groupCollapse') : t('session.tool.groupExpand')
        }
        className="group inline-flex items-center gap-1.5 text-[13px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 shrink-0 opacity-60" />
        <span className="font-medium">{label}</span>
        <CaretDown
          className={`w-3 h-3 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <ul className="mt-2 ml-[7px] pl-3 border-l border-neutral-200 dark:border-neutral-800 flex flex-col gap-1.5">
          {partitionGroupItems(group.items).map((slot) => (
            <li key={slot.key} className="flex">
              {slot.kind === 'fetch_strip' ? (
                <FetchStrip sources={slot.sources} />
              ) : slot.item.kind === 'tool' ? (
                <ToolChip
                  tool={slot.item.tool}
                  summary={slot.item.summary}
                  delegate={slot.item.delegate}
                  todo={slot.item.todo}
                  children={slot.item.children}
                  errorCode={slot.item.errorCode}
                  errorMessage={slot.item.errorMessage}
                />
              ) : (
                <div className="w-full">
                  <SourceCard
                    variant={slot.item.variant}
                    query={slot.item.query}
                    sources={slot.item.sources}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Source pill for web-search / web-fetch — visually the same compact
 *  tool-chip shape as a failed `web-search` (wrench pill), but with a caret
 *  indicating it's expandable. Click to drop a list of favicon-titled rows
 *  below the pill, each linking to the source URL in a new tab. Keeping the
 *  collapsed pill identical to the tool-chip shape makes the chat feel like
 *  one consistent "step" stream rather than a mix of pills + bordered cards. */
/** Source pill for web-search / web-fetch.
 *
 *  - `web-search` renders as a pill chip identical to the other step
 *    chips (same border, same `font-mono` text, same height). Clicking
 *    expands the result list under a left-rail indent.
 *  - `web-fetch` renders as a single clickable URL row — no "web-fetch"
 *    prefix, no count, no dropdown. Web-fetch always has exactly one
 *    source (the page itself), so the dropdown adds no value; we just
 *    show the link directly with favicon + URL + domain + external icon.
 *
 *  Layout details for the search pill:
 *  - Pill stays on ONE line — query is truncated with `min-w-0 truncate`.
 *    Count badge and caret are `shrink-0` so they never wrap below the
 *    query.
 *  - `inline-flex` + `max-w-full` so the pill grows to fit short queries
 *    but never overflows the chat column on long ones. */
function SourceCard({
  variant,
  query,
  sources,
}: {
  variant: 'search' | 'fetch'
  query: string
  sources: ChatSource[]
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const count = sources.length

  if (variant === 'fetch') {
    // web-fetch === one source. Render the URL inline as a single
    // clickable row: favicon + full URL + external-link icon. Keeps the
    // chat scannable ("which page did the agent read?") without forcing
    // the user to hover every chip to see the target.
    const s = sources[0]
    if (!s) return null
    return (
      <a
        href={s.url}
        target="_blank"
        rel="noopener noreferrer"
        title={s.url}
        className="group inline-flex max-w-full items-center gap-2 text-[12.5px] font-mono text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
      >
        <SourceFavicon domain={s.domain} />
        <span className="truncate min-w-0">{s.url}</span>
        <ArrowSquareOut className="w-3 h-3 shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
      </a>
    )
  }

  const toolName = 'web-search'
  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400 font-mono hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
      >
        <MagnifyingGlass className="w-3 h-3 shrink-0 opacity-60" />
        <span className="text-neutral-600 dark:text-neutral-300 shrink-0">
          {toolName}
        </span>
        {query && (
          <span className="text-neutral-600 dark:text-neutral-300 truncate min-w-0">
            {variant === 'search' ? `"${query}"` : query}
          </span>
        )}
        <span className="text-neutral-400 dark:text-neutral-500 shrink-0">
          · {t('session.sources.count', { count })}
        </span>
        <CaretDown
          className={`w-3 h-3 shrink-0 opacity-50 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <ul className="mt-2 ml-[7px] pl-3 border-l border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-200/70 dark:divide-neutral-800/70">
          {sources.map((s, i) => (
            <li key={`${i}-${s.url}`}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-2.5 py-2 hover:bg-neutral-100/60 dark:hover:bg-neutral-900/60 transition-colors"
              >
                <SourceFavicon domain={s.domain} />
                <span className="text-[13px] text-neutral-800 dark:text-neutral-200 truncate flex-1 min-w-0">
                  {s.title}
                </span>
                <span className="text-[11.5px] text-neutral-400 dark:text-neutral-500 shrink-0 max-w-[35%] truncate">
                  {s.domain}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 16px favicon with a graceful fallback (grey globe) when the image
 *  doesn't load — some domains block Google's favicon service or have
 *  none at all. */
function SourceFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false)
  if (!domain || failed) {
    return (
      <span className="w-4 h-4 shrink-0 rounded-sm bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center">
        <Globe className="w-2.5 h-2.5 text-neutral-400" />
      </span>
    )
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-4 h-4 shrink-0 rounded-sm"
    />
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="text-[12.5px] text-neutral-400 leading-relaxed">
      {children}
    </div>
  )
}

function TokenStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      <span className="text-[13px] font-mono tabular-nums text-neutral-900 dark:text-neutral-100">
        {value}
      </span>
    </div>
  )
}

interface Attachment {
  id: string
  file: File
}

function readFileAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = reader.result
      resolve(typeof r === 'string' ? r : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsText(file)
  })
}

function isLikelyText(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  const textishExt = /\.(md|txt|csv|tsv|json|ya?ml|toml|ini|log|xml|html?|css|js|tsx?|jsx?|py|rb|go|rs|java|sh|sql)$/i
  return textishExt.test(file.name)
}

function fmtFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Isolated composer — holds its own text state so typing doesn't re-render
 *  the whole chat (markdown rendering on every keystroke was the source of
 *  the "text appears half a beat late" feel). */
const Composer = memo(function Composer({
  sending,
  onSend,
}: {
  sending: boolean
  onSend: (text: string) => void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const disabled = sending || (!text.trim() && attachments.length === 0)

  // Auto-grow textarea to content height, clamp at MAX, hide scrollbar until
  // we actually overflow. (Relying on CSS max-height alone still paints the
  // scrollbar for a tick because scrollHeight includes padding.)
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const MAX = 240
    ta.style.height = 'auto'
    const next = Math.min(ta.scrollHeight, MAX)
    ta.style.height = `${next}px`
    ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden'
  }, [text])

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: Attachment[] = []
    for (const f of Array.from(files)) {
      next.push({ id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, file: f })
    }
    setAttachments((prev) => [...prev, ...next])
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const submit = async () => {
    const body = text.trim()
    if (sending) return
    if (!body && attachments.length === 0) return

    // Inline attachments into the message so the backend POST stays simple —
    // text files get their content, binaries get a short marker.
    const parts: string[] = []
    if (body) parts.push(body)
    for (const a of attachments) {
      if (isLikelyText(a.file)) {
        const content = await readFileAsText(a.file)
        parts.push(
          `--- 첨부파일: ${a.file.name} (${fmtFileSize(a.file.size)}) ---\n${content ?? ''}`,
        )
      } else {
        parts.push(
          `--- 첨부파일: ${a.file.name} (${fmtFileSize(a.file.size)}, 바이너리) ---`,
        )
      }
    }
    const combined = parts.join('\n\n')
    if (!combined.trim()) return

    onSend(combined)
    setText('')
    setAttachments([])
    // Send button steals focus on click; Enter submits don't blur but a parent
    // re-render mid-send can. Either way, keep the user typing.
    textareaRef.current?.focus()
  }

  return (
    <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 pt-2.5 pb-2 focus-within:border-neutral-400 dark:focus-within:border-neutral-600">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800 text-[12px] text-neutral-700 dark:text-neutral-300"
            >
              <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="max-w-[180px] truncate">{a.file.name}</span>
              <span className="text-[10.5px] font-mono text-neutral-400 shrink-0">
                {fmtFileSize(a.file.size)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={t('common.removeAttachment')}
                className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={t('chatPage.composerPlaceholder')}
        rows={1}
        autoFocus
        className="w-full resize-none bg-transparent text-[15.5px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 outline-none max-h-60 py-0.5 leading-relaxed scrollbar-quiet"
      />

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={t('common.attachFile')}
            title={t('common.attachFile')}
            className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled}
          className="shrink-0 w-8 h-8 rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neutral-800 dark:hover:bg-neutral-200"
          aria-label={t('chatPage.send')}
        >
          <ArrowUp className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  )
})

/** Inline placeholder rendered when the Lead cites a URL that wasn't
 *  actually fetched or searched this session. We don't show the raw URL
 *  (it's dead-end traffic for the user — often 404) and we don't warn
 *  prominently either — we quietly redact it with a muted marker so the
 *  surrounding markdown structure (bullet lists, numbered lists) stays
 *  intact. Tooltip explains for curious users. */
function UnverifiedUrlRedacted() {
  const t = useT()
  return (
    <span
      title={t('session.links.unverifiedTitle')}
      aria-label={t('session.links.unverifiedTitle')}
      className="text-neutral-400 dark:text-neutral-500 italic cursor-help select-none text-[13px]"
    >
      [{t('session.links.unverifiedShort')}]
    </span>
  )
}

const Markdown = memo(function MarkdownInner({ text }: { text: string }) {
  const verifiedUrls = useContext(VerifiedUrlsContext)
  const t = useT()
  // Terse chat-friendly prose styling. Headings are dialed down (h1/h2 look
  // oversized in a bubble), lists keep their markers, code blocks get a
  // subtle surface, links are underlined on hover.
  //
  // Memoised: ReactMarkdown re-parses the entire text on every render.
  // Without memo, every token delta on any chat bubble causes ALL assistant
  // bubbles to re-parse — visible stutter on long messages. React.memo's
  // default shallow equality on `{text}` is sufficient here.
  return (
    <div className="space-y-2 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown's default urlTransform only allows http/https/mailto/tel
        // — any other scheme (including our `artifact://session/{id}/artifacts/*`
        // deep links) gets rewritten to an empty string BEFORE the `a` component
        // mapper runs. That's why agent-generated [report.pdf](artifact://…)
        // links were rendering as dead `<a href="">`. We preserve the default
        // safety filter for everything else and only whitelist `artifact:`.
        urlTransform={(url) =>
          url.startsWith('artifact://') ? url : defaultUrlTransform(url)
        }
        components={{
          h1: ({ children }) => (
            <h1 className="text-[19px] font-semibold mt-3 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[17.5px] font-semibold mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[16px] font-semibold mt-2.5 mb-1.5">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[15.5px] font-semibold mt-2 mb-1">{children}</h4>
          ),
          p: ({ children }) => (
            <p className="text-[15.5px] leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1 text-[15.5px]">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1 text-[15.5px]">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => {
            // `artifact://` links are now rendered by AttachmentStack at the
            // END of the assistant bubble (Claude-Desktop style). Inline
            // occurrences of the filename in the body are stripped of their
            // link affordance — the UI already tells the user "here is the
            // file" via the card stack, so the inline mention should read
            // as plain prose text.
            if (href && href.startsWith('artifact://')) {
              return <span>{children}</span>
            }
            // http(s) link verification: compare the href against URLs the
            // workers actually web-fetched/web-searched this session. If the
            // href's host+path doesn't match any entry in the verified set,
            // the Lead likely hallucinated it (observed production bug —
            // bare-domain / guessed-path citations in session d5407a19).
            // Internal/non-http hrefs bypass the check entirely.
            const isHttp =
              typeof href === 'string' &&
              (href.startsWith('http://') || href.startsWith('https://'))
            const hrefKey = isHttp ? normalizeUrlForVerification(href) : ''
            const isUnverified =
              isHttp &&
              verifiedUrls.size > 0 &&
              hrefKey !== '' &&
              !verifiedUrls.has(hrefKey)
            if (isUnverified) {
              // Redact: unverified URLs are almost always dead ends for the
              // reader (404 / nxdomain). If the link has a meaningful label
              // different from the URL, keep the label as plain text so the
              // prose still reads. If the label IS the URL (bare citation),
              // swap in a muted "[unverified · redacted]" placeholder so
              // list structure survives but the broken URL isn't offered.
              const label = Array.isArray(children) ? children : [children]
              const asString = label
                .map((c) => (typeof c === 'string' ? c : ''))
                .join('')
                .trim()
              const labelIsBareUrl =
                asString.length > 0 &&
                (asString === href ||
                  (isHttp && normalizeUrlForVerification(asString) === hrefKey))
              if (labelIsBareUrl || asString.length === 0) {
                return <UnverifiedUrlRedacted />
              }
              return (
                <span
                  className="text-neutral-600 dark:text-neutral-400"
                  title={t('session.links.unverifiedTitle')}
                >
                  {children}
                </span>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-blue-600 break-all"
              >
                {children}
              </a>
            )
          },
          code: ({ className, children, ...props }) => {
            const isBlock = (props as { node?: { tagName?: string } }).node?.tagName
            void isBlock
            const inline = !className
            if (inline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[14px]">
                  {children}
                </code>
              )
            }
            return (
              <code className={`font-mono text-[14px] ${className ?? ''}`}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-neutral-100 dark:bg-neutral-800 p-3.5 text-[14px] font-mono leading-relaxed">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-300 dark:border-neutral-700 pl-3 text-neutral-600 dark:text-neutral-400">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-neutral-200 dark:border-neutral-800 my-3" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-[14.5px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-neutral-200 dark:border-neutral-800 px-2 py-1">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

// Strip inlined attachment blocks ("--- 첨부파일: name (size) ---\n<body>")
// from user messages before copying. Composer.submit() joins the body and
// each attachment part with `\n\n`, and every attachment part begins with
// this exact Korean marker — so cutting at the first `\n\n--- 첨부파일:`
// drops the marker line, any inlined file contents, and all subsequent
// attachments in one go.
const ATTACHMENT_MARKER_RE = /\n\n--- 첨부파일: [\s\S]*$/
// Replace `[label](artifact://...)` with just `label` — the UI already
// renders these as plain text (not a link), and the URI exposes internal
// session paths the user shouldn't see on paste.
const ARTIFACT_LINK_RE = /\[([^\]]+)\]\(artifact:\/\/[^)]+\)/g

function textForCopy(item: ChatItem): string {
  if (item.kind === 'user') {
    return item.text.replace(ATTACHMENT_MARKER_RE, '').trimEnd()
  }
  if (item.kind === 'assistant') {
    return item.text.replace(ARTIFACT_LINK_RE, '$1').trimEnd()
  }
  return ''
}

function CopyButton({
  getText,
  className,
}: {
  getText: () => string
  className?: string
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    const text = getText()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — fail silently */
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? t('session.copied') : t('session.copyMessage')}
      title={copied ? t('session.copied') : t('session.copyMessage')}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 dark:hover:text-neutral-200 dark:hover:bg-neutral-800 transition-colors ${className ?? ''}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

const ChatBubble = memo(
  function ChatBubbleInner({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    const canCopy = !item.pending && item.text.length > 0
    return (
      <div className="group flex flex-col items-end">
        <div
          className={`max-w-[80%] rounded-2xl rounded-br-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100 px-4 py-3 text-[15.5px] whitespace-pre-wrap leading-relaxed ${
            item.pending ? 'opacity-60' : ''
          }`}
        >
          {item.text}
        </div>
        {canCopy && (
          <div className="mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton getText={() => textForCopy(item)} />
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    const canCopy = item.text.length > 0
    return (
      <div className="group text-[15.5px] text-neutral-900 dark:text-neutral-100 leading-relaxed">
        <Markdown text={item.text} />
        {item.attachments.length > 0 && (
          <AttachmentStack attachments={item.attachments} />
        )}
        {canCopy && (
          <div className="mt-1 -ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton getText={() => textForCopy(item)} />
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'tool') {
    return (
      <ToolChip
        tool={item.tool}
        summary={item.summary}
        delegate={item.delegate}
        todo={item.todo}
        children={item.children}
        errorCode={item.errorCode}
        errorMessage={item.errorMessage}
      />
    )
  }
  if (item.kind === 'tool_group') {
    return <ToolGroupBar group={item} />
  }
  if (item.kind === 'sources') {
    return (
      <SourceCard
        variant={item.variant}
        query={item.query}
        sources={item.sources}
      />
    )
  }
  if (item.kind === 'ask') {
    // Handled inline at the map site where submit/skip callbacks live.
    return null
  }
  // error
  return (
    <div className="flex gap-2.5">
      <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center shrink-0">
        <Warning className="w-3.5 h-3.5 text-red-600" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-sm bg-red-50 border border-red-200 text-red-700 px-3.5 py-2.5 text-[13px] whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    </div>
  )
  },
  // Re-render only when THIS bubble's content changed. Without this, every
  // token arriving on any bubble re-renders every other bubble, causing
  // ReactMarkdown to re-parse long assistant messages on each keystroke-
  // equivalent — visible stutter on responses >1KB.
  (prev, next) => {
    const a = prev.item
    const b = next.item
    if (a === b) return true
    if (a.kind !== b.kind || a.id !== b.id) return false
    if (a.kind === 'user' && b.kind === 'user') {
      return a.text === b.text && a.pending === b.pending
    }
    if (a.kind === 'assistant' && b.kind === 'assistant') {
      if (a.text !== b.text) return false
      // Cheap attachment-set equality — the list is usually 0-6 items; we only
      // care that identities and order match. The parent recomputes the array
      // from summary.artifacts every poll so reference inequality is expected
      // even when content is identical — compare by id instead.
      if (a.attachments.length !== b.attachments.length) return false
      for (let i = 0; i < a.attachments.length; i++) {
        if (a.attachments[i]!.id !== b.attachments[i]!.id) return false
      }
      return true
    }
    if (a.kind === 'tool' && b.kind === 'tool') {
      if (a.summary !== b.summary) return false
      // Delegation chips (delegate_to / delegate_parallel) carry a `children`
      // array that GROWS over time as the sub-agent does work. The `summary`
      // string ("↘ delegating to Member") stays constant while children
      // accumulate, so comparing summary alone left these chips frozen until
      // a hard refresh — the UI's "must refresh to see updates" symptom.
      // Compare children identities + each child's own work-state proxy
      // (its summary or sources count) so re-renders fire as work progresses.
      const ac = a.children ?? []
      const bc = b.children ?? []
      if (ac.length !== bc.length) return false
      for (let i = 0; i < ac.length; i++) {
        const x = ac[i]!
        const y = bc[i]!
        if (x.kind !== y.kind || x.id !== y.id) return false
        if (x.kind === 'tool' && y.kind === 'tool') {
          if (x.summary !== y.summary) return false
          // One level of recursion — sub-sub work shows as length growth here.
          if ((x.children?.length ?? 0) !== (y.children?.length ?? 0)) return false
        } else if (x.kind === 'sources' && y.kind === 'sources') {
          if (x.sources.length !== y.sources.length) return false
        }
      }
      // delegate.tasks is set at chip creation; a re-render shouldn't change
      // it, but compare length defensively for delegate_parallel expansions.
      if ((a.delegate?.tasks.length ?? 0) !== (b.delegate?.tasks.length ?? 0)) return false
      return true
    }
    if (a.kind === 'tool_group' && b.kind === 'tool_group') {
      if (a.items.length !== b.items.length) return false
      for (let i = 0; i < a.items.length; i++) {
        const ai = a.items[i]!
        const bi = b.items[i]!
        if (ai.kind !== bi.kind) return false
        if (ai.kind === 'tool' && bi.kind === 'tool') {
          if (ai.summary !== bi.summary) return false
        } else if (ai.kind === 'sources' && bi.kind === 'sources') {
          if (ai.variant !== bi.variant) return false
          if (ai.sources.length !== bi.sources.length) return false
          for (let j = 0; j < ai.sources.length; j++) {
            if (ai.sources[j]!.url !== bi.sources[j]!.url) return false
          }
        }
      }
      return true
    }
    if (a.kind === 'sources' && b.kind === 'sources') {
      if (a.variant !== b.variant) return false
      if (a.sources.length !== b.sources.length) return false
      for (let i = 0; i < a.sources.length; i++) {
        if (a.sources[i]!.url !== b.sources[i]!.url) return false
      }
      return true
    }
    if (a.kind === 'error' && b.kind === 'error') {
      return a.text === b.text
    }
    return true
  },
)
