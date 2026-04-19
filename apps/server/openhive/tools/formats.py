"""Translate our Tool objects into each provider's tool-call schema.

For now we only emit OpenAI-compatible shape (used by Copilot + Codex).
Anthropic shape lands when we wire Claude Code.
"""

from __future__ import annotations

from typing import Any

from openhive.tools.base import Tool


def to_openai_tools(tools: list[Tool]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in tools
    ]
