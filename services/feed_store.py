from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests


ROOT_DIR = Path(__file__).resolve().parents[1]
FEED_PATH = ROOT_DIR / "data" / "feed.json"
LEGACY_FEED_PATH = ROOT_DIR / "docs" / "data.json"
REMOTE_FEED_URL = "https://raw.githubusercontent.com/kamonegi-sbkt/youtube-viewer/main/data/feed.json"
REMOTE_FEED_TTL_SECONDS = 60
REMOTE_FEED_FAILURE_TTL_SECONDS = 10
REMOTE_FEED_TIMEOUT_SECONDS = 5

log = logging.getLogger(__name__)
_remote_feed_cache: dict[str, Any] | None = None
_remote_feed_next_refresh_at = 0.0


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


def _normalize_feed(data: Any) -> dict[str, Any] | None:
    if isinstance(data, dict):
        videos = data.get("videos")
        return data if isinstance(videos, list) else None
    if isinstance(data, list):
        return {"videos": data, "generated_at": None}
    return None


def _fetch_remote_feed(now: float) -> dict[str, Any] | None:
    try:
        response = requests.get(
            REMOTE_FEED_URL,
            headers={
                "Accept": "application/json",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
            params={"reload": str(int(now))},
            timeout=REMOTE_FEED_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        log.warning("Failed to fetch remote feed: %s", exc)
        return None

    feed = _normalize_feed(data)
    if feed is None:
        log.warning("Remote feed has an unexpected shape")
    return feed


def _load_remote_feed() -> dict[str, Any] | None:
    global _remote_feed_cache, _remote_feed_next_refresh_at

    now = time.monotonic()
    if now < _remote_feed_next_refresh_at:
        return _remote_feed_cache

    feed = _fetch_remote_feed(now)
    if feed is not None:
        _remote_feed_cache = feed
        _remote_feed_next_refresh_at = now + REMOTE_FEED_TTL_SECONDS
        return feed

    # Retry sooner after a failure so a transient outage does not pin the
    # stale (or missing) cache for the full TTL.
    _remote_feed_next_refresh_at = now + REMOTE_FEED_FAILURE_TTL_SECONDS
    return _remote_feed_cache


def _load_local_feed() -> dict[str, Any]:
    if FEED_PATH.exists():
        feed = _normalize_feed(_read_json(FEED_PATH))
        if feed is not None:
            return feed

    if LEGACY_FEED_PATH.exists():
        feed = _normalize_feed(_read_json(LEGACY_FEED_PATH))
        if feed is not None:
            return feed

    return {"videos": [], "generated_at": None}


def load_feed() -> dict[str, Any]:
    """Load the generated feed for the API.

    The live app reads the refreshed feed from GitHub raw so scheduled data
    updates do not require a Hugging Face Space redeploy.
    """
    return _load_remote_feed() or _load_local_feed()


def save_feed(videos: list[dict[str, Any]], generated_at: datetime | None = None) -> dict[str, Any]:
    feed = {
        "generated_at": (generated_at or datetime.now().astimezone()).isoformat(timespec="seconds"),
        "videos": videos,
    }
    _write_json(FEED_PATH, feed)
    return feed
