import { extractJson } from '@/lib/server/ai-generators/common'
import { chatCompletion } from '@/lib/server/providers/copilot'
import { Hono } from 'hono'

export const ai = new Hono()

const FILTER_OPS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false',
] as const
type FilterOp = (typeof FILTER_OPS)[number]

interface ReqColumn {
  name: string
  kind: 'string' | 'number' | 'date' | 'boolean'
}
interface Body {
  columns?: ReqColumn[]
  query?: string
}

function systemPrompt(columns: ReqColumn[]): string {
  const schema = columns.map((c) => `- ${c.name} (${c.kind})`).join('\n')
  return `You translate a user's natural-language question into a set of filter rules over a tabular dataset.

AVAILABLE COLUMNS:
${schema}

VALID OPERATORS by column kind:
- string: contains, not_contains, equals, not_equals, is_empty, is_not_empty
- number: equals, not_equals, gt, gte, lt, lte, is_empty, is_not_empty
- date:   equals, gt, lt, is_empty, is_not_empty
- boolean: is_true, is_false

Return ONLY a JSON object, no prose, no markdown fences:

{
  "filters": [
    { "column": "<one of the column names above>", "op": "<one of the operators valid for that column's kind>", "value": "<string; empty string if op is is_empty/is_not_empty/is_true/is_false>" }
  ]
}

Rules:
- Only use column names that appear above. If none match, return an empty filters array.
- "value" must be a string (numbers and dates as their textual form: "5", "2026-04-22").
- For dates prefer ISO 8601 (YYYY-MM-DD).
- Prefer the tightest operator that matches the user's intent (e.g. "greater than 5" → gt, not gte).
- Keep filters minimal; do not invent conditions the user didn't ask for.`
}

// POST /api/ai/records-filter
ai.post('/records-filter', async (c) => {
  let body: Body
  try {
    body = (await c.req.json()) as Body
  } catch {
    return c.json({ detail: 'invalid JSON body' }, 400)
  }
  const columns = Array.isArray(body.columns) ? body.columns : []
  const query = body.query?.trim()
  if (columns.length === 0) {
    return c.json({ detail: 'columns is required' }, 400)
  }
  if (!query) {
    return c.json({ detail: 'query is required' }, 400)
  }

  try {
    const text = await chatCompletion({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: systemPrompt(columns) },
        { role: 'user', content: query },
      ],
      temperature: 0.2,
    })
    const parsed = extractJson(text)
    const raw = Array.isArray(parsed.filters) ? parsed.filters : []
    const colKinds = new Map(columns.map((c) => [c.name, c.kind] as const))
    const filters = raw
      .map((f) => f as Record<string, unknown>)
      .map((f) => {
        const column = String(f.column ?? '').trim()
        const op = String(f.op ?? '').trim() as FilterOp
        const value = f.value === null || f.value === undefined ? '' : String(f.value)
        return { column, op, value }
      })
      .filter((f) => colKinds.has(f.column) && (FILTER_OPS as readonly string[]).includes(f.op))
    return c.json({ filters })
  } catch (exc) {
    return c.json({ detail: exc instanceof Error ? exc.message : String(exc) }, 500)
  }
})
