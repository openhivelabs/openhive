"""PKCE helpers (RFC 7636)."""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass


@dataclass
class PKCEChallenge:
    code_verifier: str
    code_challenge: str
    state: str


def generate() -> PKCEChallenge:
    code_verifier = _urlsafe_b64(secrets.token_bytes(32))
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = _urlsafe_b64(digest)
    state = _urlsafe_b64(secrets.token_bytes(16))
    return PKCEChallenge(code_verifier, code_challenge, state)


def _urlsafe_b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")
