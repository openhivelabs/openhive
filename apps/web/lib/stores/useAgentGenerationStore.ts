import { create } from 'zustand'
import { saveTeam } from '../api/companies'
import type { Agent, Company, Team } from '../types'
import { useAppStore } from './useAppStore'

export interface GenerationJob {
  /** Client-generated id. Written to localStorage BEFORE the POST fires so
   *  a mid-POST refresh doesn't lose the job. Server uses it verbatim. */
  id: string
  description: string
  companySlug: string
  teamId: string
  /** When the job was created (Date.now). Used to give a short grace window
   *  for poll 404s: server may not have registered the POST yet, or the
   *  original POST might have failed and the user hasn't reloaded long
   *  enough to retry. */
  startedAt: number
  error?: string
}

interface State {
  jobs: GenerationJob[]
  hydrated: boolean
  hydrate: () => void
  start: (description: string) => Promise<void>
  retry: (id: string) => Promise<void>
  dismiss: (id: string) => void
}

const STORAGE_KEY = 'openhive.agentGenerationJobs'
const POLL_INTERVAL_MS = 2000

function readStorage(): GenerationJob[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (j): j is Partial<GenerationJob> =>
          typeof j === 'object' &&
          j !== null &&
          typeof (j as GenerationJob).id === 'string' &&
          typeof (j as GenerationJob).description === 'string' &&
          typeof (j as GenerationJob).companySlug === 'string' &&
          typeof (j as GenerationJob).teamId === 'string',
      )
      .map((j) => ({
        id: j.id as string,
        description: j.description as string,
        companySlug: j.companySlug as string,
        teamId: j.teamId as string,
        startedAt: typeof j.startedAt === 'number' ? j.startedAt : Date.now(),
        error: j.error,
      }))
  } catch {
    return []
  }
}

function writeStorage(jobs: GenerationJob[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs))
  } catch {
    /* quota / disabled — ignore */
  }
}

// saveTeam chain: serialize concurrent writes so last-write-wins can't wipe
// an agent another in-flight job just appended.
let saveChain: Promise<void> = Promise.resolve()

async function appendAgentToTeam(
  companySlug: string,
  teamId: string,
  agent: Agent,
): Promise<void> {
  await new Promise<void>((resolve) => {
    saveChain = saveChain.then(async () => {
      try {
        const st = useAppStore.getState()
        let latestTeam: Team | null = null
        const updatedCompanies: Company[] = st.companies.map((c) => {
          if (c.slug !== companySlug) return c
          return {
            ...c,
            teams: c.teams.map((t) => {
              if (t.id !== teamId) return t
              // Guard against duplicates if the same job id somehow
              // completes twice (shouldn't, but localStorage + polling
              // resume could race on a cold start).
              if (t.agents.some((a) => a.id === agent.id)) {
                latestTeam = t
                return t
              }
              const next = { ...t, agents: [...t.agents, agent] }
              latestTeam = next
              return next
            }),
          }
        })
        useAppStore.setState({ companies: updatedCompanies })
        if (latestTeam) {
          const saved = await saveTeam(companySlug, latestTeam).catch((e) => {
            console.error('[agent generate] saveTeam failed', e)
            return null
          })
          if (saved) {
            const cur = useAppStore.getState()
            useAppStore.setState({
              companies: cur.companies.map((c) => {
                if (c.slug !== companySlug) return c
                return {
                  ...c,
                  teams: c.teams.map((t) => {
                    if (t.id !== teamId) return t
                    const byId = new Map(saved.agents.map((a) => [a.id, a]))
                    return {
                      ...t,
                      agents: t.agents.map((a) => {
                        const patch = byId.get(a.id)
                        if (!patch) return a
                        return {
                          ...a,
                          personaPath: a.personaPath ?? patch.personaPath,
                          personaName: a.personaName ?? patch.personaName,
                        }
                      }),
                    }
                  }),
                }
              }),
            })
          }
        }
      } finally {
        resolve()
      }
    })
  })
}

function toAgent(raw: Record<string, unknown>, fallbackProviderId: string, fallbackModel: string): Agent {
  const personaPath =
    typeof raw.persona_path === 'string' && raw.persona_path ? raw.persona_path : undefined
  const personaName =
    typeof raw.persona_name === 'string' && raw.persona_name ? raw.persona_name : undefined
  return {
    id: String(raw.id ?? ''),
    role: String(raw.role ?? 'Member'),
    label: String(raw.label ?? 'Copilot'),
    providerId: String(raw.provider_id ?? fallbackProviderId),
    model: String(raw.model ?? fallbackModel),
    systemPrompt: String(raw.system_prompt ?? ''),
    skills: (raw.skills as string[]) ?? [],
    position: (raw.position as { x: number; y: number }) ?? { x: 0, y: 0 },
    personaPath,
    personaName,
  }
}

function rid() {
  return `genjob-${Math.random().toString(36).slice(2, 10)}`
}

