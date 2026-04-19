# Phase 0A — Frontend Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Ship a runnable frontend at `localhost:4483` with the full OpenHive UI shell (canvas + drawer + navigation) backed by mock data — no real backend yet. Users should be able to click around, drag nodes, and see what the product feels like before any LLM call is wired up.

**Architecture:** Next.js 16 App Router + React 19 + Tailwind 4 + @xyflow/react 12 (canvas). All state lives in Zustand stores; "API calls" return mock data from typed fixtures. No Python, no LangGraph, no SQLite yet.

**Tech Stack:** Node 24 LTS, pnpm, Next.js 16.2.4, React 19.2.5, TypeScript 5.x, Tailwind CSS 4.2.2, @xyflow/react 12.10.2, Zustand 5.x, Biome (lint/format), Vitest + Testing Library.

**Scope:** Frontend only. Backend integration is Phase 0B.

---

## File Structure

```
openhive/
├── package.json                      (root — pnpm workspace)
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
└── apps/
    └── web/
        ├── package.json
        ├── next.config.ts
        ├── tailwind.config.ts
        ├── tsconfig.json
        ├── app/
        │   ├── layout.tsx            (root layout, Tailwind base)
        │   ├── page.tsx              (main app — canvas + shell)
        │   └── globals.css
        ├── components/
        │   ├── shell/
        │   │   ├── TopBar.tsx        (Company ▼  Team ▼  [Design⇄Run])
        │   │   ├── Sidebar.tsx       (Company/Team tree)
        │   │   └── Timeline.tsx      (bottom collapsible Gantt)
        │   ├── canvas/
        │   │   ├── OrgCanvas.tsx     (@xyflow/react wrapper)
        │   │   ├── AgentNode.tsx     (Paperclip-style node card)
        │   │   ├── ReportingEdge.tsx (animated edge for Run mode)
        │   │   └── NodePalette.tsx   (Design mode — drag source)
        │   ├── drawer/
        │   │   ├── RightDrawer.tsx   (tab container)
        │   │   ├── ChatTab.tsx
        │   │   ├── TriggersTab.tsx
        │   │   └── ArtifactsTab.tsx
        │   ├── modals/
        │   │   ├── PresetGallery.tsx (3 starter templates)
        │   │   └── NodeEditor.tsx    (role, provider, model, prompt, skills)
        │   └── ui/                   (low-level primitives — Button, Input, Select, Tabs)
        ├── lib/
        │   ├── mock/                 (fixtures — mockCompanies, mockMessages, mockTriggers, mockArtifacts)
        │   ├── stores/               (Zustand — useCanvasStore, useAppStore, useDrawerStore)
        │   ├── types.ts              (Company, Team, Agent, Edge, Trigger, Message, Artifact)
        │   └── presets.ts            (3 built-in company/team templates)
        └── tests/
            └── ...
```

---

## Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "openhive",
  "private": true,
  "packageManager": "pnpm@9.x",
  "scripts": {
    "dev": "pnpm --filter @openhive/web dev",
    "build": "pnpm --filter @openhive/web build",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/latest/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } }
}
```

- [ ] **Step 4: Create `.nvmrc`** with `24` and `.gitignore` covering `node_modules`, `.next`, `dist`, `.DS_Store`, `~/.openhive/`

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml biome.json tsconfig.base.json .gitignore .nvmrc
git commit -m "chore: scaffold pnpm workspace and biome config"
```

---

