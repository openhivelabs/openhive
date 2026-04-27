/**
 * One-shot helper: seed a kanban-friendly table in the Supabase `lawpi`
 * project so the user can install + drive a kanban panel against external
 * data. Idempotent — drops + recreates the table.
 */
import { callTool } from '@/lib/server/mcp/manager'

const PROJECT_ID = 'csbxogsawmsexupfbxdt'
const TEAM_ID = 't-9576ce'

const DDL = `
DROP TABLE IF EXISTS trip_request;
CREATE TABLE trip_request (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  applicant TEXT NOT NULL,
  destination TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT '신청' CHECK (status IN ('신청','검토중','승인','반려')),
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);
`.trim()

const SEED = `
INSERT INTO trip_request (team_id, applicant, destination, purpose, status, start_date, end_date) VALUES
  ('${TEAM_ID}','김민수','도쿄','컨퍼런스 참석','승인','2026-05-10','2026-05-13'),
  ('${TEAM_ID}','이지은','싱가포르','파트너 미팅','검토중','2026-05-15','2026-05-18'),
  ('${TEAM_ID}','박서준','뉴욕','지사 워크샵','신청','2026-06-02','2026-06-07'),
  ('${TEAM_ID}','정수아','베를린','전시 참가','승인','2026-04-29','2026-05-04'),
  ('${TEAM_ID}','한지민','베이징','계약 체결','반려',NULL,NULL),
  ('${TEAM_ID}','오준영','호치민','시장 조사','검토중','2026-05-22','2026-05-26'),
  ('${TEAM_ID}','류현진','시드니','연수 프로그램','신청','2026-07-10','2026-07-20'),
  ('${TEAM_ID}','최예린','파리','클라이언트 방문','승인','2026-05-06','2026-05-09');
`.trim()

async function main(): Promise<void> {
  console.log('Applying DDL…')
  const ddlOut = await callTool(
    'supabase',
    'execute_sql',
    { project_id: PROJECT_ID, query: DDL },
    { cap: false },
  )
  console.log('DDL response:', ddlOut.slice(0, 400))

  console.log('Inserting seed rows…')
  const seedOut = await callTool(
    'supabase',
    'execute_sql',
    { project_id: PROJECT_ID, query: SEED },
    { cap: false },
  )
  console.log('Seed response:', seedOut.slice(0, 400))

  console.log('Verifying…')
  const verify = await callTool(
    'supabase',
    'execute_sql',
    {
      project_id: PROJECT_ID,
      query: `SELECT status, count(*)::int AS n FROM trip_request WHERE team_id = '${TEAM_ID}' GROUP BY status ORDER BY status`,
    },
    { cap: false },
  )
  console.log('Counts:', verify.slice(0, 600))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
