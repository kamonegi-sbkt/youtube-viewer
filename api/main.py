from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.config import settings
from api.routers import feed, health


app = FastAPI(title=settings.app_name)
app.include_router(health.router)
app.include_router(feed.router)


def _mount_frontend(dist_dir: Path) -> None:
    assets_dir = dist_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    static_dir = dist_dir / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=static_dir), name="static")


_mount_frontend(settings.frontend_dist_dir)


@app.get("/{path:path}", include_in_schema=False)
def serve_spa(path: str) -> FileResponse:
    index_path = settings.frontend_dist_dir / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    raise HTTPException(status_code=404, detail="Frontend build not found. Run `npm run build` in front/.")
