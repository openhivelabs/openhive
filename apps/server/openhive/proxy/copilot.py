"""GitHub Copilot API helper.

Two-stage auth:
  1. Long-lived GitHub OAuth token (stored in oauth_tokens) →
     GET https://api.github.com/copilot_internal/v2/token  → short-lived Copilot token
  2. Short-lived token is used against https://api.githubcopilot.com/chat/completions
     with an OpenAI-compatible payload.

Short-lived tokens expire ~30 min; we cache them in-process keyed by provider_id.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

from openhive.persistence import tokens

COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions"
COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"

# Editor identity headers are required by Copilot's API gateway.
EDITOR_HEADERS = {
    "Editor-Version": "vscode/1.85.0",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "Copilot-Integration-Id": "vscode-chat",
}


@dataclass
class _CachedSession:
    token: str
    expires_at: float
    endpoints: dict[str, str]


_session_cache: dict[str, _CachedSession] = {}


async def _refresh_copilot_session(provider_id: str = "copilot") -> _CachedSession:
    record = tokens.load(provider_id)
    if not record:
        raise RuntimeError("Copilot is not connected. Connect it in Settings first.")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            COPILOT_TOKEN_URL,
            headers={
                "Authorization": f"token {record.access_token}",
                "Accept": "application/json",
                **EDITOR_HEADERS,
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"copilot_internal/v2/token failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data["token"]
    expires_at = float(data.get("expires_at") or (time.time() + 1500))
    endpoints = data.get("endpoints") or {}
    session = _CachedSession(token=token, expires_at=expires_at, endpoints=endpoints)
    _session_cache[provider_id] = session
    return session


async def _get_session(provider_id: str = "copilot") -> _CachedSession:
    cached = _session_cache.get(provider_id)
    if cached and cached.expires_at - 60 > time.time():
        return cached
    return await _refresh_copilot_session(provider_id)


async def list_models(provider_id: str = "copilot") -> list[dict[str, Any]]:
    session = await _get_session(provider_id)
    api = session.endpoints.get("api", "https://api.githubcopilot.com")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{api}/models",
            headers={
                "Authorization": f"Bearer {session.token}",
                **EDITOR_HEADERS,
            },
        )
    resp.raise_for_status()
    return resp.json().get("data", [])


async def chat_completion(
    model: str,
    messages: list[dict[str, str]],
    provider_id: str = "copilot",
    temperature: float = 0.7,
) -> str:
    session = await _get_session(provider_id)
    api = session.endpoints.get("api", "https://api.githubcopilot.com")
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{api}/chat/completions",
            headers={
                "Authorization": f"Bearer {session.token}",
                "Content-Type": "application/json",
                **EDITOR_HEADERS,
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "stream": False,
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"copilot chat failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]


async def stream_chat(
    model: str,
    messages: list[dict[str, str]],
    provider_id: str = "copilot",
    temperature: float = 0.7,
) -> AsyncIterator[str]:
    session = await _get_session(provider_id)
    api = session.endpoints.get("api", "https://api.githubcopilot.com")
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            f"{api}/chat/completions",
            headers={
                "Authorization": f"Bearer {session.token}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                **EDITOR_HEADERS,
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "stream": True,
            },
        ) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(f"copilot stream failed ({resp.status_code}): {body.decode()}")
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:].strip()
                if payload == "[DONE]":
                    return
                import json

                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                if delta:
                    yield delta
