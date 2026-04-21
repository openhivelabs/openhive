import type { ArtifactDetailed } from './api/artifacts'
import type { FileEntry, FileList } from './api/files'
import type { QueryResult, SchemaResponse } from './api/teamData'

export const MOCK_SCHEMA: SchemaResponse = {
  recent_migrations: [],
  tables: [
    {
      name: 'reports',
      row_count: 128,
      columns: [
        { name: 'id', type: 'INTEGER', notnull: true, pk: true },
        { name: 'title', type: 'TEXT', notnull: true, pk: false },
        { name: 'status', type: 'TEXT', notnull: true, pk: false },
        { name: 'owner', type: 'TEXT', notnull: false, pk: false },
        { name: 'priority', type: 'TEXT', notnull: false, pk: false },
        { name: 'tags', type: 'JSON', notnull: false, pk: false },
        { name: 'progress', type: 'INTEGER', notnull: false, pk: false },
        { name: 'due_date', type: 'DATE', notnull: false, pk: false },
        { name: 'updated_at', type: 'DATETIME', notnull: false, pk: false },
      ],
    },
    {
      name: 'agents',
      row_count: 6,
      columns: [
        { name: 'id', type: 'INTEGER', notnull: true, pk: true },
        { name: 'name', type: 'TEXT', notnull: true, pk: false },
        { name: 'role', type: 'TEXT', notnull: true, pk: false },
        { name: 'provider', type: 'TEXT', notnull: false, pk: false },
        { name: 'model', type: 'TEXT', notnull: false, pk: false },
        { name: 'runs_week', type: 'INTEGER', notnull: false, pk: false },
        { name: 'success_rate', type: 'REAL', notnull: false, pk: false },
        { name: 'last_used', type: 'DATETIME', notnull: false, pk: false },
      ],
    },
    {
      name: 'sources',
      row_count: 9,
      columns: [
        { name: 'id', type: 'INTEGER', notnull: true, pk: true },
        { name: 'name', type: 'TEXT', notnull: true, pk: false },
        { name: 'type', type: 'TEXT', notnull: true, pk: false },
        { name: 'url', type: 'TEXT', notnull: false, pk: false },
        { name: 'refresh', type: 'TEXT', notnull: false, pk: false },
        { name: 'status', type: 'TEXT', notnull: false, pk: false },
        { name: 'last_refresh', type: 'DATETIME', notnull: false, pk: false },
      ],
    },
    {
      name: 'team_members',
      row_count: 5,
      columns: [
        { name: 'id', type: 'INTEGER', notnull: true, pk: true },
        { name: 'name', type: 'TEXT', notnull: true, pk: false },
        { name: 'role', type: 'TEXT', notnull: true, pk: false },
        { name: 'email', type: 'TEXT', notnull: false, pk: false },
        { name: 'active', type: 'BOOLEAN', notnull: false, pk: false },
        { name: 'joined_at', type: 'DATE', notnull: false, pk: false },
      ],
    },
    {
      name: 'notes',
      row_count: 0,
      columns: [
        { name: 'id', type: 'INTEGER', notnull: true, pk: true },
        { name: 'body', type: 'TEXT', notnull: false, pk: false },
        { name: 'created_at', type: 'DATETIME', notnull: false, pk: false },
      ],
    },
  ],
}

const now = Date.now()
const h = (hours: number) => now - hours * 3600_000
const d = (days: number) => now - days * 86400_000
const dAhead = (days: number) => now + days * 86400_000
const iso = (ms: number) => new Date(ms).toISOString()

