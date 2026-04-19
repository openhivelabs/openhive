"""Throwaway test endpoint to prove OAuth-token-backed LLM calls work end-to-end.

Not a long-lived API surface — real chat lands in Phase 0C via LangGraph. This just
lets us type a prompt and get a response through the Copilot token we just stored.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
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


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant" | "system"
    content: str


class ChatStreamRequest(BaseModel):
    provider: str = "copilot"
    model: str = "gpt-5-mini"
    system: str | None = None
    messages: list[ChatMessage]


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


@router.post("/chat/stream")
async def test_chat_stream(body: ChatStreamRequest) -> StreamingResponse:
    if body.provider != "copilot":
        raise HTTPException(
            status_code=400, detail="only 'copilot' is wired for streaming right now"
        )

    messages: list[dict[str, str]] = []
    if body.system:
        messages.append({"role": "system", "content": body.system})
    for m in body.messages:
        messages.append({"role": m.role, "content": m.content})

    async def event_stream():
        try:
            async for chunk in copilot.stream_chat(model=body.model, messages=messages):
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
        except Exception as exc:  # noqa: BLE001 — report upstream errors to client
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.get("/copilot/models")
async def copilot_models() -> list[dict]:
    try:
        return await copilot.list_models()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
