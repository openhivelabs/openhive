"""Server settings, loaded from env + ~/.openhive/config.yaml + apps/server/.env."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="OPENHIVE_",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 4484
    data_dir: Path = Field(default_factory=lambda: Path.home() / ".openhive")
    # 32-byte urlsafe-base64 Fernet key. If empty, one is generated on first run and
    # persisted to data_dir/encryption.key.
    encryption_key: str = ""

    # Comma-separated list of origins allowed for CORS. The Next dev server runs on 4483.
    cors_origins: str = "http://localhost:4483,http://127.0.0.1:4483"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "openhive.db"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
        _settings.data_dir.mkdir(parents=True, exist_ok=True)
    return _settings
