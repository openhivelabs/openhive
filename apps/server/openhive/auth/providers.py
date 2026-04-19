"""Provider registry — static metadata for each OAuth provider we support.

Flow implementations live in auth.services.*. Each entry defines how the browser-side
UI should render the provider (label, description) and how the backend should talk to
its OAuth endpoints.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


Kind = Literal["auth_code", "device_code"]


@dataclass(frozen=True)
class ProviderDef:
    id: str
    label: str
    kind: Kind
    description: str


# Order matters — this is the display order in the UI.
PROVIDERS: list[ProviderDef] = [
    ProviderDef(
        id="claude-code",
        label="Claude Code",
        kind="auth_code",
        description="Use your Claude Code subscription to power agents with Claude models.",
    ),
    ProviderDef(
        id="codex",
        label="OpenAI Codex",
        kind="auth_code",
        description="Use your Codex (ChatGPT) subscription for agents running on GPT models.",
    ),
    ProviderDef(
        id="copilot",
        label="GitHub Copilot",
        kind="device_code",
        description="Use your GitHub Copilot subscription. Activates via device-code login.",
    ),
]

_BY_ID = {p.id: p for p in PROVIDERS}


def get(provider_id: str) -> ProviderDef | None:
    return _BY_ID.get(provider_id)
