# @openhive/web

Phase 0A frontend shell for OpenHive. All data is mocked — backend integration lands in
Phase 0B.

## Run

```bash
pnpm install   # from repo root
pnpm dev       # from repo root, or `pnpm --filter @openhive/web dev`
# open http://localhost:4483
```

## Structure

```
app/              Next.js App Router pages (just one: /)
components/
  shell/          TopBar, Sidebar, Timeline
  canvas/         React Flow canvas, AgentNode, ReportingEdge, NodePalette
  drawer/         RightDrawer with Chat / Triggers / Artifacts tabs
  modals/         NodeEditor, NewTeamModal (preset + NL)
  ui/             Button, Select, Segmented
lib/
  types.ts        Domain types
  mock/           Fixtures for companies / messages / triggers / artifacts
  stores/         Zustand stores (app, canvas, drawer) + run simulator
  presets.ts      Built-in team templates + NL stub
public/           logo.svg (placeholder), favicon.svg
```

## Icons

All icons are from `@phosphor-icons/react`. Do not introduce other icon libraries.
