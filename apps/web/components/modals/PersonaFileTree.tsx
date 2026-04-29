/**
 * VSCode-style file tree for a single persona bundle. Used by both the
 * create flow (CreateAgentModal) and the edit flow (NodeEditor) so the
 * two views stay visually identical — only the commit path differs.
 *
 * Callers own the state (files + folders + selectedFile + expanded) and
 * pass it in; this component is pure presentation with hover actions.
 */

import {
  CaretDown,
  CaretRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Trash,
} from '@phosphor-icons/react'

export interface TreeNode {
  name: string
  path: string
  isFile: boolean
  children: TreeNode[]
}

interface PersonaFileTreeLabels {
  addFile: string
  addFolder: string
  delete: string
}

export function buildTree(filePaths: string[], folderPaths: Set<string>): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] }

  const ensureFolder = (parts: string[]) => {
    let cur = root
    parts.forEach((part, i) => {
      const pathSoFar = parts.slice(0, i + 1).join('/')
      let child = cur.children.find((c) => c.name === part && !c.isFile)
      if (!child) {
        child = { name: part, path: pathSoFar, isFile: false, children: [] }
        cur.children.push(child)
      }
      cur = child
    })
    return cur
  }

  for (const fp of folderPaths) {
    const parts = fp.split('/').filter(Boolean)
    if (parts.length > 0) ensureFolder(parts)
  }

  for (const p of filePaths) {
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 0) continue
    const parent = parts.slice(0, -1)
    const leaf = parts[parts.length - 1] ?? ''
    const parentNode = parent.length > 0 ? ensureFolder(parent) : root
    if (!parentNode.children.some((c) => c.name === leaf && c.isFile)) {
      parentNode.children.push({ name: leaf, path: p, isFile: true, children: [] })
    }
  }

  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.name === 'AGENT.md') return -1
      if (b.name === 'AGENT.md') return 1
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
      return a.name.localeCompare(b.name)
    })
    for (const c of n.children) sort(c)
  }
  sort(root)
  return root
}

export function uniqueChildName(
  existing: Set<string>,
  parent: string,
  base: string,
  ext = '',
): string {
  const prefix = parent ? `${parent}/` : ''
  let n = 1
  let candidate = `${prefix}${base}${ext}`
  while (existing.has(candidate)) {
    n += 1
    candidate = `${prefix}${base}-${n}${ext}`
  }
  return candidate
}

interface RowsProps {
  node: TreeNode
  depth: number
  selected: string
  expanded: Set<string>
  readOnly?: boolean
  onToggle: (path: string) => void
  onPick: (path: string) => void
  onAddFile: (folderPath: string) => void
  onAddFolder: (folderPath: string) => void
  onDelete: (node: TreeNode) => void
  labels: PersonaFileTreeLabels
}

export function PersonaTreeRows(props: RowsProps) {
  const {
    node,
    depth,
    selected,
    expanded,
    readOnly,
    onToggle,
    onPick,
    onAddFile,
    onAddFolder,
    onDelete,
    labels,
  } = props
  return (
    <>
      {node.children.map((child) => {
        const pad = { paddingLeft: `${8 + depth * 12}px` }
        if (child.isFile) {
          const active = selected === child.path
          const isAgentMd = child.path === 'AGENT.md'
          return (
            <div
              key={`f:${child.path}`}
              className={`group flex items-center gap-1 rounded-sm ${
                active ? 'bg-neutral-200/70' : 'hover:bg-neutral-200/40'
              }`}
            >
              <button
                type="button"
                onClick={() => onPick(child.path)}
                className="flex-1 min-w-0 flex items-center gap-1.5 py-1 font-mono text-[11.5px] text-left truncate"
                style={pad}
              >
                <FileIcon className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                <span className="truncate">{child.name}</span>
              </button>
              {!readOnly && !isAgentMd && (
                <button
                  type="button"
                  onClick={() => onDelete(child)}
                  aria-label={labels.delete}
                  title={labels.delete}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 rounded-sm hover:bg-red-100 text-neutral-500 hover:text-red-600"
                >
                  <Trash className="w-3 h-3" />
                </button>
              )}
            </div>
          )
        }
        const isOpen = expanded.has(child.path)
        return (
          <div key={`d:${child.path}`}>
            <div className="group flex items-center gap-1 rounded-sm hover:bg-neutral-200/40">
              <button
                type="button"
                onClick={() => onToggle(child.path)}
                className="flex-1 min-w-0 flex items-center gap-1.5 py-1 pr-1.5 text-left"
                style={pad}
              >
                {isOpen ? (
                  <FolderOpen className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                )}
                <span className="flex-1 min-w-0 font-mono text-[11.5px] truncate">
                  {child.name}
                </span>
                {isOpen ? (
                  <CaretDown className="w-3 h-3 text-neutral-400 shrink-0" />
                ) : (
                  <CaretRight className="w-3 h-3 text-neutral-400 shrink-0" />
                )}
              </button>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    onClick={() => onAddFile(child.path)}
                    aria-label={labels.addFile}
                    title={labels.addFile}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-sm hover:bg-neutral-200/80 text-neutral-500"
                  >
                    <FilePlus className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddFolder(child.path)}
                    aria-label={labels.addFolder}
                    title={labels.addFolder}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-sm hover:bg-neutral-200/80 text-neutral-500"
                  >
                    <FolderPlus className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(child)}
                    aria-label={labels.delete}
                    title={labels.delete}
                    className="opacity-0 group-hover:opacity-100 p-1 mr-1 rounded-sm hover:bg-red-100 text-neutral-500 hover:text-red-600"
                  >
                    <Trash className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
            {isOpen && (
              <div className="relative">
                <div
                  aria-hidden
                  className="absolute top-0 bottom-0 border-l border-neutral-200 dark:border-neutral-700 pointer-events-none"
                  style={{ left: `${8 + depth * 12 + 7}px` }}
                />
                <PersonaTreeRows {...props} node={child} depth={depth + 1} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
