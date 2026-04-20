from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from openhive.api import (
    agents_generate,
    artifacts,
    companies,
    dashboards,
    files,
    frames,
    health,
    mcp as mcp_api,
    messages,
    panels,
    providers,
    runs,
    snapshots,
    tasks,
    team_data,
    teams_generate,
    test_chat,
    usage,
)
from openhive.mcp import manager as mcp_manager_module
from openhive.config import get_settings
from openhive.persistence.db import init_db
from openhive.scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    start_scheduler()
    try:
        yield
    finally:
        await stop_scheduler()
        await mcp_manager_module.shutdown_all()


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
app.include_router(companies.router)
app.include_router(frames.router)
app.include_router(frames.gallery_router)
app.include_router(messages.router)
app.include_router(teams_generate.router)
app.include_router(agents_generate.router)
app.include_router(team_data.router)
app.include_router(dashboards.router)
app.include_router(snapshots.router)
app.include_router(tasks.router)
app.include_router(mcp_api.router)
app.include_router(artifacts.router)
app.include_router(panels.router)
app.include_router(files.router)
app.include_router(usage.router)


@app.get("/")
async def root() -> dict[str, object]:
    return {"service": "openhive", "ok": True, "version": "0.0.1"}
