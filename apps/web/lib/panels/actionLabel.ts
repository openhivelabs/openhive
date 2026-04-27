import type { PanelAction } from '@/lib/api/dashboards'

/** Synthesized kanban action IDs (see lib/server/panels/synthesize.ts) carry
 *  generic English labels from the server. Map them to localized strings on
 *  the client; user-defined action labels pass through unchanged so AI-emitted
 *  bindings keep whatever wording the prompt produced. */
export function actionLabel(
  a: Pick<PanelAction, 'id' | 'label'>,
  t: (k: string) => string,
): string {
  switch (a.id) {
    case 'kanban.move':
      return t('kanban.action.move')
    case 'kanban.create':
      return t('kanban.action.create')
    case 'kanban.update':
      return t('kanban.action.update')
    case 'kanban.delete':
      return t('kanban.action.delete')
    default:
      return a.label
  }
}
