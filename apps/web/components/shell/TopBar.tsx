'use client'

import { Hexagon, PanelLeftClose, PanelRightClose } from 'lucide-react'
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

  const currentCompany = companies.find((c) => c.id === currentCompanyId)

  return (
    <header className="h-full flex items-center justify-between px-4 bg-white">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={toggleSidebar} aria-label="Toggle sidebar">
          <PanelLeftClose className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2">
          <Hexagon className="w-5 h-5 text-amber-500" fill="currentColor" />
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
        <Button variant="ghost" size="sm" onClick={toggleDrawer} aria-label="Toggle drawer">
          <PanelRightClose className="w-4 h-4" />
        </Button>
      </div>
    </header>
  )
}
