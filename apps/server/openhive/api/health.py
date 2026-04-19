from fastapi import APIRouter

from openhive import __version__

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
