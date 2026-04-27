/**
 * Calendar-specific assembly chapter. Two-pane month grid + day detail.
 * Reads dated rows AND edits them in place via three actions
 * (create/update/delete) on the same table.
 */
export const CALENDAR_CHAPTER = `CALENDAR PANELS (type=calendar): interactive month grid + detail pane that
reads dated rows AND edits them. Left side is a month grid (clickable day
cells with event chips), right side expands the selected day's events
in-place (full row data + Edit / Delete inline) plus an "+ Add" form.
Output binding has BOTH a SELECT source/map AND three actions
(create / update / delete) on the same table:

    {
      "source": { "kind": "team_data", "config": { "sql": "SELECT id, title, status, due_date, end_at FROM <table> WHERE team_id = :team_id AND due_date IS NOT NULL" } },
      "map": { "rows": "$.rows[*]", "ts": "due_date", "ts_end": "end_at", "title": "title", "kind": "status" },
      "refresh_seconds": 60,
      "actions": [
        { "id": "create", "kind": "create", "label": "Add", "target": { "kind": "team_data", "config": { "sql": "INSERT INTO <table> (title, status, due_date, team_id) VALUES (:title, :status, :due_date, :team_id)" } }, "form": { "fields": [{"name":"title","label":"Title","type":"text","required":true},{"name":"status","label":"Status","type":"select","options":["todo","doing","done"],"default":"todo"},{"name":"due_date","label":"Date","type":"date","required":true}] } },
        { "id": "update", "kind": "update", "label": "Save", "target": { "kind": "team_data", "config": { "sql": "UPDATE <table> SET title = :title, status = :status, due_date = :due_date WHERE id = :id AND team_id = :team_id" } }, "form": { "fields": [{"name":"title","label":"Title","type":"text","required":true},{"name":"status","label":"Status","type":"select","options":["todo","doing","done"]},{"name":"due_date","label":"Date","type":"date","required":true}] } },
        { "id": "delete", "kind": "delete", "label": "Delete", "target": { "kind": "team_data", "config": { "sql": "DELETE FROM <table> WHERE id = :id AND team_id = :team_id" } } }
      ]
    }

Rules for calendar panels:
- Pick exactly ONE table with a date/datetime column.
- SELECT must include \`id\` so update/delete can target the row.
- All three actions must reference the same table.
- update/delete SQL MUST filter on \`id = :id AND team_id = :team_id\`.
- For mcp \`execute_sql\` sources (Supabase / Postgres-style servers): the
  same shape applies — INSERT must list \`team_id\` and pass \`:team_id\`,
  UPDATE/DELETE WHERE must include \`team_id = :team_id\`. The runtime
  auto-binds \`:team_id\` to the OpenHive team id for both team_data and
  mcp action targets, so external tables with a tenant column write
  correctly without extra form fields.
- Form fields for create+update should match (same set).
- \`map.kind\` is OPTIONAL — set it to a category/status column when one exists
  (status, type, priority, label, etc). The renderer auto-colors event chips
  by this value, so events of the same kind share a color. Omit it when no
  meaningful category column exists.
- The form field bound to the date column should use \`type: datetime-local\`
  (NOT plain \`date\`). The right-side day pane is a vertical timetable —
  events with a time-of-day component land at their hour row; events without
  a time stack at the top as "all-day". Using \`datetime-local\` lets users
  pick the hour. The mapper handles bare dates and full ISO timestamps
  identically, so existing data without times still works.
- \`map.ts_end\` is OPTIONAL — set it to a second timestamp column for the
  event's end time. When present the calendar renders cards spanning From →
  To and drag-rescheduling preserves duration; when absent each event
  defaults to a 1-hour block. Pair it with a matching \`end_at\` (or similar)
  form field of type \`datetime-local\` in the create + update actions and
  include the column in the INSERT / UPDATE SQL so the From/To pair stays
  in sync.`