const REPORT_TOPICS = [
  'EUV 장비 공급 동향',
  '중국 파운드리 투자 규모',
  'HBM 4세대 벤더 비교',
  'Lithography 로드맵 분석',
  'AI 가속기 TCO 비교',
  '2nm GAA 수율 전망',
  'GDDR7 채택 현황',
  'DPU 시장 재편',
  'CoWoS 패키징 캐파',
  '차세대 Power IC 리뷰',
  'MRAM 상용화 시나리오',
  'RISC-V 서버칩 경쟁사',
  'Advanced Node CapEx',
  '파운드리 PPA 비교',
  '삼성 GAA 3nm 분석',
  'Intel 18A 로드맵 업데이트',
  'Micron HBM3E 리뷰',
  'UALink 대 NVLink',
  'Optical I/O 전환 속도',
  'TSV 수율 트렌드',
  '중국 메모리 제재 영향',
  'Mobile AP 성능 벤치마크',
  '자동차 반도체 수급',
  '전력반도체 공급망 분석',
  'FAB 인력 수급 리포트',
  '반도체 장비주 실적 요약',
  'Edge TPU 채택 사례',
  '레거시 노드 가동률',
  'Glass Substrate 전환',
  'Photomask 시장 재편',
]
const REPORT_OWNERS = ['이동윤', '박지훈', '김서연', '정유나', '최민호']
const REPORT_STATUSES = ['draft', 'in_progress', 'review', 'published', 'archived']
const REPORT_PRIORITIES = ['high', 'medium', 'low']
const REPORT_TAG_POOL = [
  'market', 'semi', 'memory', 'foundry', 'research', 'ai', 'nvidia', 'samsung',
  'tsmc', 'sk', 'micron', 'intel', 'asml', 'weekly', 'monthly', 'supply',
  'capex', 'packaging', 'equipment', 'price', 'chip', 'cxl', 'risc-v',
]

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T
}

function generateMoreReports(startId: number, endId: number) {
  const out: Record<string, unknown>[] = []
  for (let id = startId; id <= endId; id++) {
    const seed = id * 2654435761
    const status = pick(REPORT_STATUSES, seed >>> 3)
    const priority = pick(REPORT_PRIORITIES, seed >>> 5)
    const owner = pick(REPORT_OWNERS, seed >>> 7)
    const title = pick(REPORT_TOPICS, seed >>> 2) + ` #${id}`
    const tagCount = ((seed >>> 11) % 3) + 1
    const tags: string[] = []
    for (let k = 0; k < tagCount; k++) {
      const t = pick(REPORT_TAG_POOL, (seed >>> (13 + k * 3)) + k)
      if (!tags.includes(t)) tags.push(t)
    }
    const progress =
      status === 'published' || status === 'archived'
        ? 100
        : status === 'draft'
          ? (seed >>> 17) % 25
          : status === 'in_progress'
            ? 30 + ((seed >>> 19) % 45)
            : 70 + ((seed >>> 21) % 25)
    const dueOffset = ((seed >>> 23) % 40) - 15
    const updatedOffset = ((seed >>> 25) % 200) + 1
    out.push({
      id,
      title,
      status,
      owner,
      priority,
      tags,
      progress,
      due_date: iso(dueOffset >= 0 ? dAhead(dueOffset) : d(-dueOffset)),
      updated_at: iso(h(updatedOffset)),
    })
  }
  return out
}

