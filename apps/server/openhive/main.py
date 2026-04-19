from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from openhive.api import health, providers, runs, test_chat
from openhive.config import get_settings
from openhive.persistence.db import init_db


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(
    title="OpenHive",
    version="0.0.1",
    lifespan=_lifespan,
)

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(providers.router)
app.include_router(runs.router)
app.include_router(test_chat.router)


@app.get("/")
async def root() -> dict[str, object]:
    return {"service": "openhive", "ok": True, "version": "0.0.1"}
