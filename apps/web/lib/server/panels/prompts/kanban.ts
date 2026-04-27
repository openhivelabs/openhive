/**
 * Kanban-specific assembly chapter. The binding must be self-describing —
 * the renderer reads stage taxonomy directly off the create/update form
 * fields so the empty preview, "+ Add" form, and drag-to-move all share
 * one source of truth. (See `aiBindPanel` for the CHECK-constraint
 * backstop that mirrors taxonomy from setup_sql when AI omits options.)
 */
export const KANBAN_CHAPTER = `KANBAN PANELS (type=kanban): grouped cards by a stage/status column. The
binding MUST be self-describing — the panel renderer reads the stage
taxonomy directly off the binding so the empty preview, the "+ Add" form,
and the drag-to-move action all share one source of truth. Output:

    {
      "source": { "kind": "team_data", "config": { "sql": "SELECT id, title, status, ... FROM <table> WHERE team_id = :team_id" } },
      "map": { "rows": "$.rows[*]", "group_by": "status", "title": "title", "on_click": { "kind": "detail" } },
      "refresh_seconds": 60,
      "actions": [
        { "id": "create", "kind": "create", "label": "Add", "placement": "toolbar",
          "target": { "kind": "team_data", "config": { "sql": "INSERT INTO <table> (title, status, team_id) VALUES (:title, :status, :team_id)" } },
          "form": { "fields": [
            { "name": "title", "label": "Title", "type": "text", "required": true },
            { "name": "status", "label": "Stage", "type": "select",
              "options": ["<stage1>", "<stage2>", ...], "default": "<stage1>", "required": true }
          ] } },
        { "id": "move", "kind": "update", "label": "Move", "placement": "drag",
          "fields": ["status"],
          "target": { "kind": "team_data", "config": { "sql": "UPDATE <table> SET status = :status WHERE id = :id AND team_id = :team_id" } },
          "form": { "fields": [
            { "name": "status", "label": "Stage", "type": "select", "options": ["<stage1>", "<stage2>", ...] }
          ] } }
      ]
    }

Rules for kanban panels:
- The form field whose \`name\` matches \`map.group_by\` MUST be \`type: select\`
  with \`options\` listing EVERY stage the user named, in the order they
  named them. The renderer uses these options to draw empty stage columns
  in preview (before any rows exist) and to populate the dropdown in the
  Add form, so missing/empty options breaks both flows.
- Always emit BOTH a \`create\` action (placement: "toolbar") and a \`move\`
  update action (placement: "drag", fields: ["<group_by>"]) so users can
  add cards and drag between columns.
- The \`map.group_by\` column MUST appear by name in the SELECT list, the
  create INSERT column list, AND the move UPDATE SET clause — all four
  references (map + 3 SQL spots) name the same column. The SELECT must
  also include \`id\` so the move action can target a row.
- When you also emit \`setup_sql\` (new-table case), the CREATE TABLE MUST
  include a matching \`CHECK (<group_by> IN ('stage1','stage2',...))\`
  constraint with the SAME values, so the DB enforces what the form
  promises. The DEFAULT for the group_by column should be the first stage.
- ALWAYS include a \`sort_order REAL DEFAULT 0\` column when emitting
  \`setup_sql\` for a kanban table — the renderer uses it to persist
  within-column drag reorders (cards rearranged by hand stay put on
  refresh). The SELECT MUST list \`sort_order\` and ORDER BY status,
  sort_order so cards render in the user's chosen sequence.`
