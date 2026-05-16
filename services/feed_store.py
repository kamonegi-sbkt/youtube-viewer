from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
FEED_PATH = ROOT_DIR / "data" / "feed.json"
LEGACY_FEED_PATH = ROOT_DIR / "docs" / "data.json"


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"not serializable: {type(value).__name__}")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2, default=_json_default)
        f.write("\n")
    tmp.replace(path)


def load_feed() -> dict[str, Any]:
    """Load the generated feed for the API.

    `data/feed.json` is the FastAPI-era source of truth. `docs/data.json` is
    accepted as a migration fallback so the app can still run before the first
    refresh workflow has produced the new file.
    """
    if FEED_PATH.exists():
        data = _read_json(FEED_PATH)
        if isinstance(data, dict):
            return data
        if isinstance(data, list):
            return {"videos": data, "generated_at": None}

    if LEGACY_FEED_PATH.exists():
        data = _read_json(LEGACY_FEED_PATH)
        if isinstance(data, list):
            return {"videos": data, "generated_at": None}

    return {"videos": [], "generated_at": None}


def save_feed(videos: list[dict[str, Any]], generated_at: datetime | None = None) -> dict[str, Any]:
    feed = {
        "generated_at": (generated_at or datetime.now().astimezone()).isoformat(timespec="seconds"),
        "videos": videos,
    }
    _write_json(FEED_PATH, feed)
    return feed