export const MOCK_ROWS: Record<string, QueryResult> = {
  reports: {
    columns: [
      'id',
      'title',
      'status',
      'owner',
      'priority',
      'tags',
      'progress',
      'due_date',
      'updated_at',
    ],
    rows: [
      { id: 1, title: '2026 Q1 반도체 시장 리뷰', status: 'published', owner: '이동윤', priority: 'high', tags: ['market', 'semi'], progress: 100, due_date: iso(d(8)), updated_at: iso(h(2)) },
      { id: 2, title: 'TSMC 3nm 수율 분석', status: 'review', owner: '박지훈', priority: 'high', tags: ['research', 'foundry'], progress: 82, due_date: iso(dAhead(2)), updated_at: iso(h(5)) },
      { id: 3, title: 'HBM4 공급망 리스크', status: 'in_progress', owner: '김서연', priority: 'medium', tags: ['supply', 'memory'], progress: 45, due_date: iso(dAhead(6)), updated_at: iso(h(9)) },
      { id: 4, title: '주간 업계 뉴스 요약', status: 'published', owner: '이동윤', priority: 'low', tags: ['weekly'], progress: 100, due_date: iso(d(1)), updated_at: iso(d(1)) },
      { id: 5, title: 'SK하이닉스 로드맵 업데이트', status: 'draft', owner: '박지훈', priority: 'medium', tags: ['research'], progress: 18, due_date: iso(dAhead(14)), updated_at: iso(d(2)) },
      { id: 6, title: 'ASML EUV 가동률 벤치마크', status: 'in_progress', owner: '정유나', priority: 'medium', tags: ['equipment'], progress: 62, due_date: iso(dAhead(4)), updated_at: iso(h(22)) },
      { id: 7, title: 'Edge AI 칩 비교표', status: 'review', owner: '김서연', priority: 'low', tags: ['ai', 'chip'], progress: 90, due_date: iso(dAhead(1)), updated_at: iso(h(30)) },
      { id: 8, title: '삼성전자 파운드리 전망', status: 'draft', owner: '이동윤', priority: 'high', tags: ['foundry', 'samsung'], progress: 10, due_date: iso(dAhead(21)), updated_at: iso(d(3)) },
      { id: 9, title: 'CXL 2.0 어댑터 비교', status: 'archived', owner: '정유나', priority: 'low', tags: ['cxl'], progress: 100, due_date: iso(d(30)), updated_at: iso(d(28)) },
      { id: 10, title: 'NVIDIA Blackwell 브리핑', status: 'published', owner: '박지훈', priority: 'high', tags: ['ai', 'nvidia'], progress: 100, due_date: iso(d(12)), updated_at: iso(d(10)) },
      { id: 11, title: 'DDR5 가격 트래커', status: 'in_progress', owner: '김서연', priority: 'medium', tags: ['memory', 'price'], progress: 55, due_date: iso(dAhead(8)), updated_at: iso(h(14)) },
      { id: 12, title: '패키징 기술 리뷰(2.5D/3D)', status: 'review', owner: '정유나', priority: 'medium', tags: ['packaging'], progress: 78, due_date: iso(dAhead(3)), updated_at: iso(h(40)) },
      ...generateMoreReports(13, 128),
    ],
  },
  agents: {
    columns: ['id', 'name', 'role', 'provider', 'model', 'runs_week', 'success_rate', 'last_used'],
    rows: [
      { id: 1, name: 'Lead', role: 'orchestrator', provider: 'anthropic', model: 'claude-opus-4-7', runs_week: 42, success_rate: 0.98, last_used: iso(h(1)) },
      { id: 2, name: 'Researcher', role: 'research', provider: 'anthropic', model: 'claude-sonnet-4-6', runs_week: 134, success_rate: 0.94, last_used: iso(h(2)) },
      { id: 3, name: 'Writer', role: 'writing', provider: 'openai', model: 'gpt-5.4', runs_week: 87, success_rate: 0.91, last_used: iso(h(4)) },
      { id: 4, name: 'Analyst', role: 'analysis', provider: 'anthropic', model: 'claude-sonnet-4-6', runs_week: 66, success_rate: 0.96, last_used: iso(h(6)) },
      { id: 5, name: 'Reviewer', role: 'review', provider: 'anthropic', model: 'claude-haiku-4-5', runs_week: 190, success_rate: 0.89, last_used: iso(h(1)) },
      { id: 6, name: 'Scraper', role: 'data', provider: 'openai', model: 'gpt-5.4-mini', runs_week: 310, success_rate: 0.82, last_used: iso(h(0.5)) },
    ],
  },
  sources: {
    columns: ['id', 'name', 'type', 'url', 'refresh', 'status', 'last_refresh'],
    rows: [
      { id: 1, name: 'DIGITIMES', type: 'web', url: 'https://www.digitimes.com', refresh: 'hourly', status: 'active', last_refresh: iso(h(1)) },
      { id: 2, name: 'SEC 10-K 필링', type: 'api', url: 'https://www.sec.gov/edgar', refresh: 'daily', status: 'active', last_refresh: iso(h(8)) },
      { id: 3, name: 'TSMC IR', type: 'web', url: 'https://investor.tsmc.com', refresh: 'daily', status: 'stale', last_refresh: iso(d(3)) },
      { id: 4, name: '삼성전자 뉴스룸', type: 'web', url: 'https://news.samsung.com', refresh: '6h', status: 'active', last_refresh: iso(h(3)) },
      { id: 5, name: 'Q1 가격 스프레드시트', type: 'sheet', url: 'gs://prices/q1.xlsx', refresh: 'weekly', status: 'active', last_refresh: iso(d(2)) },
      { id: 6, name: 'ArXiv cs.AR 피드', type: 'api', url: 'https://arxiv.org/list/cs.AR', refresh: 'daily', status: 'active', last_refresh: iso(h(12)) },
      { id: 7, name: '경쟁사 블로그 모음', type: 'web', url: 'https://example.com/feed', refresh: '12h', status: 'error', last_refresh: iso(d(5)) },
      { id: 8, name: 'HBM 로드맵 PDF', type: 'pdf', url: '/ref/hbm-roadmap.pdf', refresh: 'manual', status: 'active', last_refresh: iso(d(14)) },
      { id: 9, name: 'Bloomberg 터미널', type: 'api', url: 'bbg://market/semi', refresh: '15m', status: 'active', last_refresh: iso(h(0.3)) },
    ],
  },
  team_members: {
    columns: ['id', 'name', 'role', 'email', 'active', 'joined_at'],
    rows: [
      { id: 1, name: '이동윤', role: 'Lead', email: 'ldy@openhive.dev', active: 1, joined_at: iso(d(220)) },
      { id: 2, name: '박지훈', role: 'Researcher', email: 'jihoon@openhive.dev', active: 1, joined_at: iso(d(180)) },
      { id: 3, name: '김서연', role: 'Analyst', email: 'seoyeon@openhive.dev', active: 1, joined_at: iso(d(140)) },
      { id: 4, name: '정유나', role: 'Writer', email: 'yuna@openhive.dev', active: 1, joined_at: iso(d(90)) },
      { id: 5, name: '최민호', role: 'Reviewer', email: 'minho@openhive.dev', active: 0, joined_at: iso(d(300)) },
    ],
  },
  notes: {
    columns: ['id', 'body', 'created_at'],
    rows: [],
  },
}

