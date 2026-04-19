'use client'

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { clsx } from 'clsx'
import {
  Briefcase,
  Code2,
  Compass,
  Crown,
  FileText,
  FlaskConical,
  Hammer,
  Microscope,
  PenTool,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { ComponentType } from 'react'

export type AgentNodeData = {
  role: string
  label: string
  providerColor?: string
  isActive?: boolean
}

export type AgentFlowNode = Node<AgentNodeData, 'agent'>

const ROLE_ICON: Record<string, ComponentType<{ className?: string }>> = {
  CEO: Crown,
  CMO: Compass,
  CTO: Code2,
  COO: Briefcase,
  Engineer: Hammer,
  Researcher: Search,
  Writer: PenTool,
  Reviewer: ShieldCheck,
  Analyst: Microscope,
  Scientist: FlaskConical,
  Manager: Users,
  Worker: FileText,
}

export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const Icon = ROLE_ICON[data.role] ?? FileText

  return (
    <div
      className={clsx(
        'relative rounded-2xl bg-white border px-4 py-3 min-w-[200px] shadow-sm transition-shadow',
        data.isActive
          ? 'border-emerald-500 ring-2 ring-emerald-500/30 shadow-md'
          : selected
            ? 'border-neutral-900 shadow-md'
            : 'border-neutral-200 hover:shadow-md',
      )}
    >
      {data.isActive && (
        <span className="absolute -top-3 right-4 rounded-full bg-emerald-100 text-emerald-700 text-[11px] px-2 py-0.5 font-medium">
          Active
        </span>
      )}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 w-8 h-8 rounded-lg bg-neutral-100 flex items-center justify-center">
          <Icon className="w-4 h-4 text-neutral-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-neutral-900 leading-tight">{data.role}</div>
          <div className="text-sm text-neutral-500 flex items-center gap-1.5 mt-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: data.providerColor ?? '#f59e0b' }}
            />
            <span className="truncate">{data.label}</span>
          </div>
        </div>
      </div>
      <Handle type="target" position={Position.Top} className="!bg-neutral-400 !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400 !w-2 !h-2" />
    </div>
  )
}
