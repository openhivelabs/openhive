"""Run endpoint — POST /api/runs/stream.

Receives a team spec + goal, runs the engine, streams typed events as SSE.
The frontend ChatTab subscribes to this stream and renders per-agent messages
as they arrive, including delegation steps.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from openhive.engine import TeamSpec, run_team

router = APIRouter(prefix="/api/runs", tags=["runs"])


class StartRunRequest(BaseModel):
    team: TeamSpec
    goal: str


@router.post("/stream")
async def start_run(body: StartRunRequest) -> StreamingResponse:
    async def sse():
        async for event in run_team(body.team, body.goal):
            yield f"data: {event.model_dump_json()}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