async function postStart(job: GenerationJob): Promise<boolean> {
  const app = useAppStore.getState()
  if (!app.defaultModel) return false
  try {
    const res = await fetch('/api/agents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: job.description,
        company_slug: job.companySlug,
        provider_id: app.defaultModel.providerId,
        model: app.defaultModel.model,
        client_job_id: job.id,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.warn('[agent generate] start failed', res.status, text)
      return false
    }
    return true
  } catch (e) {
    console.warn('[agent generate] start network error', e)
    return false
  }
}

// Debounce resubmit attempts so we don't hammer the server if every 2s poll
// tries to resend.
const resubmitInFlight = new Set<string>()
async function resubmitIfPossible(job: GenerationJob) {
  if (resubmitInFlight.has(job.id)) return
  resubmitInFlight.add(job.id)
  try {
    await postStart(job)
  } finally {
    resubmitInFlight.delete(job.id)
  }
}

const pollers = new Map<string, ReturnType<typeof setTimeout>>()

function stopPolling(jobId: string) {
  const handle = pollers.get(jobId)
  if (handle) {
    clearTimeout(handle)
    pollers.delete(jobId)
  }
}

function setJobError(jobId: string, message: string) {
  useAgentGenerationStore.setState((s) => {
    const jobs = s.jobs.map((j) => (j.id === jobId ? { ...j, error: message } : j))
    writeStorage(jobs)
    return { jobs }
  })
}

function removeJob(jobId: string) {
  useAgentGenerationStore.setState((s) => {
    const jobs = s.jobs.filter((j) => j.id !== jobId)
    writeStorage(jobs)
    return { jobs }
  })
}

// Grace window during which a 404 means "server hasn't registered yet / POST
// is still in flight" rather than "job lost". Covers the reload-immediately-
// after-clicking-Generate race.
const REGISTRATION_GRACE_MS = 15_000

async function pollOnce(job: GenerationJob): Promise<void> {
  try {
    const res = await fetch(`/api/agents/generate/${encodeURIComponent(job.id)}`)
    if (res.status === 404) {
      const inGrace = Date.now() - job.startedAt < REGISTRATION_GRACE_MS
      if (inGrace) {
        // Also try to (re)submit — covers the case where the original POST
        // never reached the server because the tab was killed mid-flight.
        void resubmitIfPossible(job)
        schedulePoll(job)
        return
      }
      setJobError(job.id, 'generation lost (server restarted)')
      stopPolling(job.id)
      return
    }
    if (!res.ok) {
      // Transient — try again next tick.
      schedulePoll(job)
      return
    }
    const body = (await res.json()) as {
      status: 'pending' | 'done' | 'error'
      result?: Record<string, unknown>
      error?: string
    }
    if (body.status === 'pending') {
      schedulePoll(job)
      return
    }
    if (body.status === 'error') {
      setJobError(job.id, body.error ?? 'generation failed')
      stopPolling(job.id)
      return
    }
    // done
    if (!body.result) {
      setJobError(job.id, 'empty result')
      stopPolling(job.id)
      return
    }
    const app = useAppStore.getState()
    const fallbackProviderId = app.defaultModel?.providerId ?? ''
    const fallbackModel = app.defaultModel?.model ?? ''
    const agent = toAgent(body.result, fallbackProviderId, fallbackModel)
    const warnings = Array.isArray(body.result.warnings) ? (body.result.warnings as string[]) : undefined
    if (warnings && warnings.length > 0) console.warn('[agent generate]', warnings)
    await appendAgentToTeam(job.companySlug, job.teamId, agent)
    removeJob(job.id)
    stopPolling(job.id)
  } catch (e) {
    // Network blip — keep trying.
    console.warn('[agent generate] poll error', e)
    schedulePoll(job)
  }
}

function schedulePoll(job: GenerationJob) {
  stopPolling(job.id)
  const handle = setTimeout(() => {
    void pollOnce(job)
  }, POLL_INTERVAL_MS)
  pollers.set(job.id, handle)
}

export const useAgentGenerationStore = create<State>((set, get) => ({
  jobs: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return
    const jobs = readStorage()
    set({ jobs, hydrated: true })
    // Resume polling for any job that was pending without an error.
    for (const job of jobs) {
      if (!job.error) schedulePoll(job)
    }
  },
  start: async (description) => {
    const app = useAppStore.getState()
    const company = app.companies.find((c) => c.id === app.currentCompanyId)
    if (!company || !app.currentTeamId || !app.defaultModel) return
    const job: GenerationJob = {
      id: rid(),
      description,
      companySlug: company.slug,
      teamId: app.currentTeamId,
      startedAt: Date.now(),
    }
    // Persist BEFORE firing the POST so a mid-flight refresh doesn't drop
    // the job. If the POST itself fails, the first poll's 404 + grace
    // window will resubmit.
    set((s) => {
      const jobs = [...s.jobs, job]
      writeStorage(jobs)
      return { jobs }
    })
    schedulePoll(job)
    await postStart(job)
  },
  retry: async (id) => {
    const job = get().jobs.find((j) => j.id === id)
    if (!job) return
    // Remove old job, kick off a new one with same description.
    removeJob(id)
    stopPolling(id)
    await get().start(job.description)
  },
  dismiss: (id) => {
    stopPolling(id)
    removeJob(id)
  },
}))
