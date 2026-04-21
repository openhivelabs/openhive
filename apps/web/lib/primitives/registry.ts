import {
  Accordion,
  accordionCatalog,
  Card,
  cardCatalog,
  Columns,
  columnsCatalog,
  Grid,
  gridCatalog,
  Rows,
  rowsCatalog,
  Tabs,
  tabsCatalog,
} from '@/components/primitives/layout'
import {
  Chart,
  chartCatalog,
  Kanban,
  kanbanCatalog,
  Kpi,
  kpiCatalog,
  List,
  listCatalog,
  StatRow,
  statRowCatalog,
  Table,
  tableCatalog,
} from '@/components/primitives/data'
import {
  Button,
  buttonCatalog,
  FilterBar,
  filterBarCatalog,
  Form,
  formCatalog,
  Search,
  searchCatalog,
} from '@/components/primitives/input'
import {
  Badge,
  badgeCatalog,
  Callout,
  calloutCatalog,
  Code,
  codeCatalog,
  EmptyState,
  emptyStateCatalog,
  FileViewer,
  fileViewerCatalog,
  IFrame,
  iframeCatalog,
  Image,
  imageCatalog,
  Markdown,
  markdownCatalog,
  Progress,
  progressCatalog,
} from '@/components/primitives/content'
import type { PrimitiveDef } from './types'

export const REGISTRY: Record<string, PrimitiveDef> = {
  // layout
  rows:        { name: 'rows',        Component: Rows,       catalog: rowsCatalog       },
  columns:     { name: 'columns',     Component: Columns,    catalog: columnsCatalog    },
  grid:        { name: 'grid',        Component: Grid,       catalog: gridCatalog       },
  card:        { name: 'card',        Component: Card,       catalog: cardCatalog       },
  tabs:        { name: 'tabs',        Component: Tabs,       catalog: tabsCatalog       },
  accordion:   { name: 'accordion',   Component: Accordion,  catalog: accordionCatalog  },
  // data
  kpi:         { name: 'kpi',         Component: Kpi,        catalog: kpiCatalog        },
  'stat-row':  { name: 'stat-row',    Component: StatRow,    catalog: statRowCatalog    },
  table:       { name: 'table',       Component: Table,      catalog: tableCatalog      },
  list:        { name: 'list',        Component: List,       catalog: listCatalog       },
  kanban:      { name: 'kanban',      Component: Kanban,     catalog: kanbanCatalog     },
  chart:       { name: 'chart',       Component: Chart,      catalog: chartCatalog      },
  // input
  form:        { name: 'form',        Component: Form,       catalog: formCatalog       },
  'filter-bar':{ name: 'filter-bar',  Component: FilterBar,  catalog: filterBarCatalog  },
  search:      { name: 'search',      Component: Search,     catalog: searchCatalog     },
  button:      { name: 'button',      Component: Button,     catalog: buttonCatalog     },
  // content
  markdown:    { name: 'markdown',    Component: Markdown,   catalog: markdownCatalog   },
  code:        { name: 'code',        Component: Code,       catalog: codeCatalog       },
  image:       { name: 'image',       Component: Image,      catalog: imageCatalog      },
  'file-viewer': { name: 'file-viewer', Component: FileViewer, catalog: fileViewerCatalog },
  callout:     { name: 'callout',     Component: Callout,    catalog: calloutCatalog    },
  badge:       { name: 'badge',       Component: Badge,      catalog: badgeCatalog      },
  progress:    { name: 'progress',    Component: Progress,   catalog: progressCatalog   },
  'empty-state': { name: 'empty-state', Component: EmptyState, catalog: emptyStateCatalog },
  iframe:      { name: 'iframe',      Component: IFrame,     catalog: iframeCatalog     },
}

/** Flat array of catalog entries — what AI sees when composing. */
export function primitiveCatalog() {
  return Object.values(REGISTRY).map((p) => p.catalog)
}