## Task 2: Next.js app initialization

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`

- [ ] **Step 1: Create `apps/web/package.json`**

Pin latest versions. Port 4483 for dev server.

```json
{
  "name": "@openhive/web",
  "private": true,
  "scripts": {
    "dev": "next dev -p 4483",
    "build": "next build",
    "start": "next start -p 4483",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.2.4",
    "react": "19.2.5",
    "react-dom": "19.2.5",
    "@xyflow/react": "12.10.2",
    "zustand": "^5.0.0",
    "clsx": "^2.1.0",
    "lucide-react": "latest"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "4.2.2",
    "@tailwindcss/postcss": "4.2.2",
    "postcss": "latest",
    "typescript": "^5.7.0",
    "vitest": "latest",
    "@testing-library/react": "latest",
    "@testing-library/jest-dom": "latest",
    "jsdom": "latest"
  }
}
```

- [ ] **Step 2: `apps/web/next.config.ts`**

```ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'export',  // so FastAPI can serve it as static later
  images: { unoptimized: true },
}

export default config
```

- [ ] **Step 3: `apps/web/tailwind.config.ts`** — Tailwind 4 uses CSS-first config; just a minimal file pointing at content globs.

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
}
export default config
```

- [ ] **Step 4: `apps/web/app/globals.css`**

```css
@import 'tailwindcss';

:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --border: #e5e5e5;
  --accent: #22c55e;
}

html, body { height: 100%; }
body { background: var(--bg); color: #111; font-family: ui-sans-serif, system-ui; }
```

- [ ] **Step 5: `apps/web/app/layout.tsx`**

```tsx
import './globals.css'

export const metadata = { title: 'OpenHive', description: 'AI agent company orchestrator' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>{children}</body></html>
  )
}
```

- [ ] **Step 6: `apps/web/app/page.tsx`** — placeholder so the dev server boots.

```tsx
export default function Home() {
  return <main className="p-8">OpenHive shell — coming up</main>
}
```

- [ ] **Step 7: Install and boot**

```bash
pnpm install
pnpm dev
# open http://localhost:4483 — should show "OpenHive shell — coming up"
```

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): boot Next.js 16 app on port 4483 with Tailwind 4"
```

---

## Task 3: Domain types and mock fixtures

**Files:**
- Create: `apps/web/lib/types.ts`, `apps/web/lib/mock/companies.ts`, `apps/web/lib/mock/messages.ts`, `apps/web/lib/mock/triggers.ts`, `apps/web/lib/mock/artifacts.ts`

- [ ] **Step 1: Define types** in `apps/web/lib/types.ts`

```ts
export type ProviderKind = 'oauth' | 'api_key' | 'local'
export interface Provider { id: string; kind: ProviderKind; label: string; connected: boolean }

export interface Agent {
  id: string
  role: string              // "CEO", "Researcher", …
  label: string             // "Claude", "Cursor", … (provider display)
  providerId: string
  model: string
  systemPrompt: string
  skills: string[]
  position: { x: number; y: number }
  isActive?: boolean        // Run-mode flag
}

export interface ReportingEdge { id: string; source: string; target: string }

export interface Team {
  id: string
  slug: string
  name: string
  agents: Agent[]
  edges: ReportingEdge[]
}

export interface Company { id: string; slug: string; name: string; teams: Team[] }

export interface Message {
  id: string
  teamId: string
  from: 'user' | string    // agentId or 'user'
  to?: string              // agentId (optional @mention)
  text: string
  createdAt: string
}

export type TriggerKind = 'chat' | 'cron' | 'webhook' | 'file_watch' | 'manual'
export interface Trigger { id: string; kind: TriggerKind; teamId: string; config: Record<string, unknown>; enabled: boolean }

export interface Artifact {
  id: string
  teamId: string
  runId: string
  path: string
  mime: string
  createdAt: string
  filename: string
}

export type CanvasMode = 'design' | 'run'
```

- [ ] **Step 2: Mock companies** in `apps/web/lib/mock/companies.ts`

```ts
import type { Company } from '../types'

