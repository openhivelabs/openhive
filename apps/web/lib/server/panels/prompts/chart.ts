/**
 * Chart-specific assembly chapter. Loaded on top of common.ts when the
 * bind target is `panel.type === 'chart'`. Focuses on what's unique to
 * charts: 1D vs 2D grouping, time-series bucketing, aggregation, pie
 * sanity, ordering. Visual variant (bar/line/area/pie/heatmap) lives on
 * `panel.props.variant` from the frame manifest — not the binder's job.
 */
export const CHART_CHAPTER = `CHART PANELS (type=chart): the renderer expects a series-shaped payload
that the mapper produces from your SQL + map. Variant (bar / line / area /
pie / heatmap) is fixed by the panel frame's \`props.variant\` — your job is
to give the mapper enough to build the series, not to pick a chart kind.

GROUPING AXES:
- 1D charts (bar, line, area, pie): emit \`map.group_by\` only.
  - bar/line/area: \`group_by\` = x-axis category or time bucket.
  - pie: \`group_by\` = slice key. Keep it ≤ 6 distinct values — add
    \`ORDER BY <agg> DESC LIMIT 6\` (or aggregate the long tail into an
    "Other" bucket via CASE WHEN row_number() ...) when the natural
    cardinality is higher.
- 2D charts (stacked bar/area, multi-series line, heatmap): emit BOTH
  \`map.group_by\` (x-axis) AND \`map.series_by\` (second axis). The SQL
  MUST SELECT both columns; the mapper buckets rows into a (group, series)
  matrix.
- variant=heatmap reads the same 2D shape — the mapper emits a matrix
  that either a stacked chart or a heatmap can render. You don't need to
  branch on variant.

VALUE AXIS — pick ONE:
1. Aggregate in SQL (preferred when many rows feed one bar/point):
   \`SELECT bucket, COUNT(*) AS value FROM ... GROUP BY bucket\`
   Then \`map.value: "value"\` and OMIT \`aggregate\` — the column is
   already the y-value, one row per bucket.
2. Aggregate in the mapper (when SQL returns raw rows): leave the SQL
   ungrouped and set \`map.aggregate: "count|sum|avg|min|max"\` plus
   \`aggregate_field\` (omit for "count"). The mapper buckets by group_by
   on its own.
   Never mix the two — picking SQL-side aggregation AND \`map.aggregate\`
   double-counts.

TIME-SERIES (line/area, or bar over a date range):
- The SQL MUST aggregate by a calendar bucket. Group by
  \`date(<ts>)\` (SQLite / team_data) or \`date_trunc('day', <ts>)::date\`
  (Postgres / Supabase). Grouping by the raw timestamp gives one row per
  microsecond and every value is 1.
- ALWAYS \`ORDER BY <bucket> ASC\` so the line has a left-to-right time
  axis. For non-time bar charts, prefer \`ORDER BY <value> DESC\` for
  top-down ranking.
- The SELECT list must include the bucket column with the SAME alias used
  in \`map.group_by\` (e.g. \`SELECT date(created_at) AS day, COUNT(*) AS
  value ...\` then \`map.group_by: "day"\`).

SQL CHECKLIST for chart bindings:
- Every column referenced in map.group_by / map.series_by /
  map.aggregate_field / map.value MUST appear in the SELECT list (under
  exactly that name — alias when SQL would otherwise expose a different
  label).
- For team_data: \`WHERE team_id = :team_id\` always (common rule).
- ORDER BY: time bucket ASC for time-series; aggregate DESC for ranked
  bar/pie; group_by ASC otherwise.
- LIMIT only for pie (slice cap) or when the user explicitly asks for
  "top N". Bar/line/area should not LIMIT — let \`props.time_ranges\`
  handle window sizing client-side.

OMISSIONS for chart panels:
- No \`map.title\`, \`map.columns\`, \`map.on_click\` — those are for
  table/list/kanban.
- No \`actions\` — charts are read-only.
- \`refresh_seconds\`: 60 default, 30 for live counters, 300+ for heavy
  aggregations over large windows.`
