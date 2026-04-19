"""Fernet-based at-rest encryption for OAuth tokens."""

from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from openhive.config import get_settings


_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    settings = get_settings()
    if settings.encryption_key:
        return settings.encryption_key.encode()
    key_path: Path = settings.data_dir / "encryption.key"
    if key_path.exists():
        return key_path.read_bytes().strip()
    key = Fernet.generate_key()
    key_path.write_bytes(key)
    key_path.chmod(0o600)
    return key


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plain: str) -> str:
    return get_fernet().encrypt(plain.encode()).decode()


def decrypt(cipher: str) -> str:
    return get_fernet().decrypt(cipher.encode()).decode()
