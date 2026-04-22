'use client'

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { clsx } from 'clsx'
import { Crown, User } from '@phosphor-icons/react'
import type { ComponentType } from 'react'

export type AgentNodeData = {
  role: string
  label: string
  providerColor?: string
  isActive?: boolean
  /** True for team's top agent (no superior). Top handle is hidden for Leads. */
  isLead?: boolean
}

export type AgentFlowNode = Node<AgentNodeData, 'agent'>

const ROLE_ICON: Record<string, ComponentType<{ className?: string }>> = {
  Lead: Crown,
  Member: User,
}

export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const Icon = ROLE_ICON[data.role] ?? User

  return (
    <div
      className={clsx(
        'relative rounded-md bg-white border px-4 py-3 w-[240px] h-[72px] shadow-sm transition-shadow cursor-pointer',
        data.isActive
          ? 'border-emerald-500 ring-2 ring-emerald-500/30 shadow-md'
          : 'border-neutral-200 hover:shadow-md',
      )}
    >
      {data.isActive && (
        <span className="absolute -top-3 right-4 rounded-full bg-emerald-100 text-emerald-700 text-[14px] px-2 py-0.5 font-medium">
          Active
        </span>
      )}
      <div className="flex items-center gap-2.5 h-full">
        <div className="w-8 h-8 shrink-0 rounded bg-neutral-100 flex items-center justify-center">
          <Icon className="w-4 h-4 text-neutral-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-neutral-900 text-[14px] leading-tight truncate">
            {data.role}
          </div>
          <div className="text-[12px] text-neutral-500 flex items-center gap-1.5 mt-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: data.providerColor ?? '#a3a3a3' }}
            />
            <span className="truncate">{data.label}</span>
          </div>
        </div>
      </div>
      {/* Lead has no superior — no top handle. Others keep a small dot with an
          enlarged invisible hit area so it's easier to grab. */}
      {!data.isLead && (
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-neutral-400 !w-2 !h-2 !border-0 before:absolute before:inset-[-10px] before:content-['']"
        />
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-neutral-400 !w-2 !h-2 !border-0 before:absolute before:inset-[-10px] before:content-['']"
      />
    </div>
  )
}
