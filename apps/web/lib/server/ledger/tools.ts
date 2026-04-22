/**
 * Lead-only ledger tools. Registered in runNode when depth === 0.
 *
 * Sub-agents are deliberately NOT exposed to these — they are recall subjects,
 * not recall agents. See s4-work-ledger.md §0 and §4.1.
 */

import type { Tool } from '../tools/base'
import { readLedgerEntry, searchLedger } from './read'

export function ledgerTools(companySlug: string): Tool[] {
  return [
    {
      name: 'search_history',
      description:
        "Search this company's past delegated work (completed / errored / cancelled " +
        'sub-agent runs). Use BEFORE starting a large new task to check whether ' +
        'similar work already exists — prior outputs and artifacts may be reusable. ' +
        'Query syntax is SQLite FTS5: plain keywords, phrase quoting ("Q3 report"), ' +
        'prefix wildcard (report*), AND/OR/NOT. Returns entries newest first.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'FTS5 query string. Match is against task + summary + domain + agent_role.',
          },
          domain: {
            type: 'string',
            description: 'Optional exact domain filter (e.g. "research").',
          },
          team_id: {
            type: 'string',
            description: 'Optional exact team id filter.',
          },
          agent_role: {
            type: 'string',
            description: 'Optional exact agent role filter (e.g. "Researcher").',
          },
          since: {
            type: 'string',
            description: 'ISO date YYYY-MM-DD. Only entries at or after this day.',
          },
          limit: {
            type: 'integer',
            description: 'Default 10. Max 50.',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        try {
          return JSON.stringify(
            searchLedger(companySlug, args as unknown as Parameters<typeof searchLedger>[1]),
          )
        } catch (e) {
          return JSON.stringify({
            error: true,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      },
      hint: 'Searching company history…',
    },
    {
      name: 'read_history_entry',
      description:
        'Read the full body of a ledger entry by its id. Use after search_history ' +
        'when a result looks promising and you need the original output and ' +
        'artifact paths.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Entry id returned by search_history (ULID).',
          },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String((args as { id?: unknown }).id ?? '')
        try {
          return JSON.stringify(readLedgerEntry(companySlug, id))
        } catch (e) {
          return JSON.stringify({
            error: true,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      },
      hint: 'Reading history entry…',
    },
  ]
}
