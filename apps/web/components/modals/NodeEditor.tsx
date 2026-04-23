import { CircleNotch, File as FileIcon, FolderOpen, Package, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { downloadAgentFrame } from '@/lib/api/agent-frames'
import { getPersonaFiles, savePersonaFiles } from '@/lib/api/agent-library'
import { type ModelInfo, listModels } from '@/lib/api/models'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { mockProviders } from '@/lib/mock/companies'
import { useAppStore, useCurrentTeam } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'
import {
  buildTree,
  PersonaTreeRows,
  type TreeNode,
  uniqueChildName,
} from './PersonaFileTree'

interface NodeEditorProps {
  agent: Agent | null
  onClose: () => void
}

const HARD_MAX_PARALLEL = 100
const FILENAME_RE = /^[a-z0-9][a-z0-9\-/_.]*\.md$/
const FOLDERNAME_RE = /^[a-z0-9][a-z0-9\-_/]*$/
const modelCache: Record<string, ModelInfo[]> = {}

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
  // The live editable files map + extra empty folders the user added in-flight.
  const [files, setFiles] = useState<Record<string, string>>({})
  const [folders, setFolders] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string>('AGENT.md')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [dirty, setDirty] = useState(false)
  // Snapshot of on-disk files so Save knows what changed (skip noop).
  const [initialFiles, setInitialFiles] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setDraft(agent)
    setSelectedFile('AGENT.md')
    setExpanded(new Set())
    setFiles({})
    setFolders(new Set())
    setInitialFiles({})
    setDirty(false)
    setSaveError(null)
    setConfirmDelete(false)
  }, [agent])

  useEscapeClose(agent, onClose)

  // Load files from disk whenever the attached persona changes.
  useEffect(() => {
    const personaPath = agent?.personaPath ?? draft?.personaPath
    if (!personaPath) return
    setLoadingFiles(true)
    getPersonaFiles(personaPath)
      .then((loaded) => {
        // Ensure AGENT.md exists so selectedFile='AGENT.md' points at
        // something — server migration guarantees this for company agents,
        // but a bundled persona scanned via the library may predate the
        // rename. Fall back to an empty stub if missing.
        const next: Record<string, string> = loaded['AGENT.md']
          ? loaded
          : { 'AGENT.md': '# Persona\n', ...loaded }
        setFiles(next)
        setInitialFiles(next)
        setDirty(false)
      })
      .catch((e) => setSaveError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingFiles(false))
  }, [agent?.personaPath, agent?.id])

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

  const tree = useMemo(() => buildTree(Object.keys(files), folders), [files, folders])

  const filesChanged = useMemo(() => {
    const aKeys = Object.keys(files).sort()
    const bKeys = Object.keys(initialFiles).sort()
    if (aKeys.length !== bKeys.length) return true
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) return true
    }
    for (const k of aKeys) {
      if (files[k] !== initialFiles[k]) return true
    }
    return false
  }, [files, initialFiles])

  if (!agent || !draft) return null

  // A persona is editable when it's a company-owned bundle. Bundled /
  // user-global personas are shown read-only (tree hides action buttons).
  const personaPath = draft.personaPath ?? ''
  const readOnly =
    !personaPath ||
    !personaPath.includes(`/companies/`) ||
    !personaPath.includes(`/agents/`)

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

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const addFile = (folderPath: string) => {
    if (readOnly) return
    const taken = new Set<string>([...Object.keys(files), ...folders])
    const name = uniqueChildName(taken, folderPath, 'new', '.md')
    setFiles((prev) => ({ ...prev, [name]: '' }))
    setSelectedFile(name)
    setDirty(true)
    if (folderPath) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(folderPath)
        const parts = folderPath.split('/')
        for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join('/'))
        return next
      })
    }
  }

  const addFolder = (folderPath: string) => {
    if (readOnly) return
    const taken = new Set<string>([...Object.keys(files), ...folders])
    const name = uniqueChildName(taken, folderPath, 'new-folder')
    setFolders((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(name)
      if (folderPath) {
        next.add(folderPath)
        const parts = folderPath.split('/')
        for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join('/'))
      }
      return next
    })
    setDirty(true)
  }

  const renameFile = (oldName: string, nextNameRaw: string) => {
    const nextName = nextNameRaw.trim()
    if (!nextName || nextName === oldName || oldName === 'AGENT.md') return
    if (!FILENAME_RE.test(nextName)) {
      setSaveError(`Invalid filename: ${nextName}`)
      return
    }
    if (files[nextName] || folders.has(nextName)) {
      setSaveError(`Already exists: ${nextName}`)
      return
    }
    setSaveError(null)
    setFiles((prev) => {
      const { [oldName]: body, ...rest } = prev
      return { ...rest, [nextName]: body ?? '' }
    })
    if (selectedFile === oldName) setSelectedFile(nextName)
    setDirty(true)
  }

  const renameFolder = (oldPath: string, nextPathRaw: string) => {
    const nextPath = nextPathRaw.trim().replace(/\/+$/, '')
    if (!nextPath || nextPath === oldPath) return
    if (!FOLDERNAME_RE.test(nextPath)) {
      setSaveError(`Invalid folder name: ${nextPath}`)
      return
    }
    const conflict =
      folders.has(nextPath) ||
      Object.keys(files).some((f) => f === nextPath || f.startsWith(`${nextPath}/`))
    if (conflict) {
      setSaveError(`Already exists: ${nextPath}`)
      return
    }
    setSaveError(null)
    setFolders((prev) => {
      const next = new Set<string>()
      for (const f of prev) {
        if (f === oldPath) next.add(nextPath)
        else if (f.startsWith(`${oldPath}/`))
          next.add(`${nextPath}/${f.slice(oldPath.length + 1)}`)
        else next.add(f)
      }
      return next
    })
    setFiles((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (k.startsWith(`${oldPath}/`))
          next[`${nextPath}/${k.slice(oldPath.length + 1)}`] = v
        else next[k] = v
      }
      return next
    })
    setSelectedFile((cur) => {
      if (cur === oldPath) return nextPath
      if (cur.startsWith(`${oldPath}/`)) return `${nextPath}/${cur.slice(oldPath.length + 1)}`
      return cur
    })
    setDirty(true)
  }

  const deleteNode = (node: TreeNode) => {
    if (node.path === 'AGENT.md') return
    if (node.isFile) {
      setFiles((prev) => {
        const { [node.path]: _, ...rest } = prev
        return rest
      })
      if (selectedFile === node.path) setSelectedFile('AGENT.md')
    } else {
      setFolders((prev) => {
        const next = new Set<string>()
        for (const f of prev) {
          if (f !== node.path && !f.startsWith(`${node.path}/`)) next.add(f)
        }
        return next
      })
      setFiles((prev) => {
        const next: Record<string, string> = {}
        for (const [k, v] of Object.entries(prev)) {
          if (!k.startsWith(`${node.path}/`)) next[k] = v
        }
        return next
      })
      if (selectedFile === node.path || selectedFile.startsWith(`${node.path}/`)) {
        setSelectedFile('AGENT.md')
      }
    }
    setDirty(true)
  }

  const save = async () => {
    const provider = mockProviders.find((p) => p.id === draft.providerId)
    const clampedParallel = isLead
      ? 1
      : Math.max(1, Math.min(HARD_MAX_PARALLEL, Number(draft.maxParallel ?? 1) || 1))

    // Persist file changes first — if that fails, don't touch team.yaml so
    // the two don't drift.
    if (!readOnly && filesChanged && personaPath) {
      setSaving(true)
      setSaveError(null)
      try {
        await savePersonaFiles(personaPath, files)
      } catch (exc) {
        setSaveError(exc instanceof Error ? exc.message : String(exc))
        setSaving(false)
        return
      }
      setSaving(false)
    }
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

  const selectedIsFolder =
    folders.has(selectedFile) ||
    (!(selectedFile in files) && selectedFile !== 'AGENT.md' && selectedFile !== '')
  const currentBody = files[selectedFile] ?? ''
  const fileCount = Object.keys(files).length

  const labels = {
    addFile: t('canvas.createAgentAddFile'),
    addFolder: t('canvas.createAgentAddFolder'),
    delete: t('canvas.createAgentDeleteFile'),
  }

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
        {/* Header */}
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

        {/* Main split */}
        <div className="flex-1 flex min-h-0">
          {/* LEFT: tree */}
          <div className="w-[340px] shrink-0 flex flex-col min-h-0 bg-neutral-50/60 border-r border-neutral-200">
            <div className="px-4 py-2.5 border-b border-neutral-200 flex items-center gap-1 bg-white/50">
              <FolderOpen className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span className="text-[12px] font-semibold text-neutral-800">
                {draft.role || 'Agent'}
              </span>
              <span className="text-[11px] text-neutral-400">· {fileCount}</span>
              {readOnly && (
                <span className="text-[10px] text-neutral-400 ml-1">
                  · {t('nodeEditor.referenceSourceBundled')}
                </span>
              )}
              {!readOnly && (
                <div className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => addFile('')}
                    aria-label={labels.addFile}
                    title={labels.addFile}
                    className="p-1 rounded-sm hover:bg-neutral-200/60 text-neutral-600"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><title>new file</title><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => addFolder('')}
                    aria-label={labels.addFolder}
                    title={labels.addFolder}
                    className="p-1 rounded-sm hover:bg-neutral-200/60 text-neutral-600"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><title>new folder</title><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {loadingFiles ? (
                <div className="flex items-center gap-2 text-[12px] text-neutral-500 px-3 py-2">
                  <CircleNotch className="w-3.5 h-3.5 animate-spin" />
                  {t('nodeEditor.referenceLoading')}
                </div>
              ) : fileCount === 0 && !personaPath ? (
                <div className="px-3 py-6 text-[12px] text-neutral-400 text-center leading-relaxed">
                  No persona attached.
                </div>
              ) : (
                <PersonaTreeRows
                  node={tree}
                  depth={0}
                  selected={selectedFile}
                  expanded={expanded}
                  readOnly={readOnly}
                  onToggle={toggleFolder}
                  onPick={setSelectedFile}
                  onAddFile={addFile}
                  onAddFolder={addFolder}
                  onDelete={deleteNode}
                  labels={labels}
                />
              )}
            </div>
          </div>

          {/* RIGHT: body editor or folder placeholder */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="px-5 py-2 border-b border-neutral-200 bg-neutral-50/60 flex items-center gap-2">
              <FileIcon className="w-3.5 h-3.5 text-neutral-500" />
              {selectedFile === 'AGENT.md' || readOnly ? (
                <span className="font-mono text-[12px] text-neutral-700 truncate">
                  {selectedFile || 'AGENT.md'}
                </span>
              ) : (
                <input
                  value={selectedFile}
                  onChange={(e) => setSelectedFile(e.target.value)}
                  onBlur={(e) => {
                    const next = e.target.value
                    if (selectedIsFolder) renameFolder(selectedFile, next)
                    else renameFile(selectedFile, next)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                  }}
                  className="font-mono text-[12px] text-neutral-700 bg-transparent outline-none focus:bg-white focus:border focus:border-neutral-300 rounded px-1 min-w-[260px]"
                />
              )}
              <span className="text-[11px] text-neutral-500 ml-auto">
                {selectedIsFolder
                  ? 'folder'
                  : selectedFile === 'AGENT.md'
                    ? 'persona body'
                    : 'file content'}
                {readOnly && ` · ${t('nodeEditor.referenceSourceBundled')}`}
              </span>
            </div>
            {selectedIsFolder ? (
              <div className="flex-1 min-h-0 flex items-center justify-center text-[13px] text-neutral-400">
                {t('canvas.createAgentFolderSelected')}
              </div>
            ) : (
              <textarea
                value={currentBody}
                readOnly={readOnly}
                onChange={(e) => {
                  setFiles((prev) => ({ ...prev, [selectedFile]: e.target.value }))
                  setDirty(true)
                }}
                className={`flex-1 min-h-0 font-mono text-[13px] leading-relaxed w-full px-5 py-3 outline-none resize-none ${
                  readOnly ? 'bg-neutral-50/40 text-neutral-700' : 'bg-white'
                }`}
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50 rounded-b-md gap-3">
          <div className="flex items-center gap-3">
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
            {saveError && (
              <span className="text-[12px] text-red-600 truncate">{saveError}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                if (companySlug && team?.slug) downloadAgentFrame(companySlug, team.slug, agent.id)
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
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
              {dirty || filesChanged ? 'Save' : 'Close'}
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
                <span className="font-medium">{draft.role || agent.role}</span> 에이전트가 팀에서 제거되고 연결된 엣지도 함께 삭제됩니다. 이 작업은 되돌릴 수 없어요.
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
      </div>
    </div>
  )
}