const mkFile = (
  name: string,
  size: number,
  mtimeMs: number,
  parentPath = '',
): FileEntry => ({
  name,
  type: 'file',
  size,
  mtime: mtimeMs,
  path: parentPath ? `${parentPath}/${name}` : name,
})

const mkDir = (name: string, mtimeMs: number, parentPath = ''): FileEntry => ({
  name,
  type: 'dir',
  size: 0,
  mtime: mtimeMs,
  path: parentPath ? `${parentPath}/${name}` : name,
})

const root: Record<string, FileList> = {
  '': {
    path: '',
    entries: [
      mkDir('reports', h(2)),
      mkDir('research', h(9)),
      mkDir('exports', d(1)),
      mkDir('inbox', h(3)),
      mkDir('archive', d(45)),
      mkFile('README.md', 1_820, d(3)),
      mkFile('dashboard.yaml', 4_211, d(10)),
      mkFile('config.json', 612, d(18)),
      mkFile('.gitignore', 140, d(60)),
    ],
  },
  reports: {
    path: 'reports',
    entries: [
      mkDir('2026-Q1', h(2), 'reports'),
      mkDir('2026-Q2', h(26), 'reports'),
      mkFile('weekly-2026W15.docx', 712_311, d(8), 'reports'),
      mkFile('weekly-2026W16.docx', 812_321, h(26), 'reports'),
      mkFile('tsmc-3nm-yield.pdf', 3_145_728, d(2), 'reports'),
      mkFile('samsung-foundry-outlook.pdf', 2_844_912, d(5), 'reports'),
      mkFile('notes.md', 4_012, h(5), 'reports'),
    ],
  },
  'reports/2026-Q1': {
    path: 'reports/2026-Q1',
    entries: [
      mkFile('market-review.pptx', 5_242_880, h(2), 'reports/2026-Q1'),
      mkFile('appendix.xlsx', 412_321, d(2), 'reports/2026-Q1'),
      mkFile('charts.pdf', 1_120_000, d(3), 'reports/2026-Q1'),
      mkFile('summary.md', 8_410, d(4), 'reports/2026-Q1'),
    ],
  },
  'reports/2026-Q2': {
    path: 'reports/2026-Q2',
    entries: [
      mkFile('draft-outline.md', 2_210, h(26), 'reports/2026-Q2'),
      mkFile('source-list.csv', 18_320, h(30), 'reports/2026-Q2'),
    ],
  },
  research: {
    path: 'research',
    entries: [
      mkDir('papers', h(18), 'research'),
      mkDir('benchmarks', d(2), 'research'),
      mkFile('experiments.xlsx', 231_542, d(1), 'research'),
      mkFile('hypothesis-log.md', 9_210, h(9), 'research'),
      mkFile('benchmark-results.csv', 54_130, d(4), 'research'),
      mkFile('references.bib', 12_420, d(12), 'research'),
    ],
  },
  'research/papers': {
    path: 'research/papers',
    entries: [
      mkFile('attention-is-all-you-need.pdf', 2_145_000, d(30), 'research/papers'),
      mkFile('scaling-laws-for-neural-lms.pdf', 1_720_000, d(60), 'research/papers'),
      mkFile('chain-of-thought.pdf', 1_040_000, d(45), 'research/papers'),
      mkFile('flashattention.pdf', 1_380_000, d(35), 'research/papers'),
      mkFile('lora-finetuning.pdf', 920_000, d(50), 'research/papers'),
      mkFile('annotations.md', 14_210, d(7), 'research/papers'),
    ],
  },
  'research/benchmarks': {
    path: 'research/benchmarks',
    entries: [
      mkFile('gpu-bench-20260420.csv', 48_120, d(2), 'research/benchmarks'),
      mkFile('mlperf-2026.xlsx', 321_540, d(6), 'research/benchmarks'),
      mkFile('latency-distribution.json', 121_430, d(3), 'research/benchmarks'),
      mkFile('hardware-matrix.md', 6_220, d(8), 'research/benchmarks'),
    ],
  },
  exports: {
    path: 'exports',
    entries: [
      mkFile('dashboard-20260420.pdf', 4_100_000, d(1), 'exports'),
      mkFile('dashboard-20260413.pdf', 3_920_000, d(8), 'exports'),
      mkFile('data-snapshot-20260421.json', 820_451, d(1), 'exports'),
      mkFile('price-tracker.csv', 31_220, h(12), 'exports'),
      mkFile('quarterly-summary.pptx', 6_820_000, d(4), 'exports'),
      mkFile('agent-usage.csv', 14_310, h(8), 'exports'),
    ],
  },
  inbox: {
    path: 'inbox',
    entries: [
      mkFile('meeting-notes-2026-04-18.md', 3_412, h(3), 'inbox'),
      mkFile('clippings.md', 8_120, h(28), 'inbox'),
      mkFile('todo.md', 1_024, h(2), 'inbox'),
      mkFile('screenshot-2026-04-19.png', 421_320, h(48), 'inbox'),
    ],
  },
  archive: {
    path: 'archive',
    entries: [
      mkDir('2025-Q4', d(45), 'archive'),
      mkDir('2025-Q3', d(130), 'archive'),
      mkDir('2025-Q2', d(220), 'archive'),
    ],
  },
  'archive/2025-Q4': {
    path: 'archive/2025-Q4',
    entries: [
      mkFile('year-end-report.pdf', 8_210_000, d(45), 'archive/2025-Q4'),
      mkFile('kpi-summary.xlsx', 821_340, d(48), 'archive/2025-Q4'),
      mkFile('retrospective.md', 11_210, d(50), 'archive/2025-Q4'),
    ],
  },
  'archive/2025-Q3': {
    path: 'archive/2025-Q3',
    entries: [
      mkFile('quarterly-review.pdf', 5_420_000, d(130), 'archive/2025-Q3'),
      mkFile('board-deck.pptx', 4_120_000, d(132), 'archive/2025-Q3'),
    ],
  },
  'archive/2025-Q2': {
    path: 'archive/2025-Q2',
    entries: [
      mkFile('semi-annual.pdf', 6_220_000, d(220), 'archive/2025-Q2'),
    ],
  },
}

