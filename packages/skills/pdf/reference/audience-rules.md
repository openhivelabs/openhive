# Block usage by audience

Different audiences accept different blocks. Misjudging this is the single
most common quality failure.

## Executive / board / investor / finance reports

- **NEVER use `code` block.** Source code in a board deck looks like a bug or
  unprofessional debug output. The spec validator hard-rejects it for these
  audiences. If you need to show a calculation or formula, use a
  `callout` (variant `note`) with prose like
  "예측 모델: Q2 매출 = 기준 ARR × NRR 인자 × 파이프라인 커버리지" — NOT
  raw Python.
- Avoid `~~strikethrough~~` for rhetorical "반대" framing. Use it ONLY for
  redline / removed-item context. For "instead of X, do Y" prose, just write
  "X 보다는 Y 입니다" — strikethrough on a finished doc reads as a leftover
  edit. The validator surfaces a warning when it sees this pattern.
- Inline `` `code` `` spans are fine for product / feature names
  (`renewal_desk`, `usage_meter`) but not for arbitrary identifiers.

## Technical doc / engineering RFC / API guide

- `code` blocks are core. Use them freely.
- Inline code spans for every variable / function / file path.

## Briefing memo / research note / project update

- `code` only when the topic genuinely needs source. Default no.
- `callout` and `kpi_row` carry the weight.

## Detection

Set `meta.audience` to one of:
`executive`, `board`, `investor`, `finance`, `technical`, `briefing`, `internal`,
`임원`, `이사회`, `투자자`.

Even when `audience` is unset, the validator auto-detects executive context
when the title contains keywords like 임원 / 이사회 / 투자자 / executive /
board / investor / finance.

## When the user prompt forces a forbidden block

If the prompt demands a block that the audience would reject (e.g.
"PDF 스킬 모든 기능 검증" demands `code` while the document type is a board
report), prioritize the document type. Coverage tests are run on synthetic
content — production reports never sacrifice tone for feature coverage.
