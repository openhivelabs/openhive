/**
 * db-skill tool factory. Native LLM tools that expose per-team data.db to
 * the engine. All tools emit a JSON string (success or structured error
 * envelope) so the LLM can self-correct via `error_code` + `suggestion`.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ToolsManifest, WritePolicy } from '../agents/loader'
import { packagesRoot } from '../paths'
import {
  type SqlParam,
  describeSchema,
  hasMultipleStatements,
  installTemplate,
  isDestructiveSql,
  runExec,
  runQuery,
  withTeamDb,
} from '../team-data'
import type { Tool } from './base'

const MAX_QUERY_LIMIT = Number.parseInt(
  process.env.OPENHIVE_DB_QUERY_LIMIT ?? '500',
  10,
)
const HARD_CAP = 5000

type Envelope =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error_code: string; message: string; suggestion: string }

function deny(
  error_code: string,
  message: string,
  suggestion: string,
): Envelope {
  return { ok: false, error_code, message, suggestion }
}

function policyPass(policy: WritePolicy): 'pass' | 'deny' | 'ask' {
  if (policy === true) return 'pass'
  if (policy === 'ask') return 'ask'
  return 'deny'
}

const SELECT_RE = /^\s*(SELECT|WITH)\b/i
const DDL_RE = /^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i

function paramsFromArgs(args: Record<string, unknown>): SqlParam[] {
  const raw = args.params
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is SqlParam =>
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'bigint' ||
      v instanceof Uint8Array,
  )
}

function errorCodeOf(e: unknown): string | null {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return null
}

export function teamDataTools(
  teamSlugs: [string, string],
  manifest: ToolsManifest,
): Tool[] {
  const [companySlug, teamSlug] = teamSlugs
  const tools: Tool[] = []

  tools.push({
    name: 'db_describe',
    description:
      "List tables, columns, row counts, and recent migrations in this team's SQLite " +
      'data.db (per-team, WAL, JSON1 on, isolated from engine state). Call this FIRST ' +
      'before any SQL. Empty DB is the normal starting state — your first job is often ' +
      'to design the schema with the user. Hybrid rule: use columns for fields you will ' +
      'filter/sort/index by, use `data` JSON for tail metadata. For deeper patterns call ' +
      '`db_read_guide`.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      if (!manifest.team_data_read) {
        return JSON.stringify(
          deny(
            'read_denied',
            'Persona has team_data.read: false',
            'Ask the user to enable read access in tools.yaml for this persona.',
          ),
        )
      }
      try {
        const schema = describeSchema(companySlug, teamSlug)
        const empty = schema.tables.length === 0
        return JSON.stringify({
          ok: true,
          ...schema,
          empty,
          ...(empty
            ? {
                hint:
                  'DB is empty — design schema via db_exec (CREATE TABLE ...). ' +
                  'Call db_read_guide("hybrid-schema") if unfamiliar with the column+JSON1 pattern.',
              }
            : {}),
        })
      } catch (exc) {
        return JSON.stringify(
          deny(
            'internal',
            exc instanceof Error ? exc.message : String(exc),
            'Retry; if it persists, inspect the data.db file manually.',
          ),
        )
      }
    },
    hint: 'Reading schema…',
  })

  tools.push({
    name: 'db_query',
    description:
      "Run one read-only SQL statement (SELECT or WITH) against this team's data.db. " +
      'Always use ? placeholders with the `params` array — never string-concat user data. ' +
      'Returns {columns, rows, truncated, elapsed_ms}. Results are capped at `limit` ' +
      '(default 500, max 5000). Call `db_explain` first if the query may touch >1k rows.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH statement.' },
        params: {
          type: 'array',
          description: 'Positional ? bindings (strings, numbers, nulls).',
          items: {},
        },
        limit: {
          type: 'integer',
          description: `Row cap (default ${MAX_QUERY_LIMIT}, max ${HARD_CAP}).`,
        },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      if (!manifest.team_data_read) {
        return JSON.stringify(
          deny(
            'read_denied',
            'Persona has team_data.read: false',
            'Ask the user to enable read access for this persona.',
          ),
        )
      }
      const sql = String(args.sql ?? '')
      if (!SELECT_RE.test(sql)) {
        return JSON.stringify(
          deny(
            'not_a_select',
            'db_query only runs SELECT/WITH',
            'Use db_exec for INSERT/UPDATE/DELETE/DDL.',
          ),
        )
      }
      if (hasMultipleStatements(sql)) {
        return JSON.stringify(
          deny(
            'multi_statement',
            'Only one SQL statement per call',
            'Split into separate db_query calls.',
          ),
        )
      }
      const askedLimit = Number.parseInt(String(args.limit ?? MAX_QUERY_LIMIT), 10)
      const limit = Math.min(
        Math.max(1, Number.isFinite(askedLimit) ? askedLimit : MAX_QUERY_LIMIT),
        HARD_CAP,
      )
      const wrapped = /\blimit\b/i.test(sql) ? sql : `SELECT * FROM (${sql}) LIMIT ${limit + 1}`
      const started = Date.now()
      try {
        const res = runQuery(companySlug, teamSlug, wrapped, {
          params: paramsFromArgs(args),
        })
        const truncated = res.rows.length > limit
        const rows = truncated ? res.rows.slice(0, limit) : res.rows
        return JSON.stringify({
          ok: true,
          columns: res.columns,
          rows,
          truncated,
          elapsed_ms: Date.now() - started,
        })
      } catch (exc) {
        const code = errorCodeOf(exc) ?? 'syntax'
        return JSON.stringify(
          deny(
            code === 'timeout' ? 'timeout' : code === 'multi_statement' ? 'multi_statement' : 'syntax',
            exc instanceof Error ? exc.message : String(exc),
            code === 'timeout'
              ? 'Narrow the query (add WHERE, LIMIT) or call db_explain first.'
              : 'Fix the SQL and retry.',
          ),
        )
      }
    },
    hint: 'Querying…',
  })

  tools.push({
    name: 'db_exec',
    description:
      "Run one write or DDL statement against this team's data.db (INSERT/UPDATE/DELETE/" +
      'CREATE/ALTER/DROP). Use ? placeholders + `params`. DDL is auto-logged to ' +
      'schema_migrations. Destructive operations (DROP TABLE, TRUNCATE, DELETE/UPDATE ' +
      'without WHERE) require `confirm_destructive: true` — explain the blast radius to ' +
      'the user before setting this. Prefer ALTER over DROP, and the `data` JSON column ' +
      'for ad-hoc fields before adding a new column.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array', items: {} },
        note: { type: 'string', description: 'Why this change. Optional.' },
        confirm_destructive: {
          type: 'boolean',
          description: 'Required to run DROP TABLE, TRUNCATE, or WHERE-less DELETE/UPDATE.',
        },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      const sql = String(args.sql ?? '')
      if (hasMultipleStatements(sql)) {
        return JSON.stringify(
          deny(
            'multi_statement',
            'Only one SQL statement per call',
            'Issue each statement in a separate db_exec call.',
          ),
        )
      }
      const isDdl = DDL_RE.test(sql)
      const policy = isDdl ? manifest.team_data_ddl : manifest.team_data_write
      const p = policyPass(policy)
      if (p === 'deny') {
        const code = isDdl ? 'ddl_denied' : 'write_denied'
        return JSON.stringify(
          deny(
            code,
            `Persona has team_data.${isDdl ? 'ddl' : 'write'}: false`,
            `Ask the user to enable ${isDdl ? 'ddl' : 'write'} access in tools.yaml.`,
          ),
        )
      }
      if (p === 'ask') {
        return JSON.stringify(
          deny(
            'needs_approval',
            `team_data.${isDdl ? 'ddl' : 'write'} is set to "ask"`,
            'Escalate to the user: ask them to promote the policy to true or approve this call manually.',
          ),
        )
      }
      if (isDestructiveSql(sql) && args.confirm_destructive !== true) {
        return JSON.stringify(
          deny(
            'destructive_unconfirmed',
            'Destructive statement requires confirm_destructive: true',
            'Explain the blast radius (which rows/tables will be lost) to the user, then re-invoke with confirm_destructive: true.',
          ),
        )
      }
      const started = Date.now()
      try {
        const res = runExec(companySlug, teamSlug, sql, {
          source: 'ai',
          note: typeof args.note === 'string' ? args.note : null,
          params: paramsFromArgs(args),
        })
        return JSON.stringify({ ...res, ok: true, elapsed_ms: Date.now() - started })
      } catch (exc) {
        const code = errorCodeOf(exc) ?? 'syntax'
        return JSON.stringify(
          deny(
            code,
            exc instanceof Error ? exc.message : String(exc),
            code === 'timeout'
              ? 'Narrow the operation; very large DELETE/UPDATE may need batching.'
              : 'Fix the SQL and retry.',
          ),
        )
      }
    },
    hint: 'Writing data…',
  })

  tools.push({
    name: 'db_explain',
    description:
      'Return the SQLite `EXPLAIN QUERY PLAN` for a SELECT/WITH statement. Use before ' +
      'long queries to see if indexes are being hit. Returns {plan: [{id, parent, detail}]}.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array', items: {} },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      if (!manifest.team_data_read) {
        return JSON.stringify(
          deny('read_denied', 'Persona has team_data.read: false', 'Enable read access.'),
        )
      }
      const sql = String(args.sql ?? '')
      if (!SELECT_RE.test(sql)) {
        return JSON.stringify(
          deny('not_a_select', 'db_explain only supports SELECT/WITH', 'Rewrite as a SELECT.'),
        )
      }
      if (hasMultipleStatements(sql)) {
        return JSON.stringify(
          deny('multi_statement', 'Only one statement per call', 'Split into separate calls.'),
        )
      }
      try {
        const bindings = paramsFromArgs(args)
        const rows = withTeamDb(companySlug, teamSlug, (conn) => {
          const stmt = conn.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          return (bindings.length > 0 ? stmt.all(...bindings) : stmt.all()) as Record<
            string,
            unknown
          >[]
        })
        return JSON.stringify({ ok: true, plan: rows })
      } catch (exc) {
        return JSON.stringify(
          deny(
            errorCodeOf(exc) ?? 'syntax',
            exc instanceof Error ? exc.message : String(exc),
            'Fix the SQL and retry.',
          ),
        )
      }
    },
    hint: 'Planning…',
  })

  tools.push({
    name: 'db_install_template',
    description:
      "Install a pre-defined schema template (bundled SQL script) into this team's data.db. " +
      "Only templates whitelisted in this persona's tools.yaml (team_data.templates) are " +
      'allowed. Returns {tables_created: [...]}. Use as an alternative to designing the ' +
      "schema from scratch when a template fits the user's intent.",
    parameters: {
      type: 'object',
      properties: {
        template_name: { type: 'string' },
      },
      required: ['template_name'],
    },
    handler: async (args) => {
      if (policyPass(manifest.team_data_ddl) !== 'pass') {
        return JSON.stringify(
          deny(
            'ddl_denied',
            'Installing a template runs DDL; team_data.ddl must be true',
            'Ask the user to enable ddl for this persona.',
          ),
        )
      }
      const name = String(args.template_name ?? '')
      if (!manifest.team_data_templates.includes(name)) {
        return JSON.stringify(
          deny(
            'unknown_template',
            `Template "${name}" not in whitelist`,
            `Valid: ${JSON.stringify(manifest.team_data_templates)}. Ask the user to whitelist it in tools.yaml.`,
          ),
        )
      }
      try {
        const res = installTemplate(companySlug, teamSlug, name)
        return JSON.stringify({ ...res, ok: true })
      } catch (exc) {
        const code = errorCodeOf(exc) ?? 'internal'
        return JSON.stringify(
          deny(
            code === 'ENOENT' ? 'unknown_template' : code,
            exc instanceof Error ? exc.message : String(exc),
            'Check the template name and OPENHIVE_TEMPLATES_DIR.',
          ),
        )
      }
    },
    hint: 'Installing template…',
  })

  const GUIDE_TOPICS = ['hybrid-schema', 'json1', 'indexes', 'patterns', 'perf'] as const
  tools.push({
    name: 'db_read_guide',
    description:
      'Load a deeper reference guide for DB design. Topics: hybrid-schema (columns vs JSON1), ' +
      'json1 (extract/set/each recipes), indexes (expr/partial/covering), patterns (upsert, ' +
      'soft-delete, FTS5, rollups), perf (reading EXPLAIN, avoiding N+1). Call only when ' +
      'you need specifics — the tool descriptions carry the basics.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: GUIDE_TOPICS as unknown as string[] },
      },
      required: ['topic'],
    },
    handler: async (args) => {
      const topic = String(args.topic ?? '')
      if (!(GUIDE_TOPICS as readonly string[]).includes(topic)) {
        return JSON.stringify({
          ok: false,
          error_code: 'unknown_topic',
          message: `Unknown topic "${topic}"`,
          suggestion: `Valid topics: ${GUIDE_TOPICS.join(', ')}.`,
          valid: GUIDE_TOPICS,
        })
      }
      const file = path.join(packagesRoot(), 'skills', 'db', 'reference', `${topic}.md`)
      try {
        const content = fs.readFileSync(file, 'utf8')
        return JSON.stringify({ ok: true, topic, content })
      } catch {
        return JSON.stringify(
          deny(
            'guide_missing',
            `Guide file not found: ${file}`,
            'Report this to the operator — the guide bundle may be incomplete.',
          ),
        )
      }
    },
    hint: 'Loading guide…',
  })

  return tools
}
