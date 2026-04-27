/**
 * KPI-specific assembly chapter. A single big number with optional delta
 * (% change vs prior period) and target (progress bar). The SQL pattern
 * is "one aggregated row out", and the binder must tell the mapper to
 * read the value from that row instead of counting rows.
 */
export const KPI_CHAPTER = `KPI PANELS (type=kpi): a single headline number plus optional delta and
target. Pattern: SQL aggregates to ONE row with the value (and any
prior/target columns), and \`map.aggregate: "first"\` tells the mapper to
read it as-is.

    {
      "source": { "kind": "team_data", "config": {
        "sql": "SELECT COUNT(*) AS value, (SELECT COUNT(*) FROM ... WHERE created_at < date('now', '-7 day') AND team_id = :team_id) AS prior, 100 AS target FROM <table> WHERE team_id = :team_id"
      } },
      "map": { "rows": "$.rows[*]", "aggregate": "first", "aggregate_field": "value", "delta_field": "prior", "target_field": "target" },
      "refresh_seconds": 60
    }

Rules for kpi panels:
- SQL MUST aggregate to a single row (COUNT/SUM/AVG/MAX/etc.) and expose
  the headline as a named column (alias to e.g. \`value\`). Set
  \`map.aggregate: "first"\` and \`map.aggregate_field: "<column>"\` —
  without "first" the mapper counts ROWS instead of reading the aggregate
  and you get \`1\` for every kpi.
- \`delta_field\` is OPTIONAL: when set, the same first row must include
  that column holding the prior-period value (typically a sub-SELECT in
  the SQL). The renderer derives % change automatically.
- \`target_field\` is OPTIONAL: when set, the same first row must include
  the goal as a numeric column. The renderer draws a progress bar.
- OMIT \`group_by\`, \`title\`, \`columns\`, \`on_click\`, \`actions\` — kpi
  panels are read-only single-cell.

UNITS — \`props\` shapes how the number is displayed. Pick from the data
semantics, not from a default:
- \`format: "currency"\` + \`currency: "<symbol>"\` → ONLY when the value is
  literal money (price, revenue, cost, salary, …). Default symbol is "$";
  pick another only when the data clearly belongs to a specific currency:
  ₩ for KRW, € for EUR, ¥ for JPY, ₿ for BTC, etc.
  HARD RULE: NEVER pick currency for counts of people, items, events,
  sightings, tasks, friends, signups, sessions, etc. — those are not
  money. The server strips bogus currency formatting when the SQL has no
  money-shaped column, so picking it wrongly just makes the panel look
  broken to the user before that strip kicks in.
- \`format: "percent"\` → when the value is a 0..1 ratio that should render
  as e.g. "72.0%". The SQL must already produce the ratio (not 0..100).
- \`format: "duration"\` → when the value is in seconds; renderer auto-picks
  s/m/h/d.
- \`suffix: "<unit>"\` → for plain countable units the renderer doesn't
  know about, append a short label after the number. Examples:
    counts of people  → suffix "명"   (or "people")
    counts of records → suffix "건"
    physical sizes    → suffix "m" / "kg" / "L"
    raw counts with no natural unit → omit suffix entirely
  Use \`suffix\` INSTEAD OF a fake currency symbol. When in doubt about
  the unit, omit both \`format\` and \`suffix\` — a bare number is fine.

When \`target_field\` is set, the same suffix/format applies to BOTH the
current value and the target so "12 / 50명" reads consistently.`
