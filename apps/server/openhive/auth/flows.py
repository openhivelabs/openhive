"""In-memory flow registry tracking in-flight OAuth dances.

Each pending connection gets a short-lived FlowState keyed by a random flow_id returned
to the client. The state holds enough to resume the token exchange when the callback
arrives (PKCE verifier, expected state, provider, redirect URI for auth-code; device
code payload for device-flow). Flow records expire 5 minutes after creation.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Literal


FlowKind = Literal["auth_code", "device_code"]
FlowStatus = Literal["pending", "connected", "error", "expired"]


@dataclass
class FlowState:
    flow_id: str
    provider_id: str
    kind: FlowKind
    status: FlowStatus = "pending"
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    # auth_code specific
    code_verifier: str | None = None
    expected_state: str | None = None
    redirect_uri: str | None = None
    # device_code specific — raw response retained for polling
    device_code: str | None = None
    user_code: str | None = None
    verification_uri: str | None = None
    verification_uri_complete: str | None = None
    device_interval: int | None = None
    device_expires_at: float | None = None
    # result
    account_label: str | None = None


_flows: dict[str, FlowState] = {}
_lock = asyncio.Lock()

FLOW_TTL_SECONDS = 300  # 5 min


def new_flow_id() -> str:
    return secrets.token_urlsafe(16)


async def create(provider_id: str, kind: FlowKind, **fields: Any) -> FlowState:
    async with _lock:
        state = FlowState(flow_id=new_flow_id(), provider_id=provider_id, kind=kind, **fields)
        _flows[state.flow_id] = state
        _gc_locked()
        return state


async def get(flow_id: str) -> FlowState | None:
    async with _lock:
        _gc_locked()
        return _flows.get(flow_id)


async def update(flow_id: str, **fields: Any) -> FlowState | None:
    async with _lock:
        state = _flows.get(flow_id)
        if not state:
            return None
        for k, v in fields.items():
            setattr(state, k, v)
        return state


async def remove(flow_id: str) -> None:
    async with _lock:
        _flows.pop(flow_id, None)


def _gc_locked() -> None:
    now = time.time()
    stale = [fid for fid, f in _flows.items() if now - f.created_at > FLOW_TTL_SECONDS]
    for fid in stale:
        _flows.pop(fid, None)
