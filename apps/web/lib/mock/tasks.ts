import type { Task } from '../types'

const now = Date.now()
const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString()
const hoursAgo = (n: number) => new Date(now - n * 3_600_000).toISOString()

export const mockTasks: Task[] = [
  // ─── Running (with streaming-like partial output) ───────────────────────
  {
    id: 'mt-running-1',
    teamId: 't1',
    title: '반도체 시장 3분기 요약',
    prompt: '삼성·SK하이닉스·TSMC의 2026년 3분기 실적을 비교 분석하고 핵심 수치를 표로 정리해.',
    mode: 'now',
    createdAt: minutesAgo(3),
    sessions: [
      {
        id: 'mr-running-1',
        taskId: 'mt-running-1',
        teamId: 't1',
        goal: '삼성·SK하이닉스·TSMC의 2026년 3분기 실적을 비교 분석하고 핵심 수치를 표로 정리해.',
        status: 'running',
        startedAt: minutesAgo(2),
        messages: [
          {
            id: 'mm-r1-1',
            teamId: 't1',
            from: 'a1',
            text:
              'Researcher 에게 각 사 IR 자료 수집을 위임하고, 수치가 모이면 Writer 에게 표 작성을 맡길게.',
            createdAt: minutesAgo(2),
          },
          {
            id: 'mm-r1-2',
            teamId: 't1',
            from: 'system',
            text: '↘ Researcher: 삼성/SK하이닉스/TSMC 3분기 매출·영업이익·점유율 수집',
            createdAt: minutesAgo(2),
          },
          {
            id: 'mm-r1-3',
            teamId: 't1',
            from: 'a2',
            text: '삼성전자: 매출 79.1조, 영업이익 9.2조… (조사 진행 중)',
            createdAt: minutesAgo(1),
          },
        ],
      },
    ],
    references: [
      {
        id: 'ref-r1-1',
        name: 'samsung-q3-ir.pdf',
        size: 284_120,
        kind: 'binary',
      },
      {
        id: 'ref-r1-2',
        name: 'market-share-2025.csv',
        size: 4_832,
        kind: 'text',
        content: 'vendor,share\nSamsung,0.41\nSK hynix,0.25\nTSMC,0.18\nMicron,0.09',
      },
    ],
  },

  // ─── Needs input ────────────────────────────────────────────────────────
  {
    id: 'mt-ask-1',
    teamId: 't1',
    title: '경쟁사 비교 리포트',
    prompt: '경쟁사 A, B, C 를 우리 제품과 비교하는 리포트 작성.',
    mode: 'now',
    createdAt: minutesAgo(8),
    sessions: [
      {
        id: 'mr-ask-1',
        taskId: 'mt-ask-1',
        teamId: 't1',
        goal: '경쟁사 A, B, C 를 우리 제품과 비교하는 리포트 작성.',
        status: 'running',
        startedAt: minutesAgo(7),
        messages: [
          {
            id: 'mm-a1-1',
            teamId: 't1',
            from: 'a1',
            text: '비교 관점(가격/기능/고객층) 중 어느 축을 가장 강조할까요? 사용자에게 확인 필요.',
            createdAt: minutesAgo(7),
          },
          {
            id: 'mm-a1-2',
            teamId: 't1',
            from: 'system',
            text: '❓ Lead 이 1개 질문 중…',
            createdAt: minutesAgo(6),
          },
        ],
        pendingAsk: {
          toolCallId: 'mock-ask-1',
          agentRole: 'Lead',
          questions: [
            {
              question: '리포트의 핵심 축을 어느 것으로 잡을까요?',
              header: '리포트 축',
              multiSelect: false,
              options: [
                { label: '가격 경쟁력 (Recommended)', description: '가장 수치화가 쉬움' },
                { label: '기능 매트릭스', description: '제품별 기능 비교표' },
                { label: '고객층·세그먼트', description: '타깃 시장 분석 중심' },
              ],
            },
          ],
        },
      },
    ],
    references: [],
  },

  // ─── Scheduled (cron, never session yet) ─────────────────────────────────────
  {
    id: 'mt-sched-1',
    teamId: 't1',
    title: '일일 뉴스 요약',
    prompt: '반도체 업계 주요 뉴스 5개를 요약해서 팀 노트에 추가.',
    mode: 'scheduled',
    cron: '0 9 * * *',
    createdAt: hoursAgo(20),
    sessions: [],
    references: [],
  },
  {
    id: 'mt-sched-2',
    teamId: 't1',
    title: '주간 시장 동향 브리프',
    prompt: '한 주간의 메모리 반도체 시장 동향을 10줄로 요약.',
    mode: 'scheduled',
    cron: '0 9 * * MON',
    createdAt: hoursAgo(30),
    sessions: [
      // Previously ran, now back to waiting for next cron fire
      {
        id: 'mr-sched-prev',
        taskId: 'mt-sched-2',
        teamId: 't1',
        goal: '월요일 09:00 주간 브리핑.',
        status: 'done',
        startedAt: hoursAgo(16),
        endedAt: hoursAgo(15),
        messages: [
          {
            id: 'mm-s2-1',
            teamId: 't1',
            from: 'a1',
            text: '지난주 메모리 반도체 시장은…',
            createdAt: hoursAgo(15),
          },
        ],
      },
    ],
    references: [],
  },

  // ─── Draft (created, not session) ────────────────────────────────────────────
  {
    id: 'mt-draft-1',
    teamId: 't1',
    title: '고객사 인터뷰 질문지',
    prompt: '우리 제품을 쓰는 고객 대상 15분 인터뷰에 쓸 질문 8개 작성.',
    mode: 'now',
    createdAt: minutesAgo(42),
    sessions: [],
    references: [],
  },
  {
    id: 'mt-draft-2',
    teamId: 't1',
    title: 'PRD 초안',
    prompt: '신기능 "AI 메모 자동 분류" 에 대한 PRD 초안.',
    mode: 'now',
    createdAt: hoursAgo(3),
    sessions: [],
    references: [],
  },

  // ─── Done ────────────────────────────────────────────────────────────────
  {
    id: 'mt-done-1',
    teamId: 't1',
    title: '회의록 정리',
    prompt: '첨부된 녹취록에서 결정 사항·액션 아이템 추출.',
    mode: 'now',
    createdAt: hoursAgo(5),
    sessions: [
      {
        id: 'mr-done-1',
        taskId: 'mt-done-1',
        teamId: 't1',
        goal: '첨부된 녹취록에서 결정 사항·액션 아이템 추출.',
        status: 'done',
        startedAt: hoursAgo(5),
        endedAt: hoursAgo(4),
        messages: [
          {
            id: 'mm-d1-1',
            teamId: 't1',
            from: 'a1',
            text: '결정 사항 3개, 액션 아이템 6개를 정리했습니다.',
            createdAt: hoursAgo(4),
          },
        ],
      },
    ],
    references: [
      {
        id: 'ref-d1-1',
        name: 'meeting-transcript.md',
        size: 12_004,
        kind: 'text',
        content: '# 2026-04-15 팀 회의\n\n참석: 이동윤, 김연구, …\n\n1. KPI 재설정 논의\n2. Q2 로드맵',
      },
    ],
  },
  {
    id: 'mt-done-2',
    teamId: 't1',
    title: '경쟁사 조사',
    prompt: 'Vendor X 의 최근 6개월 제품 출시 내역.',
    mode: 'now',
    createdAt: hoursAgo(26),
    sessions: [
      {
        id: 'mr-done-2',
        taskId: 'mt-done-2',
        teamId: 't1',
        goal: 'Vendor X 의 최근 6개월 제품 출시 내역.',
        status: 'done',
        startedAt: hoursAgo(26),
        endedAt: hoursAgo(25),
        messages: [],
      },
    ],
    references: [],
  },

  // ─── Failed ──────────────────────────────────────────────────────────────
  {
    id: 'mt-fail-1',
    teamId: 't1',
    title: 'PDF 생성',
    prompt: '최근 리포트를 PDF로 변환.',
    mode: 'now',
    createdAt: hoursAgo(2),
    sessions: [
      {
        id: 'mr-fail-1',
        taskId: 'mt-fail-1',
        teamId: 't1',
        goal: '최근 리포트를 PDF로 변환.',
        status: 'failed',
        startedAt: hoursAgo(2),
        endedAt: hoursAgo(2),
        error: 'weasyprint binary not found on server',
        messages: [],
      },
    ],
    references: [],
  },
]
