"""Model catalogs per provider.

Copilot is dynamic (hits GitHub's /models endpoint). Claude Code and Codex are
hardcoded because their subscription APIs don't expose a public /models listing;
updates land here when new models ship.
"""

from __future__ import annotations

from dataclasses import dataclass

from openhive.proxy import copilot


@dataclass
class Model:
    id: str
    label: str
    default: bool = False

    def to_dict(self) -> dict:
        return {"id": self.id, "label": self.label, "default": self.default}


CLAUDE_CODE_MODELS: list[Model] = [
    Model("claude-opus-4-7", "Opus 4.7", default=True),
    Model("claude-sonnet-4-6", "Sonnet 4.6"),
    Model("claude-haiku-4-5", "Haiku 4.5"),
]

CODEX_MODELS: list[Model] = [
    Model("gpt-5.4", "GPT-5.4"),
    Model("gpt-5.4-mini", "GPT-5.4 mini", default=True),
    Model("gpt-5", "GPT-5"),
    Model("gpt-5-mini", "GPT-5 mini"),
]


async def list_for(provider_id: str) -> list[dict]:
    if provider_id == "claude-code":
        return [m.to_dict() for m in CLAUDE_CODE_MODELS]
    if provider_id == "codex":
        return [m.to_dict() for m in CODEX_MODELS]
    if provider_id == "copilot":
        try:
            raw = await copilot.list_models()
        except RuntimeError:
            # Not connected yet — surface a sane default catalog so the UI still works.
            return [
                Model("gpt-5-mini", "GPT-5 mini", default=True).to_dict(),
                Model("gpt-5", "GPT-5").to_dict(),
                Model("gpt-5.4", "GPT-5.4").to_dict(),
                Model("gpt-5.4-mini", "GPT-5.4 mini").to_dict(),
            ]
        out: list[dict] = []
        for m in raw:
            model_id = m.get("id")
            if not model_id:
                continue
            out.append(
                {
                    "id": model_id,
                    "label": m.get("name") or model_id,
                    "default": model_id == "gpt-5-mini",
                }
            )
        # Sort so the default floats to the top.
        out.sort(key=lambda x: (not x["default"], x["id"]))
        return out
    return []