export const mockCompanies: Company[] = [
  {
    id: 'c1', slug: 'acme', name: 'Acme Corp',
    teams: [{
      id: 't1', slug: 'report-team', name: 'Report Team',
      agents: [
        { id: 'a1', role: 'CEO', label: 'Claude', providerId: 'p-claude', model: 'claude-opus-4-5', systemPrompt: 'You lead the team.', skills: [], position: { x: 400, y: 60 }, isActive: false },
        { id: 'a2', role: 'Researcher', label: 'Claude', providerId: 'p-claude', model: 'claude-sonnet-4-6', systemPrompt: 'You research topics.', skills: ['web-research'], position: { x: 200, y: 260 }, isActive: false },
        { id: 'a3', role: 'Writer', label: 'Claude', providerId: 'p-claude', model: 'claude-sonnet-4-6', systemPrompt: 'You write the final document.', skills: ['docx-writer'], position: { x: 600, y: 260 }, isActive: false },
      ],
      edges: [
        { id: 'e1', source: 'a1', target: 'a2' },
        { id: 'e2', source: 'a1', target: 'a3' },
      ],
    }],
  },
  {
    id: 'c2', slug: 'rnd-lab', name: 'R&D Lab',
    teams: [{
      id: 't2', slug: 'semi-research', name: 'Semiconductor Research',
      agents: [
        { id: 'b1', role: 'CEO', label: 'Claude', providerId: 'p-claude', model: 'claude-opus-4-5', systemPrompt: 'You direct semiconductor R&D.', skills: [], position: { x: 400, y: 60 }, isActive: false },
        { id: 'b2', role: 'CTO', label: 'Cursor', providerId: 'p-cursor', model: 'gpt-5', systemPrompt: 'Technical lead.', skills: [], position: { x: 400, y: 260 }, isActive: true },
        { id: 'b3', role: 'Engineer', label: 'Codex', providerId: 'p-codex', model: 'gpt-5', systemPrompt: 'Implementation.', skills: ['python-runner'], position: { x: 250, y: 460 }, isActive: false },
        { id: 'b4', role: 'Engineer', label: 'Claude', providerId: 'p-claude', model: 'claude-sonnet-4-6', systemPrompt: 'Implementation.', skills: ['python-runner'], position: { x: 550, y: 460 }, isActive: false },
      ],
      edges: [
        { id: 'e3', source: 'b1', target: 'b2' },
        { id: 'e4', source: 'b2', target: 'b3' },
        { id: 'e5', source: 'b2', target: 'b4' },
      ],
    }],
  },
]
```

- [ ] **Step 3: Mock messages, triggers, artifacts** — short fixture arrays in their respective files. (Minimum 3 items each so lists render non-trivially.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib
git commit -m "feat(web): add domain types and mock fixtures"
```

---

## Task 4: Zustand stores

**Files:**
- Create: `apps/web/lib/stores/useAppStore.ts`, `apps/web/lib/stores/useCanvasStore.ts`, `apps/web/lib/stores/useDrawerStore.ts`

- [ ] **Step 1: `useAppStore`** — current company/team selection, canvas mode.

```ts
import { create } from 'zustand'
import type { CanvasMode } from '../types'
import { mockCompanies } from '../mock/companies'

interface AppState {
  companies: typeof mockCompanies
  currentCompanyId: string
  currentTeamId: string
  mode: CanvasMode
  setCompany: (id: string) => void
  setTeam: (id: string) => void
  setMode: (mode: CanvasMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  companies: mockCompanies,
  currentCompanyId: mockCompanies[0].id,
  currentTeamId: mockCompanies[0].teams[0].id,
  mode: 'design',
  setCompany: (id) => set({ currentCompanyId: id, currentTeamId: mockCompanies.find(c => c.id === id)!.teams[0].id }),
  setTeam: (id) => set({ currentTeamId: id }),
  setMode: (mode) => set({ mode }),
}))
```

- [ ] **Step 2: `useCanvasStore`** — node add/move/connect/delete actions. Initial nodes/edges seeded from current team in the store.

