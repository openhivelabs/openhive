import {
  CircleNotch,
  File as FileIcon,
  FilePlus,
  FolderOpen,
  FolderPlus,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { createPersonaBundle } from '@/lib/api/agent-library'
import { type ModelInfo, listModels } from '@/lib/api/models'
import { DEFAULT_AGENT_SKILLS } from '@/lib/defaults/skills'
import { useEscapeClose } from '@/lib/hooks/useEscapeClose'
import { useT } from '@/lib/i18n'
import { mockProviders } from '@/lib/mock/companies'
import { useAppStore } from '@/lib/stores/useAppStore'
import { useCanvasStore } from '@/lib/stores/useCanvasStore'
import type { Agent } from '@/lib/types'
import { Button } from '../ui/Button'
import {
  buildTree,
  PersonaTreeRows,
  type TreeNode,
  uniqueChildName,
} from './PersonaFileTree'

interface CreateAgentModalProps {
  open: boolean
  onClose: () => void
}

const modelCache: Record<string, ModelInfo[]> = {}
const FILENAME_RE = /^[a-z0-9][a-z0-9\-/_.]*\.md$/
const FOLDERNAME_RE = /^[a-z0-9][a-z0-9\-_/]*$/

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultAgentMd(role: string): string {
  const nameSlug =
    role.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  return `---
name: '${nameSlug}'
description: '${role.trim() || 'Agent'}'
---

# Persona
You are a ${role.trim() || 'Member'}. Pick up tasks delegated by the Lead and return concise, well-scoped results.
`
}

export function CreateAgentModal({ open, onClose }: CreateAgentModalProps) {
  const t = useT()
  const defaultModel = useAppStore((s) => s.defaultModel)
  const companySlug = useAppStore((s) => {
    const c = s.companies.find((x) => x.id === s.currentCompanyId)
    return c?.slug ?? ''
  })
  const { addAgent } = useCanvasStore()

  const [role, setRole] = useState('Member')
  const [providerId, setProviderId] = useState<string>(defaultModel?.providerId ?? 'copilot')
  const [model, setModel] = useState<string>(defaultModel?.model ?? 'gpt-5-mini')
  const [files, setFiles] = useState<Record<string, string>>({})
  const [folders, setFolders] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string>('AGENT.md')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEscapeClose(open, onClose)

  useEffect(() => {
    if (!open) {
      setRole('Member')
      setProviderId(defaultModel?.providerId ?? 'copilot')
      setModel(defaultModel?.model ?? 'gpt-5-mini')
      setFiles({ 'AGENT.md': defaultAgentMd('Member') })
      setFolders(new Set())
      setSelectedFile('AGENT.md')
      setExpanded(new Set())
      setSubmitError(null)
      setSubmitting(false)
    } else {
      setFiles((prev) =>
        prev['AGENT.md'] ? prev : { ...prev, 'AGENT.md': defaultAgentMd(role) },
      )
    }
  }, [open, defaultModel])

  useEffect(() => {
    if (!open) return
    const cached = modelCache[providerId]
    if (cached) {
      setModels(cached)
      setModelsError(null)
      if (!cached.some((m) => m.id === model)) {
        const fb = cached.find((m) => m.default)?.id ?? cached[0]?.id
        if (fb) setModel(fb)
      }
      return
    }
    setLoadingModels(true)
    setModelsError(null)
    listModels(providerId)
      .then((list) => {
        modelCache[providerId] = list
        setModels(list)
        if (!list.some((m) => m.id === model)) {
          const fb = list.find((m) => m.default)?.id ?? list[0]?.id
          if (fb) setModel(fb)
        }
      })
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingModels(false))
  }, [open, providerId])

  const tree = useMemo(
    () => buildTree(Object.keys(files), folders),
    [files, folders],
  )

  if (!open) return null

  const provider = mockProviders.find((p) => p.id === providerId)
  const roleTrimmed = role.trim()
  const canSubmit =
    roleTrimmed.length > 0 && providerId && model && !!files['AGENT.md'] && !submitting

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const expandAncestors = (filePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const parts = filePath.split('/')
      for (let i = 1; i < parts.length; i += 1) {
        next.add(parts.slice(0, i).join('/'))
      }
      return next
    })
  }

  const addFile = (folderPath: string) => {
    const taken = new Set<string>([...Object.keys(files), ...folders])
    const name = uniqueChildName(taken, folderPath, 'new', '.md')
    setFiles((prev) => ({ ...prev, [name]: '' }))
    setSelectedFile(name)
    if (folderPath) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(folderPath)
        const parts = folderPath.split('/')
        for (let i = 1; i < parts.length; i += 1) {
          next.add(parts.slice(0, i).join('/'))
        }
        return next
      })
    }
  }

  const addFolder = (folderPath: string) => {
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
        for (let i = 1; i < parts.length; i += 1) {
          next.add(parts.slice(0, i).join('/'))
        }
      }
      return next
    })
  }

  const renameFile = (oldName: string, nextNameRaw: string) => {
    const nextName = nextNameRaw.trim()
    if (!nextName || nextName === oldName) return
    if (oldName === 'AGENT.md') return
    if (!FILENAME_RE.test(nextName)) {
      setSubmitError(`Invalid filename: ${nextName}`)
      return
    }
    if (files[nextName] || folders.has(nextName)) {
      setSubmitError(`Already exists: ${nextName}`)
      return
    }
    setSubmitError(null)
    setFiles((prev) => {
      const { [oldName]: body, ...rest } = prev
      return { ...rest, [nextName]: body ?? '' }
    })
    if (selectedFile === oldName) setSelectedFile(nextName)
    expandAncestors(nextName)
  }

  const renameFolder = (oldPath: string, nextPathRaw: string) => {
    const nextPath = nextPathRaw.trim().replace(/\/+$/, '')
    if (!nextPath || nextPath === oldPath) return
    if (!FOLDERNAME_RE.test(nextPath)) {
      setSubmitError(`Invalid folder name: ${nextPath}`)
      return
    }
    // Reject collisions with any existing file or folder that isn't
    // strictly a descendant of oldPath.
    const conflict =
      folders.has(nextPath) ||
      Object.keys(files).some((f) => f === nextPath || f.startsWith(`${nextPath}/`))
    if (conflict) {
      setSubmitError(`Already exists: ${nextPath}`)
      return
    }
    setSubmitError(null)
    setFolders((prev) => {
      const next = new Set<string>()
      for (const f of prev) {
        if (f === oldPath) next.add(nextPath)
        else if (f.startsWith(`${oldPath}/`)) next.add(`${nextPath}/${f.slice(oldPath.length + 1)}`)
        else next.add(f)
      }
      return next
    })
    setFiles((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (k.startsWith(`${oldPath}/`)) next[`${nextPath}/${k.slice(oldPath.length + 1)}`] = v
        else next[k] = v
      }
      return next
    })
    setSelectedFile((cur) => {
      if (cur === oldPath) return nextPath
      if (cur.startsWith(`${oldPath}/`)) return `${nextPath}/${cur.slice(oldPath.length + 1)}`
      return cur
    })
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
      // Folder: purge the folder itself + any descendants (files + nested
      // folders).
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
      if (
        selectedFile === node.path ||
        selectedFile.startsWith(`${node.path}/`)
      ) {
        setSelectedFile('AGENT.md')
      }
    }
  }

  const submit = async () => {
    if (!canSubmit || !companySlug) return
    setSubmitError(null)
    setSubmitting(true)
    try {
      const agentId = rid('a')
      const { persona_path, persona_name } = await createPersonaBundle(
        companySlug,
        roleTrimmed,
        agentId,
        files,
      )
      const agent: Agent = {
        id: agentId,
        role: roleTrimmed,
        label: provider?.label ?? providerId,
        providerId,
        model,
        systemPrompt: '',
        skills: [...DEFAULT_AGENT_SKILLS],
        position: { x: 0, y: 0 },
        personaPath: persona_path,
        personaName: persona_name ?? undefined,
      }
      addAgent(agent)
      onClose()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const currentBody = selectedFile in files ? files[selectedFile] ?? '' : ''
  const selectedIsFolder = folders.has(selectedFile) || (!files[selectedFile] && selectedFile !== 'AGENT.md')
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
      aria-label={t('canvas.createAgentTitle')}
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
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="input !w-40 !py-1 text-[14px] font-semibold"
            placeholder={t('canvas.createAgentRole')}
            // biome-ignore lint/a11y/noAutofocus: role is the entry point.
            autoFocus
          />
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="input !w-32 !py-1 text-[13px]"
          >
            {mockProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {loadingModels ? null : modelsError || models.length === 0 ? (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input !w-44 !py-1 text-[13px] font-mono"
              placeholder="model id"
            />
          ) : (
            <select
              value={models.some((m) => m.id === model) ? model : ''}
              onChange={(e) => setModel(e.target.value)}
              className="input !w-52 !py-1 text-[13px]"
            >
              {!models.some((m) => m.id === model) && model && (
                <option value="">{model} (not in list)</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.default ? ' · default' : ''}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto">
            <button
              type="button"
              onClick={onClose}
              aria-label={t('canvas.close')}
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
                {roleTrimmed || 'Agent'}
              </span>
              <span className="text-[11px] text-neutral-400">· {fileCount}</span>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => addFile('')}
                  aria-label={labels.addFile}
                  title={labels.addFile}
                  className="p-1 rounded-sm hover:bg-neutral-200/60 text-neutral-600"
                >
                  <FilePlus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => addFolder('')}
                  aria-label={labels.addFolder}
                  title={labels.addFolder}
                  className="p-1 rounded-sm hover:bg-neutral-200/60 text-neutral-600"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              <PersonaTreeRows
                node={tree}
                depth={0}
                selected={selectedFile}
                expanded={expanded}
                onToggle={toggleFolder}
                onPick={setSelectedFile}
                onAddFile={addFile}
                onAddFolder={addFolder}
                onDelete={deleteNode}
                labels={labels}
              />
            </div>
          </div>

          {/* RIGHT: body editor OR folder placeholder */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="px-5 py-2 border-b border-neutral-200 bg-neutral-50/60 flex items-center gap-2">
              <FileIcon className="w-3.5 h-3.5 text-neutral-500" />
              {selectedFile === 'AGENT.md' ? (
                <span className="font-mono text-[12px] text-neutral-700">AGENT.md</span>
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
            </div>
            {selectedIsFolder ? (
              <div className="flex-1 min-h-0 flex items-center justify-center text-[13px] text-neutral-400">
                {t('canvas.createAgentFolderSelected')}
              </div>
            ) : (
              <textarea
                value={currentBody}
                onChange={(e) =>
                  setFiles((prev) => ({ ...prev, [selectedFile]: e.target.value }))
                }
                className="flex-1 min-h-0 font-mono text-[13px] leading-relaxed w-full px-5 py-3 outline-none resize-none bg-white"
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50 rounded-b-md gap-3">
          <span className="text-[12px] text-red-600 truncate">
            {submitError || ''}
          </span>
          <div className="flex gap-2 shrink-0">
            <Button variant="ghost" onClick={onClose}>
              {t('canvas.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit}>
              {submitting && <CircleNotch className="w-3.5 h-3.5 animate-spin" />}
              {submitting ? t('canvas.askAiGenerating') : t('canvas.createAgentSubmit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
