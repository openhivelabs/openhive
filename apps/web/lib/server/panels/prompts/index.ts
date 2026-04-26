/**
 * System-prompt router for the AI panel binder. The binder calls
 * `buildSystemPrompt(panel.type)` to compose `common.ts` (universal
 * rules) + the matching panel-type chapter. Panel types without a
 * dedicated chapter get common only — they live entirely off the
 * universal rules and need no special assembly guidance.
 */
import { CALENDAR_CHAPTER } from './calendar'
import { CHART_CHAPTER } from './chart'
import { COMMON_PROMPT } from './common'
import { FORM_CHAPTER } from './form'
import { KANBAN_CHAPTER } from './kanban'
import { KPI_CHAPTER } from './kpi'

const CHAPTERS: Record<string, string> = {
  chart: CHART_CHAPTER,
  kanban: KANBAN_CHAPTER,
  calendar: CALENDAR_CHAPTER,
  form: FORM_CHAPTER,
  kpi: KPI_CHAPTER,
}

export function buildSystemPrompt(panelType: string): string {
  const chapter = CHAPTERS[panelType]
  return chapter ? `${COMMON_PROMPT}\n\n${chapter}` : COMMON_PROMPT
}