- [ ] **Step 3: `useDrawerStore`** — open drawer, active tab ('chat' | 'triggers' | 'artifacts'), selected node id (for NodeEditor).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/stores
git commit -m "feat(web): add zustand stores for app state, canvas, drawer"
```

---

## Task 5: App shell (TopBar + Sidebar + main area placeholder)

**Files:**
- Create: `apps/web/components/shell/TopBar.tsx`, `apps/web/components/shell/Sidebar.tsx`, `apps/web/components/ui/Button.tsx`, `apps/web/components/ui/Select.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Primitive UI components** — Button, Select with Tailwind styles.

- [ ] **Step 2: `Sidebar.tsx`** — left column, lists companies expanded with their teams. Click → updates `useAppStore`.

- [ ] **Step 3: `TopBar.tsx`** — Company ▼ Team ▼ on the left, Design/Run segmented toggle on the right. Wired to store.

- [ ] **Step 4: `app/page.tsx`** — grid layout:

```tsx
'use client'
import { TopBar } from '@/components/shell/TopBar'
import { Sidebar } from '@/components/shell/Sidebar'

export default function Home() {
  return (
    <div className="h-screen grid grid-rows-[48px_1fr] grid-cols-[240px_1fr]">
      <div className="col-span-2 border-b"><TopBar /></div>
      <aside className="border-r overflow-y-auto"><Sidebar /></aside>
      <main className="overflow-hidden">Canvas goes here</main>
    </div>
  )
}
```

- [ ] **Step 5: Verify in browser** — layout shows, dropdowns and toggle react to clicks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components apps/web/app/page.tsx
git commit -m "feat(web): add app shell with TopBar and Sidebar"
```

---

## Task 6: Org chart canvas (React Flow, Paperclip style)

**Files:**
- Create: `apps/web/components/canvas/OrgCanvas.tsx`, `apps/web/components/canvas/AgentNode.tsx`, `apps/web/components/canvas/ReportingEdge.tsx`
- Modify: `apps/web/app/page.tsx` (replace placeholder with `<OrgCanvas />`)

- [ ] **Step 1: `AgentNode.tsx`** — custom node type rendering a rounded card with icon, role (bold), and provider label (muted with colored dot). Green outline + "Active" pill when `data.isActive`.

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { clsx } from 'clsx'

export type AgentNodeData = { role: string; label: string; isActive?: boolean }

export function AgentNode({ data }: NodeProps<AgentNodeData>) {
  return (
    <div className={clsx(
      'relative rounded-xl bg-white border px-4 py-3 min-w-[180px] shadow-sm',
      data.isActive ? 'border-green-500 ring-2 ring-green-500/30' : 'border-neutral-200'
    )}>
      {data.isActive && (
        <span className="absolute -top-3 right-4 rounded-full bg-green-100 text-green-700 text-xs px-2 py-0.5 font-medium">Active</span>
      )}
      <div className="font-semibold text-neutral-900">{data.role}</div>
      <div className="text-sm text-neutral-500 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{data.label}
      </div>
      <Handle type="target" position={Position.Top} className="!bg-neutral-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  )
}
```

- [ ] **Step 2: `OrgCanvas.tsx`** — wraps `<ReactFlow>`, maps current team's agents/edges to nodes/edges, registers `AgentNode` as custom node type.

- [ ] **Step 3: Wire into `page.tsx`** — replace placeholder.