export function getMockFileList(path: string): FileList {
  return root[path] ?? { path, entries: [] }
}

export function hasMockPath(path: string): boolean {
  return path in root
}

export interface MockSessionMeta {
  id: string
  title: string
}

export const MOCK_SESSIONS: MockSessionMeta[] = [
  { id: 'ses_q1market_a1b2', title: '2026 Q1 반도체 시장 리뷰 작성' },
  { id: 'ses_tsmc3nm_c3d4', title: 'TSMC 3nm 수율 분석' },
  { id: 'ses_hbm_e5f6', title: 'HBM4 공급망 리스크 브리프' },
  { id: 'ses_weekly16_g7h8', title: '2026-W16 주간 요약' },
  { id: 'ses_blackwell_i9j0', title: 'NVIDIA Blackwell 브리핑' },
  { id: 'ses_ddr5_k1l2', title: 'DDR5 가격 트래커 업데이트' },
  { id: 'ses_packaging_m3n4', title: '패키징 기술 리뷰 (2.5D/3D)' },
]

let artifactSeq = 0
const artifact = (
  sessionId: string,
  skill: string | null,
  filename: string,
  mime: string | null,
  size: number,
  createdAt: number,
): ArtifactDetailed => ({
  id: `art_mock_${(++artifactSeq).toString().padStart(3, '0')}`,
  sessionId,
  teamId: 'mock-team',
  skillName: skill,
  filename,
  path: `sessions/${sessionId}/artifacts/${filename}`,
  mime,
  size,
  createdAt,
})

