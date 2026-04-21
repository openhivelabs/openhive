import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetForTests,
  cacheKey,
  getTeamMcpTools,
  invalidateServer,
  invalidateTeam,
} from './mcp-tools-cache'

const info = (name: string) => ({
  name,
  description: '',
  inputSchema: { type: 'object', properties: {} },
})

describe('mcp-tools-cache', () => {
  beforeEach(() => {
    __resetForTests()
  })

  it('caches across repeated calls with the same (team, servers)', async () => {
    const fetchOne = vi.fn(async (s: string) => [info(`${s}_t`)])
    await getTeamMcpTools('teamA', ['a', 'b'], fetchOne)
    await getTeamMcpTools('teamA', ['a', 'b'], fetchOne)
    expect(fetchOne).toHaveBeenCalledTimes(2) // once per server, first call only
  })

  it('normalises server order in the cache key', () => {
    expect(cacheKey('t', ['b', 'a'])).toBe(cacheKey('t', ['a', 'b']))
  })

  it('surfaces per-server errors inline without throwing', async () => {
    const fetchOne = vi.fn(async (s: string) => {
      if (s === 'bad') throw new Error('boom')
      return [info(`${s}_t`)]
    })
    const res = await getTeamMcpTools('t', ['ok', 'bad'], fetchOne)
    expect(res).toHaveLength(2)
    expect(res[0]!.error).toBeNull()
    expect(res[1]!.error).toBe('boom')
    expect(res[1]!.tools).toEqual([])
  })

  it('invalidateServer drops keys mentioning that server', async () => {
    const fetchOne = vi.fn(async (s: string) => [info(`${s}_t`)])
    await getTeamMcpTools('t', ['a', 'b'], fetchOne)
    expect(fetchOne).toHaveBeenCalledTimes(2)
    invalidateServer('a')
    await getTeamMcpTools('t', ['a', 'b'], fetchOne)
    expect(fetchOne).toHaveBeenCalledTimes(4) // both servers re-listed
  })

  it('invalidateTeam only affects the given team', async () => {
    const fetchOne = vi.fn(async (s: string) => [info(`${s}_t`)])
    await getTeamMcpTools('t1', ['a'], fetchOne)
    await getTeamMcpTools('t2', ['a'], fetchOne)
    expect(fetchOne).toHaveBeenCalledTimes(2)
    invalidateTeam('t1')
    await getTeamMcpTools('t1', ['a'], fetchOne)
    await getTeamMcpTools('t2', ['a'], fetchOne)
    expect(fetchOne).toHaveBeenCalledTimes(3) // t2 still cached
  })
})
