import {
  CaretDown,
  CaretRight,
  CircleNotch,
  File as FileIcon,
  Folder,
  FolderOpen,
  Package,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { downloadAgentFrame } from '@/lib/api/agent-frames'
import { type LibraryPersona, listAgentLibrary } from '@/lib/api/agent-library'
import { type ModelInfo, listModels } from '@/lib/api/models'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { mockProviders } from '@/lib/mock/companies'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'

interface NodeEditorProps {
  agent: Agent | null
  onClose: () => void
}

const HARD_MAX_PARALLEL = 100
const modelCache: Record<string, ModelInfo[]> = {}

// --- file tree ---------------------------------------------------------------

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  isFile: boolean
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], isFile: false }
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    let cur = root
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1
      let child = cur.children.find((c) => c.name === part)
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
          isFile: isLast,
        }
        cur.children.push(child)
      }
      cur = child
    })
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
      return a.name.localeCompare(b.name)
    })
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

function TreeView({
  node,
  depth = 0,
  selected,
  onPick,
}: {
  node: TreeNode
  depth?: number
  selected: string | null
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  if (depth === 0) {
    return (
      <ul className="text-[12px]">
        {node.children.map((c) => (
          <TreeView
            key={c.path}
            node={c}
            depth={1}
            selected={selected}
            onPick={onPick}
          />
        ))}
      </ul>
    )
  }
  const pad = { paddingLeft: `${(depth - 1) * 14}px` }
  if (node.isFile) {
    const isSel = selected === node.path
    return (
      <li
        className={`flex items-center gap-1.5 py-0.5 font-mono text-[11.5px] cursor-pointer rounded-sm ${
          isSel ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-200/60'
        }`}
        style={pad}
      >
        <button
          type="button"
          onClick={() => onPick(node.path)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          <FileIcon
            className={`w-3.5 h-3.5 shrink-0 ${isSel ? 'text-white/80' : 'text-neutral-400'}`}
          />
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 py-0.5 text-neutral-700 hover:text-neutral-900 hover:bg-neutral-200/60 rounded-sm cursor-pointer"
        style={pad}
      >
        {open ? (
          <CaretDown className="w-3 h-3 text-neutral-400 shrink-0" />
        ) : (
          <CaretRight className="w-3 h-3 text-neutral-400 shrink-0" />
        )}
        {open ? (
          <FolderOpen className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
        )}
        <span className="text-[12px] font-medium truncate">{node.name}</span>
        <span className="ml-auto text-[10.5px] text-neutral-400 pr-1">
          {node.children.length}
        </span>
      </button>
      {open && (
        <ul>
          {node.children.map((c) => (
            <TreeView
              key={c.path}
              node={c}
              depth={depth + 1}
              selected={selected}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// --- main --------------------------------------------------------------------

export function NodeEditor({ agent, onClose }: NodeEditorProps) {
  const t = useT()
  const updateAgent = useCanvasStore((s) => s.updateAgent)
  const removeAgent = useCanvasStore((s) => s.removeAgent)
  const team = useCurrentTeam()
  const companySlug = useAppStore((s) => {
    const c = s.companies.find((x) => x.id === s.currentCompanyId)
    return c?.slug ?? ''
  })
  const incomingIds = new Set(team?.edges.map((e) => e.target) ?? [])
  const isLead = agent ? !incomingIds.has(agent.id) : false

  const [draft, setDraft] = useState<Agent | null>(agent)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [personas, setPersonas] = useState<LibraryPersona[] | null>(null)
  const [personaError, setPersonaError] = useState<string | null>(null)
  const [customPath, setCustomPath] = useState(false)
  // Which file (inside selected persona) is open in the right pane.
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  // Edits kept local-only for now — real persist wires up when the server
  // file-read/write endpoints land.
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setDraft(agent)
    setCustomPath(false)
    setSelectedFile(null)
    setFileEdits({})
    setConfirmDelete(false)
  }, [agent])

  useEscapeClose(agent, onClose)

  useEffect(() => {
    if (!agent) return
    setPersonaError(null)
    listAgentLibrary(companySlug || undefined)
      .then(setPersonas)
      .catch((e) => {
        setPersonas([])
        setPersonaError(e instanceof Error ? e.message : String(e))
      })
  }, [agent, companySlug])

  useEffect(() => {
    if (!draft || !personas) return
    if (!draft.personaPath) return
    const known = personas.some((p) => p.path === draft.personaPath)
    if (!known) setCustomPath(true)
  }, [draft, personas])

  useEffect(() => {
    if (!draft) return
    const providerId = draft.providerId
    const cached = modelCache[providerId]
    if (cached) {
      setModels(cached)
      setModelsError(null)
      return
    }
    setLoadingModels(true)
    setModelsError(null)
    listModels(providerId)
      .then((list) => {
        modelCache[providerId] = list
        setModels(list)
        setDraft((prev) => {
          if (!prev || prev.providerId !== providerId) return prev
          if (list.some((m) => m.id === prev.model)) return prev
          const fallback = list.find((m) => m.default)?.id ?? list[0]?.id
          return fallback ? { ...prev, model: fallback } : prev
        })
      })
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingModels(false))
  }, [draft?.providerId])

  const selectedPersona = useMemo<LibraryPersona | null>(() => {
    if (!personas || !draft) return null
    if (draft.personaPath) return personas.find((p) => p.path === draft.personaPath) ?? null
    if (draft.personaName) return personas.find((p) => p.name === draft.personaName) ?? null
    return null
  }, [personas, draft])

  const tree = useMemo(() => {
    if (!selectedPersona || selectedPersona.kind !== 'dir') return null
    return buildTree(selectedPersona.file_tree)
  }, [selectedPersona])

  // Reset file selection whenever the active persona changes.
  useEffect(() => {
    setSelectedFile(null)
  }, [selectedPersona?.name, selectedPersona?.path])

  if (!agent || !draft) return null

  const onChangeProvider = (providerId: string) => {
    const provider = mockProviders.find((p) => p.id === providerId)
    const cached = modelCache[providerId]
    const nextModel = cached?.find((m) => m.default)?.id ?? cached?.[0]?.id ?? draft.model
    setDraft({
      ...draft,
      providerId,
      label: provider?.label ?? draft.label,
      model: nextModel,
    })
  }

  const save = () => {
    const provider = mockProviders.find((p) => p.id === draft.providerId)
    const clampedParallel = isLead
      ? 1
      : Math.max(1, Math.min(HARD_MAX_PARALLEL, Number(draft.maxParallel ?? 1) || 1))
    updateAgent(agent.id, {
      role: draft.role,
      providerId: draft.providerId,
      label: provider?.label ?? draft.label,
      model: draft.model,
      systemPrompt: draft.systemPrompt,
      maxParallel: clampedParallel,
      personaName: draft.personaName || undefined,
      personaPath: draft.personaPath || undefined,
    })
    onClose()
  }

  const fileContent = selectedFile !== null ? fileEdits[selectedFile] ?? '' : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit agent"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="relative w-[1040px] max-w-[96vw] h-[680px] max-h-[92vh] flex flex-col rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Compact top header with identity: role / provider / model / parallel */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-neutral-200">
          <input
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            className="input !w-40 !py-1 text-[14px] font-semibold"
            placeholder="Role"
          />
          <select
            value={draft.providerId}
            onChange={(e) => onChangeProvider(e.target.value)}
            className="input !w-32 !py-1 text-[13px]"
          >
            {mockProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {loadingModels ? (
            <div className="input !w-44 !py-1 flex items-center gap-2 text-[13px] text-neutral-500">
              <CircleNotch className="w-3.5 h-3.5 animate-spin" />
              Loading…
            </div>
          ) : modelsError ? (
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              className="input !w-44 !py-1 text-[13px] font-mono"
              placeholder="model id"
            />
          ) : (
            <select
              value={models.some((m) => m.id === draft.model) ? draft.model : ''}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              className="input !w-52 !py-1 text-[13px]"
            >
              {!models.some((m) => m.id === draft.model) && draft.model && (
                <option value="">{draft.model} (not in list)</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.default ? ' · default' : ''}
                </option>
              ))}
            </select>
          )}
          {!isLead && (
            <label className="flex items-center gap-1.5 text-[12px] text-neutral-500">
              <span>Parallel</span>
              <input
                type="number"
                min={1}
                max={HARD_MAX_PARALLEL}
                value={draft.maxParallel ?? 1}
                onChange={(e) =>
                  setDraft({ ...draft, maxParallel: Number(e.target.value) || 1 })
                }
                className="input !w-16 !py-1 font-mono text-[13px]"
              />
            </label>
          )}
          <div className="ml-auto">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-sm hover:bg-neutral-100"
            >
              <X className="w-4 h-4 text-neutral-500" />
            </button>
          </div>
        </div>

        {/* Main split: LEFT reference, RIGHT file viewer/editor */}
        <div className="flex-1 flex min-h-0">
          {/* LEFT: this agent's own file tree */}
          <div className="w-[340px] shrink-0 flex flex-col min-h-0 bg-neutral-50/60 border-r border-neutral-200">
            <div className="px-4 py-2.5 border-b border-neutral-200 flex items-center gap-1.5 bg-white/50">
              <FolderOpen className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="text-[12px] font-semibold text-neutral-800">
                {draft.role || 'Agent'}
              </span>
              {selectedPersona && selectedPersona.kind === 'dir' && (
                <span className="text-[11px] text-neutral-400">
                  · {selectedPersona.file_tree.length}
                </span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
              {personas === null ? (
                <div className="flex items-center gap-2 text-[12px] text-neutral-500 px-2 py-2">
                  <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                  {t('nodeEditor.referenceLoading')}
                </div>
              ) : tree ? (
                <TreeView node={tree} selected={selectedFile} onPick={setSelectedFile} />
              ) : selectedPersona?.kind === 'file' ? (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedFile(selectedPersona.path.split('/').pop() ?? '')
                  }
                  className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11.5px] text-neutral-600 hover:bg-neutral-200/60 rounded-sm w-full text-left"
                >
                  <FileIcon className="w-3.5 h-3.5 text-neutral-400" />
                  {selectedPersona.path.split('/').pop()}
                </button>
              ) : (
                <div className="px-2 py-6 text-[12px] text-neutral-400 text-center leading-relaxed">
                  No reference files.
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: file viewer/editor — OR system prompt fallback */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {selectedFile !== null ? (
              <>
                <div className="flex items-center gap-2 px-5 py-2 border-b border-neutral-200 bg-neutral-50/60">
                  <FileIcon className="w-3.5 h-3.5 text-neutral-500" />
                  <span className="font-mono text-[12px] text-neutral-700 truncate">
                    {selectedFile}
                  </span>
                  {fileEdits[selectedFile] !== undefined && (
                    <span className="text-[11px] text-amber-600">· unsaved</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedFile(null)}
                    className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-900 underline"
                  >
                    close
                  </button>
                </div>
                <textarea
                  value={fileContent ?? ''}
                  onChange={(e) =>
                    setFileEdits((prev) => ({ ...prev, [selectedFile]: e.target.value }))
                  }
                  className="flex-1 min-h-0 font-mono text-[13px] leading-relaxed w-full px-5 py-3 outline-none resize-none"
                  spellCheck={false}
                />
              </>
            ) : (
              <>
                <div className="px-5 py-2 border-b border-neutral-200 bg-neutral-50/60">
                  <span className="text-[12px] font-semibold text-neutral-700">
                    System prompt
                  </span>
                  <span className="ml-2 text-[11px] text-neutral-500">
                    Pick a file on the left to view and edit it.
                  </span>
                </div>
                <textarea
                  value={draft.systemPrompt}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  className="flex-1 min-h-0 font-mono text-[13px] leading-relaxed w-full px-5 py-3 outline-none resize-none"
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50 rounded-b-md">
          {agent.role === 'Lead' ? (
            <span className="text-[14px] text-neutral-400">
              Lead는 팀당 하나로 고정 — 삭제할 수 없습니다
            </span>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="!text-red-600 hover:!bg-red-50"
            >
              Delete
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                if (companySlug && team?.slug) {
                  downloadAgentFrame(companySlug, team.slug, agent.id)
                }
              }}
              disabled={!companySlug || !team?.slug}
              title={t('canvas.exportAsFrameHint')}
            >
              <Package className="w-3.5 h-3.5" />
              {t('canvas.exportAsFrame')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </div>
        </div>

        {confirmDelete && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm delete"
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-md"
            onClick={() => setConfirmDelete(false)}
            onKeyDown={(e) => e.key === 'Escape' && setConfirmDelete(false)}
          >
            <div
              className="w-[420px] max-w-[90%] rounded-md bg-white shadow-xl border border-neutral-200 p-5"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="text-[15px] font-semibold text-neutral-900 mb-1">
                Delete this agent?
              </div>
              <div className="text-[13px] text-neutral-600 leading-relaxed mb-4">
                <span className="font-medium">{draft.role || agent.role}</span>
                {draft.role && draft.role !== 'Member' ? '' : ''} 에이전트가 팀에서 제거되고
                연결된 엣지도 함께 삭제됩니다. 이 작업은 되돌릴 수 없어요.
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    removeAgent(agent.id)
                    setConfirmDelete(false)
                    onClose()
                  }}
                  className="!bg-red-600 hover:!bg-red-700 !text-white"
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}

        <style jsx>{`
          .input {
            width: 100%;
            padding: 0.5rem 0.75rem;
            font-size: 0.875rem;
            border-radius: 0.25rem;
            border: 1px solid #d4d4d4;
            background: white;
            outline: none;
          }
          .input:focus {
            border-color: #737373;
            box-shadow: 0 0 0 3px rgb(115 115 115 / 0.1);
          }
        `}</style>
      </div>
    </div>
  )
}