export const MOCK_ARTIFACTS: ArtifactDetailed[] = [
  artifact('ses_q1market_a1b2', 'pptx-generator', '2026-Q1-market-review.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 5_242_880, h(2)),
  artifact('ses_q1market_a1b2', 'xlsx-generator', 'Q1-appendix-data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 412_321, h(2.2)),
  artifact('ses_q1market_a1b2', 'chart-renderer', 'market-share-chart.png', 'image/png', 521_840, h(2.5)),

  artifact('ses_tsmc3nm_c3d4', 'pdf-generator', 'tsmc-3nm-yield-analysis.pdf', 'application/pdf', 3_145_728, h(5)),
  artifact('ses_tsmc3nm_c3d4', 'docx-generator', 'tsmc-executive-summary.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 412_321, h(5.3)),
  artifact('ses_tsmc3nm_c3d4', 'data-export', 'wafer-yield-figures.csv', 'text/csv', 24_120, h(5.5)),

  artifact('ses_hbm_e5f6', 'pdf-generator', 'HBM4-supply-risk-brief.pdf', 'application/pdf', 1_820_440, h(9)),
  artifact('ses_hbm_e5f6', 'chart-renderer', 'vendor-exposure.png', 'image/png', 321_420, h(9.2)),
  artifact('ses_hbm_e5f6', null, 'notes.md', 'text/markdown', 4_210, h(9.5)),

  artifact('ses_weekly16_g7h8', 'docx-generator', 'weekly-2026W16.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 812_321, h(26)),
  artifact('ses_weekly16_g7h8', 'data-export', 'news-clippings.csv', 'text/csv', 18_220, h(26.4)),

  artifact('ses_blackwell_i9j0', 'pptx-generator', 'NVIDIA-Blackwell-briefing.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 6_420_000, d(10)),
  artifact('ses_blackwell_i9j0', 'pdf-generator', 'Blackwell-spec-comparison.pdf', 'application/pdf', 2_410_000, d(10.1)),

  artifact('ses_ddr5_k1l2', 'xlsx-generator', 'DDR5-price-tracker.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 231_542, h(14)),
  artifact('ses_ddr5_k1l2', 'chart-renderer', 'price-trend.png', 'image/png', 214_320, h(14.2)),
  artifact('ses_ddr5_k1l2', 'data-export', 'price-raw.csv', 'text/csv', 31_220, h(14.4)),

  artifact('ses_packaging_m3n4', 'pdf-generator', 'packaging-2-5D-3D-review.pdf', 'application/pdf', 4_820_000, h(40)),
  artifact('ses_packaging_m3n4', 'docx-generator', 'packaging-notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 621_120, h(40.5)),
  artifact('ses_packaging_m3n4', 'chart-renderer', 'thermal-profile.png', 'image/png', 412_310, h(40.8)),
]