- [ ] **Step 4: Verify** — canvas shows 2 companies × their teams with nodes in Paperclip layout. Pan/zoom works. Switching team via TopBar updates canvas.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/canvas apps/web/app/page.tsx
git commit -m "feat(web): add org chart canvas with paperclip-style nodes"
```

---

## Task 7: Design mode — drag to add, connect, move, delete

**Files:**
- Create: `apps/web/components/canvas/NodePalette.tsx`, `apps/web/components/modals/NodeEditor.tsx`
- Modify: `apps/web/components/canvas/OrgCanvas.tsx`

- [ ] **Step 1: `NodePalette.tsx`** — floating panel (top-left of canvas in Design mode only) with draggable role templates: "CEO", "Manager", "Worker", "Reviewer". Uses HTML5 drag or React Flow's `useReactFlow().screenToFlowPosition` + drop handler.

- [ ] **Step 2: Handle drop on canvas** — create new agent in `useCanvasStore` at drop position.

- [ ] **Step 3: Enable `onConnect`** — creates a new edge in the store.

- [ ] **Step 4: Enable node deletion** — Backspace removes selected node + connected edges.

- [ ] **Step 5: `NodeEditor.tsx` modal** — opens when a node is double-clicked. Form: role (input), provider (select mock providers), model (input), system prompt (textarea), skills (checklist). Save updates store.

- [ ] **Step 6: Mode gating** — palette + connect + delete only active when `mode === 'design'`. Run mode = read-only.

- [ ] **Step 7: Verify** — can add, move, connect, edit, delete nodes in Design mode. Run mode locks everything.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components
git commit -m "feat(web): enable design mode editing on canvas"
```

---

## Task 8: Run mode — fake live state

**Files:**
- Modify: `apps/web/components/canvas/OrgCanvas.tsx`, `apps/web/lib/stores/useCanvasStore.ts`
- Create: `apps/web/components/canvas/ReportingEdge.tsx` (animated variant)

- [ ] **Step 1: Animated edge** — custom edge component that renders the flow with `@xyflow/react`'s `BaseEdge` and a green pill marker that travels along the path when the edge is "active". CSS animation, no real data.

- [ ] **Step 2: Run-mode simulator** — when `mode === 'run'`, start a setInterval that cycles the `isActive` flag across nodes in topological order (CEO → children → grandchildren → loop). Also toggles edges active while a "message travels". Purely visual.

- [ ] **Step 3: Verify** — clicking Run mode shows nodes pulsing in sequence with edge animations. Clicking back to Design mode stops the simulation.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components apps/web/lib/stores
git commit -m "feat(web): add run mode visual simulation with active pulses"
```

---

## Task 9: Right drawer with Chat / Triggers / Artifacts tabs

**Files:**
- Create: `apps/web/components/drawer/RightDrawer.tsx`, `apps/web/components/drawer/ChatTab.tsx`, `apps/web/components/drawer/TriggersTab.tsx`, `apps/web/components/drawer/ArtifactsTab.tsx`
- Modify: `apps/web/app/page.tsx` (add third column)

- [ ] **Step 1: `RightDrawer.tsx`** — fixed-width (360px) right column with 3 tabs at the top. Collapsible via a chevron button in TopBar.

- [ ] **Step 2: `ChatTab.tsx`** — reads mock messages for current team from store. Text input at the bottom; pressing Enter adds a new mock message (from 'user'). After 1s, auto-appends a canned agent reply (fake). Auto-scrolls to bottom.

- [ ] **Step 3: `TriggersTab.tsx`** — list of triggers from mock data. "+ Add trigger" button opens an inline form with Kind (select: chat/cron/webhook/file_watch/manual) + Config (varies by kind). Saves to store.

- [ ] **Step 4: `ArtifactsTab.tsx`** — list artifacts for current team, grouped by run, each with filename + mime icon + timestamp. Clicking opens an alert saying "preview coming in Phase 6".

- [ ] **Step 5: Update `page.tsx` grid** — three columns: sidebar (240) | canvas (1fr) | drawer (360, collapsible to 0).

- [ ] **Step 6: Verify** — all three tabs work on mock data, tab state persists, chat echo works, drawer collapses.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components apps/web/app/page.tsx
git commit -m "feat(web): add right drawer with chat, triggers, artifacts tabs"
```

---

## Task 10: Preset gallery + natural language entry

**Files:**
- Create: `apps/web/lib/presets.ts`, `apps/web/components/modals/PresetGallery.tsx`, `apps/web/components/modals/NaturalLanguageCreator.tsx`
- Modify: `apps/web/components/shell/Sidebar.tsx` (add "+ New Team" button → opens gallery)

