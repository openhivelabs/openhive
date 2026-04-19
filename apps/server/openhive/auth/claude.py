"""Claude Code OAuth flow — Authorization Code + PKCE.

Configs sourced from 9router's public repo; if Anthropic changes them upstream the
connect flow will break and this file is the one to update.
"""

from __future__ import annotations

from urllib.parse import urlencode

import httpx

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
SCOPES = ["org:create_api_key", "user:profile", "user:inference"]


def build_authorize_url(redirect_uri: str, state: str, code_challenge: str) -> str:
    params = {
        "code": "true",  # Claude-specific quirk preserved from 9router
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": " ".join(SCOPES),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code(
    code: str,
    redirect_uri: str,
    code_verifier: str,
    state: str,
) -> dict:
    # Claude's UI sometimes returns "code#state" in a single param — split it.
    auth_code, fragment_state = code, ""
    if "#" in code:
        auth_code, _, fragment_state = code.partition("#")

    payload = {
        "code": auth_code,
        "state": fragment_state or state,
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            TOKEN_URL,
            json=payload,
            headers={"Accept": "application/json"},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"Claude token exchange failed ({resp.status_code}): {resp.text}")
    return resp.json()
