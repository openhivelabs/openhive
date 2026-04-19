"""Provider-facing streaming interface used by the engine.

Each provider module is expected to expose:

    async def stream(model, messages, tools) -> AsyncIterator[Delta]

where Delta is one of TextDelta / ToolCallDelta / StopDelta. We currently only
wire Copilot, which speaks an OpenAI-compatible protocol. Claude Code / Codex
follow the same interface; their modules just translate the wire format.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx

from openhive.proxy import copilot


@dataclass
class TextDelta:
    text: str


@dataclass
class ToolCallDelta:
    # The provider streams tool calls in pieces (index + partial args).
    # We assemble them in the engine loop, not here.
    index: int
    id: str | None = None
    name: str | None = None
    arguments_chunk: str = ""


@dataclass
class StopDelta:
    reason: str = "stop"  # "stop" | "tool_calls" | ...


Delta = TextDelta | ToolCallDelta | StopDelta


async def stream(
    provider_id: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> AsyncIterator[Delta]:
    if provider_id == "copilot":
        async for d in _copilot_stream(model, messages, tools):
            yield d
        return
    raise RuntimeError(
        f"provider '{provider_id}' not yet wired into the engine. Use 'copilot' for now."
    )


# --------- Copilot (OpenAI-compatible) ---------

async def _copilot_stream(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
) -> AsyncIterator[Delta]:
    session = await copilot._get_session()  # noqa: SLF001 — shared helper
    api = session.endpoints.get("api", "https://api.githubcopilot.com")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            f"{api}/chat/completions",
            headers={
                "Authorization": f"Bearer {session.token}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                **copilot.EDITOR_HEADERS,
            },
            json=payload,
        ) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(f"copilot stream {resp.status_code}: {body.decode()}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                raw = line[6:].strip()
                if raw == "[DONE]":
                    yield StopDelta()
                    return
                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                choice = (chunk.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                text = delta.get("content")
                if text:
                    yield TextDelta(text)
                for tc in delta.get("tool_calls") or []:
                    yield ToolCallDelta(
                        index=tc.get("index", 0),
                        id=tc.get("id"),
                        name=(tc.get("function") or {}).get("name"),
                        arguments_chunk=(tc.get("function") or {}).get("arguments") or "",
                    )
                finish = choice.get("finish_reason")
                if finish:
                    yield StopDelta(reason=finish)
                    return


# Build the initial OpenAI-format message list for a node.
def build_messages(system: str, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.extend(history)
    return msgs
