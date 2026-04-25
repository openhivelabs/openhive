# frame-market seed

Initial catalog for the OpenHive Frame Market (panels only, for now).

Mirrors the built-in demo entries shown in the Market modal when the remote
repo is empty or unreachable. Once this content is published to the public
`frame-market` repo, the demo fallback stops firing and users install the
real YAMLs.

## How to publish

```sh
# From this repo root
cp -r frame-market-seed/. /path/to/frame-market-repo/
cd /path/to/frame-market-repo
git add .
git commit -m "seed: initial panel catalog (kpi + chart)"
git push
```

The server resolves catalog entries from the URL set in
`OPENHIVE_MARKET_BASE_URL` (default
`https://raw.githubusercontent.com/openhivelabs/frame-market/main`). Each
panel entry is fetched at:

```
<base>/panels/<category>/<id>.openhive-panel-frame.yaml
```

## Contents

Two categories × three panels = six seed entries. All are domain-agnostic
SQL over a `customer` table — users edit the SQL post-install to adapt.

### kpi/
- `total-count` — row count as a single big number
- `sum-metric` — sum of a numeric column
- `period-change` — week-over-week % change in row count

### chart/
- `trend-line` — daily count over the last 30 days (line chart)
- `bar-by-category` — row count grouped by a category column (bar chart)
- `stacked-composition` — numeric total broken down by group (mix view)

## Adding a new panel

1. Drop `panels/<category>/<id>.openhive-panel-frame.yaml`.
2. Append the entry to `index.json` under `"panels"` with matching
   `id`, `category`, `name`, `description`, `version`, `tags`, `author`.
3. Commit. The server fetches `index.json` on every Market open — no
   deploy needed on the app side.
