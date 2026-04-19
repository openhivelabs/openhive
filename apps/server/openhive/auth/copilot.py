"""GitHub Copilot OAuth — Device Code flow.

User flow:
  1. POST /login/device/code → get device_code + user_code + verification_uri
  2. Show user_code to user; user visits verification_uri and types it
  3. Poll /oauth/access_token at `interval` seconds until user completes auth
  4. GET /user to resolve the account label
"""

from __future__ import annotations

import httpx

CLIENT_ID = "Iv1.b507a08c87ecfe98"
DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
SCOPES = "read:user"
USER_AGENT = "GitHubCopilotChat/0.26.7"


async def request_device_code() -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            DEVICE_CODE_URL,
            data={"client_id": CLIENT_ID, "scope": SCOPES},
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"GitHub device code failed ({resp.status_code}): {resp.text}")
    return resp.json()


async def poll_token(device_code: str) -> dict | None:
    """Returns the token dict once the user completes auth, else None for pending."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
    data = resp.json()
    if "access_token" in data:
        return data
    error = data.get("error")
    if error in {"authorization_pending", "slow_down"}:
        return None
    raise RuntimeError(f"GitHub device poll failed: {data}")


async def fetch_account_label(access_token: str) -> str | None:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            USER_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": USER_AGENT,
            },
        )
    if resp.status_code != 200:
        return None
    data = resp.json()
    return data.get("login") or data.get("email")
