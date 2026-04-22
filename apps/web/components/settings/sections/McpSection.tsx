import { CheckCircle, CircleNotch, Plug, Plus, Trash, Warning, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { BRAND_COLORS, BrandIcon, hasBrand } from '@/components/mcp/BrandIcon'
import {
  type DiscoveredTool,
  type InstalledServer,
  type Preset,
  deleteServer,
  fetchPresets,
  fetchServerTools,
  fetchServers,
  installFromPreset,
  restartServer,
  testDraft,
  testInstalledServer,
} from '@/lib/api/mcp'

/** Preference order for the preset glyph:
 *   1. icon_url — full-color official asset shipped in /public/brands/
 *      (the only path that gives true brand color/gradient/multi-tone)
 *   2. brand    — monochrome simple-icons mark (good fallback, accurate
 *                 silhouette, single-color tint via BRAND_COLORS)
 *   3. icon     — emoji or unicode character from the preset YAML
 *
 * The <img> in path (1) hides itself if the asset 404s so we degrade to (2). */
function PresetGlyph({ preset, size = 20 }: { preset: Preset; size?: number }) {
  const [assetFailed, setAssetFailed] = useState(false)
  if (preset.icon_url && !assetFailed) {
    return (
      <img
        src={preset.icon_url}
        alt=""
        // Fixed-size + object-contain so different aspect ratios all sit
        // visually centered inside the parent badge with breathing room.
        className="w-5 h-5 object-contain"
        onError={() => setAssetFailed(true)}
      />
    )
  }
  if (preset.brand && hasBrand(preset.brand)) {
    return (
      <BrandIcon
        brand={preset.brand}
        color={BRAND_COLORS[preset.brand]}
        className="shrink-0"
      />
    )
  }
  return <span style={{ fontSize: size }}>{preset.icon}</span>
}

export function McpSection() {
  const [servers, setServers] = useState<InstalledServer[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<Preset | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = async () => {
    const [s, p] = await Promise.all([fetchServers(), fetchPresets()])
    setServers(s)
    setPresets(p)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-neutral-900 dark:text-neutral-100">
          MCP Servers
        </h1>
        <p className="text-[14px] text-neutral-500 mt-1">
          Connect external tools (Notion, Supabase, …) so agents can read and
          write to them. Each installed server is gated per-team in Team Settings →
          Allowed MCP Servers.
        </p>
      </header>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[14px] font-semibold text-neutral-700 dark:text-neutral-300">
            Connected
          </h2>
        </div>
        {loading ? (
          <div className="text-[14px] text-neutral-400">Loading…</div>
        ) : servers.length === 0 ? (
          <div className="text-[14px] text-neutral-400 border border-dashed border-neutral-300 rounded-md py-6 text-center">
            Nothing connected yet. Pick a service below to get started.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {servers.map((s) => (
              <ServerRow
                key={s.name}
                server={s}
                expanded={expanded === s.name}
                onToggle={() => setExpanded(expanded === s.name ? null : s.name)}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-semibold text-neutral-700 dark:text-neutral-300 mb-2">
          Add a service
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {presets.map((p) => {
            const disabled = p.coming_soon
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setAdding(p)}
                className={
                  disabled
                    ? 'text-left rounded-md border border-neutral-200 bg-neutral-50 p-3 cursor-not-allowed opacity-60 relative'
                    : 'text-left rounded-md border border-neutral-200 bg-white hover:border-neutral-400 hover:shadow-sm transition-all p-3 relative'
                }
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-8 h-8 rounded-sm flex items-center justify-center bg-neutral-50 [&_svg]:w-5 [&_svg]:h-5">
                    <PresetGlyph preset={p} />
                  </span>
                  <span className="font-semibold text-neutral-900 text-[15px]">{p.name}</span>
                  {disabled && (
                    <span className="ml-auto text-[10.5px] uppercase tracking-wide font-semibold text-neutral-500 bg-neutral-200 px-1.5 py-0.5 rounded-sm">
                      Soon
                    </span>
                  )}
                </div>
                <p className="text-[13px] text-neutral-500 mt-1.5 leading-snug line-clamp-2">
                  {p.description}
                </p>
              </button>
            )
          })}
        </div>
      </section>

      {adding && (
        <AddServerModal
          preset={adding}
          existingNames={new Set(servers.map((s) => s.name))}
          onClose={() => setAdding(null)}
          onInstalled={async () => {
            setAdding(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function ServerRow({
  server,
  expanded,
  onToggle,
  onChanged,
}: {
  server: InstalledServer
  expanded: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
}) {
  const [tools, setTools] = useState<DiscoveredTool[] | null>(null)
  const [busy, setBusy] = useState<'test' | 'restart' | 'delete' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || tools !== null) return
    void (async () => {
      try {
        const r = await fetchServerTools(server.name)
        setTools(r.tools)
        setErr(null)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [expanded, tools, server.name])

  const dot = server.last_error
    ? 'bg-red-500'
    : server.running
      ? 'bg-emerald-500'
      : 'bg-neutral-300'

  return (
    <li className="rounded-md border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-neutral-50"
      >
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-[15px] font-medium text-neutral-900 truncate">{server.name}</span>
        <span className="text-[13px] text-neutral-400 font-mono truncate">
          {server.preset_id ? `from ${server.preset_id}` : 'custom'}
        </span>
        <span className="ml-auto text-[13px] text-neutral-500">
          {server.tool_count !== null ? `${server.tool_count} tools` : '—'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-neutral-100">
          <div className="text-[12px] text-neutral-500 font-mono break-all">
            <code>
              {server.command} {server.args.join(' ')}
            </code>
            {server.env_keys.length > 0 && (
              <div className="mt-0.5 text-neutral-400">
                env: {server.env_keys.join(', ')}
              </div>
            )}
          </div>
          {server.last_error && (
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 whitespace-pre-wrap">
              {server.last_error}
            </div>
          )}
          {err && (
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 whitespace-pre-wrap">
              {err}
            </div>
          )}
          <div className="text-[13px]">
            <div className="font-medium text-neutral-700 mb-1">Tools</div>
            {tools === null ? (
              <div className="text-neutral-400">Discovering…</div>
            ) : tools.length === 0 ? (
              <div className="text-neutral-400">No tools reported.</div>
            ) : (
              <ul className="max-h-[260px] overflow-y-auto space-y-0.5 font-mono text-[12.5px]">
                {tools.map((t) => (
                  <li key={t.name} className="text-neutral-700">
                    <span className="text-neutral-900">{t.name}</span>
                    {t.description && (
                      <span className="text-neutral-400"> — {t.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('test')
                setErr(null)
                try {
                  const r = await testInstalledServer(server.name)
                  if (!r.ok) setErr(r.error || 'test failed')
                  else if (r.tools) setTools(r.tools)
                } finally {
                  setBusy(null)
                  await onChanged()
                }
              }}
              className="text-[13px] px-2.5 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
            >
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('restart')
                try {
                  await restartServer(server.name)
                  setTools(null)
                } finally {
                  setBusy(null)
                  await onChanged()
                }
              }}
              className="text-[13px] px-2.5 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
            >
              Restart
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                if (!confirm(`Delete MCP server "${server.name}"?`)) return
                setBusy('delete')
                try {
                  await deleteServer(server.name)
                } finally {
                  setBusy(null)
                  await onChanged()
                }
              }}
              className="text-[13px] px-2.5 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 ml-auto"
            >
              <Trash className="inline w-3 h-3 mr-1" />
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function AddServerModal({
  preset,
  existingNames,
  onClose,
  onInstalled,
}: {
  preset: Preset
  existingNames: Set<string>
  onClose: () => void
  onInstalled: () => Promise<void>
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [test, setTest] = useState<{ tools?: DiscoveredTool[]; error?: string } | null>(null)
  const [busy, setBusy] = useState<'test' | 'install' | null>(null)

  // Auto-derive a unique name from the preset id. If the user already has a
  // server called "notion", we mint "notion-2", "notion-3", … so the user never
  // sees the field. Power users who want a custom name can rename in YAML.
  const name = useMemo(() => {
    if (!existingNames.has(preset.id)) return preset.id
    let n = 2
    while (existingNames.has(`${preset.id}-${n}`)) n += 1
    return `${preset.id}-${n}`
  }, [preset.id, existingNames])

  const requiredMissing = useMemo(
    () => preset.inputs.filter((i) => i.required && !(inputs[i.key] ?? '').trim()),
    [preset, inputs],
  )

  const canSubmit = requiredMissing.length === 0 && busy === null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className="w-[560px] max-w-[94vw] rounded-md bg-white shadow-xl border border-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-200">
          <div className="flex items-center gap-2 [&_svg]:w-5 [&_svg]:h-5">
            <PresetGlyph preset={preset} />
            <h2 className="text-base font-semibold">Connect {preset.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-sm hover:bg-neutral-100"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-[14px] text-neutral-500">{preset.description}</p>
          {preset.inputs.map((inp) => (
            <div key={inp.key}>
              <label className="text-[13px] font-medium text-neutral-600">
                {inp.label}
                {inp.required && <span className="text-red-500"> *</span>}
              </label>
              <input
                type={inp.type === 'secret' ? 'password' : 'text'}
                value={inputs[inp.key] ?? ''}
                onChange={(e) =>
                  setInputs({ ...inputs, [inp.key]: e.target.value })
                }
                placeholder={inp.placeholder}
                className="mt-1 w-full px-2.5 py-1.5 text-[14px] rounded-sm border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-300"
              />
              {inp.help_text && (
                <div className="text-[12px] text-neutral-500 mt-1 whitespace-pre-wrap">
                  {inp.help_text}
                </div>
              )}
            </div>
          ))}

          {test && test.error && (
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
              <Warning className="inline w-3.5 h-3.5 mr-1" />
              {test.error}
            </div>
          )}
          {test && test.tools && (
            <div className="text-[13px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2.5 py-2">
              <CheckCircle className="inline w-3.5 h-3.5 mr-1" />
              Connected — {test.tools.length} tools discovered
              {test.tools.length > 0 && (
                <ul className="mt-1.5 text-[12px] text-emerald-900 max-h-[120px] overflow-y-auto font-mono">
                  {test.tools.slice(0, 12).map((t) => (
                    <li key={t.name}>• {t.name}</li>
                  ))}
                  {test.tools.length > 12 && (
                    <li className="text-emerald-700">…and {test.tools.length - 12} more</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy !== null || requiredMissing.length > 0}
            onClick={async () => {
              setBusy('test')
              setTest(null)
              try {
                const r = await testDraft({ preset_id: preset.id, inputs })
                setTest(r.ok ? { tools: r.tools } : { error: r.error })
              } catch (e) {
                setTest({ error: e instanceof Error ? e.message : String(e) })
              } finally {
                setBusy(null)
              }
            }}
            className="text-[14px] px-3 py-1.5 rounded border border-neutral-300 hover:bg-neutral-50 disabled:opacity-50"
          >
            {busy === 'test' && <CircleNotch className="inline w-3.5 h-3.5 animate-spin mr-1" />}
            Test connection
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              setBusy('install')
              try {
                await installFromPreset(preset.id, name, inputs)
                await onInstalled()
              } finally {
                setBusy(null)
              }
            }}
            className="text-[14px] px-3 py-1.5 rounded bg-neutral-900 text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy === 'install' ? (
              <CircleNotch className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plug className="w-3.5 h-3.5" />
            )}
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}
