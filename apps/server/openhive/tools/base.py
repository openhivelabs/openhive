"""Tool primitives. A Tool is just metadata + an async handler."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema
    handler: Callable[[dict[str, Any]], Awaitable[Any]]
    # UI hint — shown to the user when the tool runs (e.g. "Delegating to Researcher…")
    hint: str | None = None


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    call_id: str
    name: str
    content: str
    is_error: bool = False
