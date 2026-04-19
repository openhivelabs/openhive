"""Typed event schema. Every engine step emits one or more of these.

The same events are persisted to SQLite `run_events` AND fanned out via SSE.
The Run-mode canvas and the Timeline tab both read from this stream.
"""

from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, Field


EventKind = Literal[
    "run_started",
    "run_finished",
    "run_error",
    "node_started",
    "node_finished",
    "token",
    "tool_called",
    "tool_result",
    "delegation_opened",
    "delegation_closed",
    "checkpoint",
]


class Event(BaseModel):
    """One envelope for every event. Unused fields are simply omitted."""

    kind: EventKind
    ts: float = Field(default_factory=time.time)
    run_id: str
    # depth 0 = top-level run. Delegated sub-runs increment depth.
    depth: int = 0
    node_id: str | None = None
    # tool / delegation context
    tool_call_id: str | None = None
    tool_name: str | None = None
    # free-form payload — the UI picks fields by kind
    data: dict[str, Any] = Field(default_factory=dict)


def make_event(
    kind: EventKind,
    run_id: str,
    *,
    depth: int = 0,
    node_id: str | None = None,
    tool_call_id: str | None = None,
    tool_name: str | None = None,
    **data: Any,
) -> Event:
    return Event(
        kind=kind,
        run_id=run_id,
        depth=depth,
        node_id=node_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        data=data,
    )
