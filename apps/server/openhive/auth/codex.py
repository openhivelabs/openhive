"""OpenAI Codex OAuth flow — Authorization Code + PKCE."""

from __future__ import annotations

from urllib.parse import urlencode

import httpx

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
TOKEN_URL = "https://auth.openai.com/oauth/token"
SCOPE = "openid profile email offline_access"
EXTRA = {
    "id_token_add_organizations": "true",
    "codex_cli_simplified_flow": "true",
    "originator": "codex_cli_rs",
}


def build_authorize_url(redirect_uri: str, state: str, code_challenge: str) -> str:
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SCOPE,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
        **EXTRA,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code(code: str, redirect_uri: str, code_verifier: str) -> dict:
    payload = {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            TOKEN_URL,
            data=payload,
            headers={"Accept": "application/json"},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"Codex token exchange failed ({resp.status_code}): {resp.text}")
    return resp.json()
