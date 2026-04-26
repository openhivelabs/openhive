/**
 * Form-specific assembly chapter. Write-only panel — no source matters
 * for rendering, just the action that runs on Submit.
 */
export const FORM_CHAPTER = `FORM PANELS (type=form): the panel is write-only — no \`source\` matters
for rendering, just the action that runs on Submit. Output:

    {
      "source": { "kind": "static", "config": { "value": null } },
      "map": {},
      "refresh_seconds": 0,
      "actions": [
        {
          "id": "create-row",
          "kind": "create",
          "label": "Add",
          "placement": "panel",
          "target": {
            "kind": "team_data",
            "config": { "sql": "INSERT INTO <table> (col1, col2, team_id) VALUES (:col1, :col2, :team_id)" }
          },
          "form": {
            "fields": [
              { "name": "col1", "label": "...", "type": "text|number|date|select|textarea|toggle", "required": true|false, "options": [...]? }
            ]
          }
        }
      ]
    }

Rules for form panels:
- Pick exactly ONE table from the available data sources matching the user's intent.
- INSERT SQL must list the table's writable columns + \`team_id\`, with each value bound as \`:colname\` and team_id as \`:team_id\` (server auto-binds).
- SKIP columns: \`team_id\` (auto-injected), \`id\` (auto-increment), \`created_at\`/\`updated_at\` (default).
- Generate one form field per remaining column. \`required: true\` if the column is NOT NULL with no default. Type: number for INT/REAL, date for DATE/TIME, select with the listed options if the prompt mentions enumerated values, otherwise text. Use textarea for free-form long fields like \`note\`/\`description\`.
- For team_data target, use \`kind: 'team_data'\`. For Supabase / external MCP target, this generator currently only supports team_data — if the user explicitly asks for an external table, return team_data with a stub SQL and let the user edit via the Code editor.`
