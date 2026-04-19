'use client'

import { GearSix, SidebarSimple } from '@phosphor-icons/react'
import { useState } from 'react'
import { SettingsModal } from '@/components/modals/SettingsModal'
import { useAppStore } from '@/lib/stores/useAppStore'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'

export function TopBar() {
  const {
    companies,
    currentCompanyId,
    currentTeamId,
    mode,
    setCompany,
    setTeam,
    setMode,
    toggleSidebar,
    toggleDrawer,
  } = useAppStore()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const currentCompany = companies.find((c) => c.id === currentCompanyId)

  return (
    <header className="h-full flex items-center justify-between px-4 bg-white">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={toggleSidebar} aria-label="Toggle sidebar">
          <SidebarSimple className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2">
          {/* biome-ignore lint/performance/noImgElement: next/image incompatible with static export */}
          <img src="/logo.svg" alt="OpenHive" className="w-6 h-6" />
          <span className="font-semibold text-neutral-900">OpenHive</span>
        </div>
        <div className="w-px h-5 bg-neutral-200 mx-1" />
        <Select
          label="Company"
          value={currentCompanyId}
          onChange={(e) => setCompany(e.target.value)}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="Team" value={currentTeamId} onChange={(e) => setTeam(e.target.value)}>
          {currentCompany?.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center gap-3">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'design', label: 'Design' },
            { value: 'run', label: 'Run' },
          ]}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          <GearSix className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleDrawer} aria-label="Toggle drawer">
          <SidebarSimple className="w-4 h-4 scale-x-[-1]" />
        </Button>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
