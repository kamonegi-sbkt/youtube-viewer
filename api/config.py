from __future__ import annotations

from pathlib import Path
from pydantic import BaseModel


class Settings(BaseModel):
    root_dir: Path = Path(__file__).resolve().parents[1]
    frontend_dist_dir: Path = Path(__file__).resolve().parents[1] / "front" / "dist"
    app_name: str = "My YouTube Viewer"


settings = Settings()