- [ ] **Step 1: `lib/presets.ts`** — 3 canned team templates: "Report Team", "R&D Team", "Code Review Team". Each returns a fully populated `Team` object (agents + edges + starter positions).

- [ ] **Step 2: `PresetGallery.tsx` modal** — 3 cards with preview diagrams (simple SVG or emoji layout) + "Use this" button. Clicking clones preset into the current company, selects it.

- [ ] **Step 3: `NaturalLanguageCreator.tsx`** — text input "Describe your team...". Submit shows a loading spinner for 1.5s then returns the "R&D Team" preset (fake NL handler). This stays a stub until the backend wires it up in Phase 7.

- [ ] **Step 4: Verify** — "+ New Team" shows the two entry methods (preset / natural language / empty). Preset flow creates team and loads on canvas.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components apps/web/lib/presets.ts
git commit -m "feat(web): add preset gallery and natural language team creator (stub)"
```

---

## Task 11: Timeline placeholder (bottom collapsible)

**Files:**
- Create: `apps/web/components/shell/Timeline.tsx`
- Modify: `apps/web/app/page.tsx` (add 4th row)

- [ ] **Step 1: `Timeline.tsx`** — horizontal bar, collapsed by default. Expanded state shows a static gantt with 2-3 fake execution bars (agent name + time range). Toggle button at top-right.

- [ ] **Step 2: Wire into layout** — page becomes `grid-rows-[48px_1fr_auto]`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components apps/web/app/page.tsx
git commit -m "feat(web): add collapsible timeline at bottom"
```

---

## Task 12: Minimal polish + README for the frontend

**Files:**
- Create: `apps/web/README.md`
- Modify: `apps/web/app/globals.css`, `package.json` (root `dev` script)

- [ ] **Step 1: Visual pass** — verify spacing, borders, hover states match the Paperclip reference screenshot aesthetic (clean neutrals, subtle shadows). No dark mode in MVP.

- [ ] **Step 2: Keyboard shortcuts** — `D` toggles Design, `R` toggles Run, `[` toggles sidebar, `]` toggles drawer. Wire in a single `useEffect` at page level.

- [ ] **Step 3: `apps/web/README.md`** — "Phase 0A frontend shell. Run `pnpm dev` then open http://localhost:4483. All data is mocked — backend integration in Phase 0B."

- [ ] **Step 4: Sanity check**

```bash
pnpm lint
pnpm build      # verify production build works
pnpm dev        # final manual walk-through
```

- [ ] **Step 5: Commit and tag**

```bash
git add .
git commit -m "chore: polish phase 0a frontend skeleton"
git tag phase-0a-complete
```

---

## Exit Criteria

- `pnpm dev` boots `localhost:4483` with the full shell visible
- Canvas shows 2 mock companies with teams; switching between them works
- Design mode: add/move/connect/delete/edit nodes via palette and NodeEditor
- Run mode: visible pulse animation cycling through nodes + animated edges (fake)
- Right drawer: Chat (echo), Triggers (CRUD on mock), Artifacts (list)
- Preset gallery creates a new team from a template
- Natural language creator is stubbed but visually complete
- Timeline placeholder collapses/expands
- Production build (`pnpm build`) succeeds — output is a static export ready for FastAPI to serve in Phase 0B

## What's NOT in Phase 0A (explicitly deferred)

- Any real LLM calls
- FastAPI server (Phase 0B)
- LangGraph (Phase 1)
- YAML persistence (Phase 2)
- Real skill execution (Phase 3)
- OAuth providers (Phase 4)
- Real cron/webhook/file-watch (Phase 5)
- Artifact preview (Phase 6)

---

*Next plan: Phase 0B — FastAPI server + minimal single-agent chat echo wired to this frontend.*
