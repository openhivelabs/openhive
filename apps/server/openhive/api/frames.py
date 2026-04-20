"""Frame export + install endpoints.

Endpoints:
  GET  /api/companies/{c}/teams/{t}/frame   → YAML download (Save as Frame)
  POST /api/companies/{c}/frames/install    → install a frame into the company
                                              body: { frame: <parsed yaml dict> }
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from openhive.persistence import frames as frame_store
from openhive.persistence import tokens

router = APIRouter(prefix="/api/companies", tags=["frames"])
gallery_router = APIRouter(prefix="/api/frames", tags=["frames"])


# Bundled frames live at <repo>/packages/frames/*.openhive-frame.yaml. Path is
# resolved the same way panel-templates are (4 parents up from this file).
_FRAMES_ROOT = Path(__file__).resolve().parents[4] / "packages" / "frames"


_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(name: str) -> str:
    base = _FILENAME_SAFE.sub("-", name).strip("-") or "team"
    return f"{base}.openhive-frame.yaml"


@router.get("/{company_slug}/teams/{team_slug}/frame")
async def export_frame(company_slug: str, team_slug: str) -> Response:
    try:
        frame = frame_store.build_frame(company_slug, team_slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    body = yaml.safe_dump(frame, sort_keys=False, allow_unicode=True)
    filename = _safe_filename(str(frame.get("name") or team_slug))
    return Response(
        content=body,
        media_type="application/x-yaml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class InstallFrameRequest(BaseModel):
    frame: dict[str, Any]


@gallery_router.get("/gallery")
async def list_gallery() -> list[dict[str, Any]]:
    """Return bundled sample frames — lightweight metadata plus the raw frame dict."""
    out: list[dict[str, Any]] = []
    if not _FRAMES_ROOT.is_dir():
        return out
    for path in sorted(_FRAMES_ROOT.glob("*.openhive-frame.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if not isinstance(data, dict) or data.get("openhive_frame") != 1:
            continue
        team = data.get("team") or {}
        requires = data.get("requires") or {}
        out.append(
            {
                "id": path.stem.removesuffix(".openhive-frame"),
                "name": str(data.get("name") or path.stem),
                "description": str(data.get("description") or ""),
                "version": str(data.get("version") or "1.0.0"),
                "tags": list(data.get("tags") or []),
                "agent_count": len(team.get("agents") or []) if isinstance(team, dict) else 0,
                "has_dashboard": bool(data.get("dashboard")),
                "requires": {
                    "skills": list(requires.get("skills") or []) if isinstance(requires, dict) else [],
                    "providers": list(requires.get("providers") or []) if isinstance(requires, dict) else [],
                },
                "frame": data,
            }
        )
    return out


@router.post("/{company_slug}/frames/install")
async def install_frame(company_slug: str, body: InstallFrameRequest) -> dict[str, Any]:
    connected = set(tokens.list_connected())
    try:
        result = frame_store.install_frame(
            company_slug,
            body.frame,
            connected_providers=connected,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result
