"""Providers API — list, start OAuth flow, poll status, delete.

Auth Code flow (Claude Code / Codex):
  POST /api/providers/{id}/connect/start  → { kind:"auth_code", flow_id, auth_url }
  frontend opens auth_url in popup; user authorizes; provider redirects to
  GET  /api/providers/oauth/callback?code=…&state=…&flow_id=…
  which exchanges + stores tokens, then closes the popup page.
  Frontend polls GET /api/providers/{id}/connect/status?flow_id=… for "connected"/"error".

Device Code flow (Copilot):
  POST /api/providers/{id}/connect/start  → { kind:"device_code", flow_id, user_code,
                                               verification_uri, interval, expires_at }
  frontend displays user_code + opens verification_uri.
  Server polls GitHub every `interval` seconds in the background.
  Frontend polls GET /api/providers/{id}/connect/status?flow_id=… until connected.
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from openhive.auth import claude, codex, copilot, flows, pkce
from openhive.auth.providers import PROVIDERS, get as get_provider
from openhive.persistence import tokens

router = APIRouter(prefix="/api/providers", tags=["providers"])


# ---------- response models ----------------------------------------------------------

class ProviderStatus(BaseModel):
    id: str
    label: str
    kind: str
    description: str
    connected: bool
    account_label: str | None = None


class StartAuthCodeResponse(BaseModel):
    kind: str = "auth_code"
    flow_id: str
    auth_url: str


class StartDeviceCodeResponse(BaseModel):
    kind: str = "device_code"
    flow_id: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str | None = None
    interval: int
    expires_at: int


class FlowStatusResponse(BaseModel):
    status: str
    error: str | None = None
    account_label: str | None = None


# ---------- list ---------------------------------------------------------------------

@router.get("", response_model=list[ProviderStatus])
async def list_providers() -> list[ProviderStatus]:
    connected_ids = set(tokens.list_connected())
    return [
        ProviderStatus(
            id=p.id,
            label=p.label,
            kind=p.kind,
            description=p.description,
            connected=p.id in connected_ids,
            account_label=tokens.get_account_label(p.id) if p.id in connected_ids else None,
        )
        for p in PROVIDERS
    ]


@router.delete("/{provider_id}")
async def disconnect(provider_id: str) -> dict[str, bool]:
    p = get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail="unknown provider")
    removed = tokens.delete(provider_id)
    return {"removed": removed}


# ---------- start flow ---------------------------------------------------------------

@router.post("/{provider_id}/connect/start")
async def start_connect(provider_id: str, request: Request):
    p = get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail="unknown provider")

    base = str(request.base_url).rstrip("/")  # e.g. http://127.0.0.1:4484
    callback_uri = f"{base}/api/providers/oauth/callback"

    if p.kind == "auth_code":
        challenge = pkce.generate()
        state = await flows.create(
            provider_id=provider_id,
            kind="auth_code",
            code_verifier=challenge.code_verifier,
            expected_state=challenge.state,
            redirect_uri=callback_uri,
        )
        if provider_id == "claude-code":
            auth_url = claude.build_authorize_url(callback_uri, challenge.state, challenge.code_challenge)
        elif provider_id == "codex":
            auth_url = codex.build_authorize_url(callback_uri, challenge.state, challenge.code_challenge)
        else:
            raise HTTPException(status_code=400, detail=f"no auth_code impl for {provider_id}")
        # Tag the flow id into state so callback can recover it
        auth_url_with_flow = auth_url + f"&flow_id={state.flow_id}"
        return StartAuthCodeResponse(flow_id=state.flow_id, auth_url=auth_url_with_flow)

    if p.kind == "device_code":
        if provider_id != "copilot":
            raise HTTPException(status_code=400, detail=f"no device_code impl for {provider_id}")
        data = await copilot.request_device_code()
        interval = int(data.get("interval", 5))
        expires_at = int(time.time()) + int(data.get("expires_in", 900))
        state = await flows.create(
            provider_id=provider_id,
            kind="device_code",
            device_code=data["device_code"],
            user_code=data["user_code"],
            verification_uri=data["verification_uri"],
            verification_uri_complete=data.get("verification_uri_complete"),
            device_interval=interval,
            device_expires_at=expires_at,
        )
        asyncio.create_task(_poll_device(state.flow_id))
        return StartDeviceCodeResponse(
            flow_id=state.flow_id,
            user_code=data["user_code"],
            verification_uri=data["verification_uri"],
            verification_uri_complete=data.get("verification_uri_complete"),
            interval=interval,
            expires_at=expires_at,
        )

    raise HTTPException(status_code=500, detail="unknown flow kind")


# ---------- callback (auth_code) -----------------------------------------------------

@router.get("/oauth/callback", response_class=HTMLResponse)
async def oauth_callback(
    code: str | None = None,
    state: str | None = None,
    flow_id: str | None = Query(None),
    error: str | None = None,
    error_description: str | None = None,
):
    if error:
        return _callback_page(ok=False, message=error_description or error)
    if not code or not state or not flow_id:
        return _callback_page(ok=False, message="missing code/state/flow_id")

    flow = await flows.get(flow_id)
    if not flow or flow.kind != "auth_code":
        return _callback_page(ok=False, message="unknown or expired flow")
    if flow.expected_state != state.split("#", 1)[0]:
        # some providers append "#..." into state — tolerate
        if flow.expected_state not in state:
            await flows.update(flow_id, status="error", error="state mismatch")
            return _callback_page(ok=False, message="state mismatch")

    try:
        if flow.provider_id == "claude-code":
            tok = await claude.exchange_code(code, flow.redirect_uri or "", flow.code_verifier or "", state)
        elif flow.provider_id == "codex":
            tok = await codex.exchange_code(code, flow.redirect_uri or "", flow.code_verifier or "")
        else:
            raise RuntimeError("unsupported provider")
    except Exception as exc:  # noqa: BLE001 — surface to user
        await flows.update(flow_id, status="error", error=str(exc))
        return _callback_page(ok=False, message=str(exc))

    expires_at = None
    if tok.get("expires_in"):
        expires_at = int(time.time()) + int(tok["expires_in"])

    tokens.save(
        tokens.TokenRecord(
            provider_id=flow.provider_id,
            access_token=tok["access_token"],
            refresh_token=tok.get("refresh_token"),
            expires_at=expires_at,
            scope=tok.get("scope"),
            account_label=None,
        )
    )
    await flows.update(flow_id, status="connected")
    return _callback_page(ok=True, message=f"{flow.provider_id} connected. You can close this tab.")


# ---------- status -------------------------------------------------------------------

@router.get("/{provider_id}/connect/status", response_model=FlowStatusResponse)
async def connect_status(provider_id: str, flow_id: str) -> FlowStatusResponse:
    flow = await flows.get(flow_id)
    if not flow or flow.provider_id != provider_id:
        raise HTTPException(status_code=404, detail="flow not found")
    return FlowStatusResponse(
        status=flow.status,
        error=flow.error,
        account_label=flow.account_label,
    )


# ---------- device code poll ---------------------------------------------------------

async def _poll_device(flow_id: str) -> None:
    flow = await flows.get(flow_id)
    if not flow or flow.kind != "device_code" or not flow.device_code:
        return
    interval = flow.device_interval or 5
    expires_at = flow.device_expires_at or (time.time() + 900)
    while time.time() < expires_at:
        await asyncio.sleep(interval)
        flow = await flows.get(flow_id)
        if not flow or flow.status != "pending":
            return
        try:
            tok = await copilot.poll_token(flow.device_code or "")
        except Exception as exc:  # noqa: BLE001
            await flows.update(flow_id, status="error", error=str(exc))
            return
        if tok is None:
            continue
        access_token = tok["access_token"]
        label = await copilot.fetch_account_label(access_token)
        tokens.save(
            tokens.TokenRecord(
                provider_id=flow.provider_id,
                access_token=access_token,
                refresh_token=tok.get("refresh_token"),
                expires_at=None,
                scope=tok.get("scope"),
                account_label=label,
            )
        )
        await flows.update(flow_id, status="connected", account_label=label)
        return
    await flows.update(flow_id, status="expired", error="device code expired")


# ---------- callback page ------------------------------------------------------------

def _callback_page(ok: bool, message: str) -> HTMLResponse:
    color = "#10b981" if ok else "#ef4444"
    title = "Connected" if ok else "Connection failed"
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>OpenHive — {title}</title>
<style>
body {{ font-family: system-ui, -apple-system, sans-serif; display:flex;
       align-items:center; justify-content:center; height:100vh; margin:0;
       background:#fafafa; color:#111; }}
.card {{ max-width: 420px; padding:32px; text-align:center;
        border:1px solid #e5e5e5; border-radius:16px; background:white; }}
.badge {{ display:inline-block; width:48px; height:48px; line-height:48px; border-radius:999px;
         background:{color}20; color:{color}; font-size:24px; font-weight:700; }}
h1 {{ font-size:18px; margin:16px 0 8px; }}
p {{ color:#666; margin:0; }}
</style></head>
<body><div class="card">
  <div class="badge">{'✓' if ok else '✗'}</div>
  <h1>{title}</h1>
  <p>{message}</p>
</div>
<script>setTimeout(() => window.close(), 1500);</script>
</body></html>"""
    return HTMLResponse(html)
