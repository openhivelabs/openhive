/**
 * Table-specific assembly chapter. Tables default to a SELECT-only binding,
 * but when the frame's `current_binding.actions` already declares mutations
 * (create / delete) — or the user asks to "add rows" / "추가" — the binder
 * MUST preserve those actions, rewriting their SQL to match the SELECT's
 * target table and column set so the rendered "+ Add" button keeps working
 * after rebind. Without this the binder strips actions on every rebind and
 * the toolbar Add button silently disappears.
 */
export const TABLE_CHAPTER = `TABLE PANELS (type=table): a sortable grid of rows. Output:

    {
      "source": { "kind": "team_data", "config": { "sql": "SELECT id, ...cols... FROM <table> WHERE team_id = :team_id ORDER BY ... LIMIT 100" } },
      "map": { "rows": "$.rows[*]", "columns": ["id", ...], "on_click": { "kind": "detail" } },
      "refresh_seconds": 60,
      "actions": [ ...see ACTIONS below... ]
    }

Rules for table panels:
- The SELECT must include \`id\` so row-level actions (delete) can target a
  row; list the user-relevant columns explicitly in \`map.columns\` in
  display order. Hide system columns the user doesn't care about (e.g.
  \`team_id\`) by leaving them out of \`map.columns\`.
- ORDER BY whatever the user asked for ("점수 높은 순으로" → ORDER BY score
  DESC). Default LIMIT 100 unless the user asks otherwise.

ACTIONS for table panels:
- For team_data sources AND mcp \`execute_sql\` sources, emit the FULL CRUD
  trio by default — \`create\` (Add button in header), \`update\` (Edit button
  in row detail modal), \`delete\` (Delete button in row detail modal). The
  detail modal autoshows Edit/Delete iff matching actions are present, so
  omitting either kind silently strips the user's ability to manage rows.
  Only skip a kind when the user explicitly says "read only" / "조회만" /
  "수정 안 됨".
- The \`create\` action's INSERT column list MUST match the actual writable
  columns of the target table (skip auto-generated \`id\`, default-stamped
  \`created_at\`/\`updated_at\`, and \`team_id\` which the server binds
  automatically — but you MUST still list \`team_id\` as a column and pass
  \`:team_id\` as its value, per the universal team_data INSERT rule).
- Each form field's \`type\` should match the column's SQLite type:
  INTEGER/REAL → \`number\`, TEXT with a known small enum → \`select\` with
  \`options\`, plain TEXT → \`text\`, long TEXT → \`textarea\`,
  date/datetime-shaped TEXT → \`date\` or \`datetime-local\`. Mark NOT NULL
  columns as \`required: true\`.
- For mcp sources whose tool is \`execute_sql\` (Supabase, Postgres-style
  servers), ALSO emit create / delete actions via the SAME tool so the
  panel header gets an "+ Add" button against external data. Use
  \`args_template\` with \`{{var}}\` placeholders for the form field values
  — the runtime substitutes them at execute time. Pass the same
  \`project_id\` (or analogous required arg) the SELECT used.
- For other external sources (mcp tools that aren't execute_sql, http,
  file), OMIT actions — there's no safe write path.

Example (team_data table with full CRUD):

    "actions": [
      { "id": "create", "kind": "create", "label": "Add",
        "target": { "kind": "team_data", "config": { "sql": "INSERT INTO <table> (col_a, col_b, team_id) VALUES (:col_a, :col_b, :team_id)" } },
        "form": { "fields": [
          { "name": "col_a", "label": "Col A", "type": "text", "required": true },
          { "name": "col_b", "label": "Col B", "type": "number", "default": 0 }
        ] } },
      { "id": "update", "kind": "update", "label": "Save",
        "target": { "kind": "team_data", "config": { "sql": "UPDATE <table> SET col_a = :col_a, col_b = :col_b WHERE id = :id AND team_id = :team_id" } },
        "form": { "fields": [
          { "name": "col_a", "label": "Col A", "type": "text", "required": true },
          { "name": "col_b", "label": "Col B", "type": "number" }
        ] } },
      { "id": "delete", "kind": "delete", "label": "Delete",
        "target": { "kind": "team_data", "config": { "sql": "DELETE FROM <table> WHERE id = :id AND team_id = :team_id" } } }
    ]

Example (mcp execute_sql / Supabase with full CRUD):

    "actions": [
      { "id": "create", "kind": "create", "label": "Add",
        "target": { "kind": "mcp", "config": {
          "server": "<server>", "tool": "execute_sql",
          "args_template": {
            "project_id": "<project_id>",
            "query": "INSERT INTO <table> (col_a, col_b) VALUES ('{{col_a}}', {{col_b}})"
          }
        } },
        "form": { "fields": [
          { "name": "col_a", "label": "Col A", "type": "text", "required": true },
          { "name": "col_b", "label": "Col B", "type": "number", "default": 0 }
        ] } },
      { "id": "update", "kind": "update", "label": "Save",
        "target": { "kind": "mcp", "config": {
          "server": "<server>", "tool": "execute_sql",
          "args_template": {
            "project_id": "<project_id>",
            "query": "UPDATE <table> SET col_a = '{{col_a}}', col_b = {{col_b}} WHERE id = {{id}}"
          }
        } },
        "form": { "fields": [
          { "name": "col_a", "label": "Col A", "type": "text", "required": true },
          { "name": "col_b", "label": "Col B", "type": "number" }
        ] } },
      { "id": "delete", "kind": "delete", "label": "Delete",
        "target": { "kind": "mcp", "config": {
          "server": "<server>", "tool": "execute_sql",
          "args_template": {
            "project_id": "<project_id>",
            "query": "DELETE FROM <table> WHERE id = {{id}}"
          }
        } } }
    ]

Rules for mcp execute_sql actions:
- Wrap TEXT/DATE field substitutions in single quotes ('{{name}}'); leave
  number/boolean unquoted ({{count}}). NOT NULL fields should be marked
  \`required: true\` in the form so the renderer enforces non-empty input.
- Skip system columns the user can't supply (auto-generated id,
  default-stamped created_at). Don't include team_id — external tables
  don't share OpenHive's tenant column.`
