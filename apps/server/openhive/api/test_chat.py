"""Throwaway test endpoint to prove OAuth-token-backed LLM calls work end-to-end.

Not a long-lived API surface — real chat lands in Phase 0C via LangGraph. This just
lets us type a prompt and get a response through the Copilot token we just stored.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from openhive.proxy import copilot

router = APIRouter(prefix="/api/test", tags=["test"])


class TestChatRequest(BaseModel):
    provider: str = "copilot"
    model: str = "gpt-5-mini"
    prompt: str


class TestChatResponse(BaseModel):
    model: str
    reply: str


@router.post("/chat", response_model=TestChatResponse)
async def test_chat(body: TestChatRequest) -> TestChatResponse:
    if body.provider != "copilot":
        raise HTTPException(status_code=400, detail="only 'copilot' is wired in this endpoint yet")
    try:
        reply = await copilot.chat_completion(
            model=body.model,
            messages=[{"role": "user", "content": body.prompt}],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return TestChatResponse(model=body.model, reply=reply)


@router.get("/copilot/models")
async def copilot_models() -> list[dict]:
    try:
        return await copilot.list_models()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
