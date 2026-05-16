from __future__ import annotations

import logging
from datetime import datetime

import rss_fetcher

from services.feed_store import save_feed


log = logging.getLogger(__name__)


def refresh_feed(limit: int = 60, per_channel: int = 15) -> dict:
    log.info("Refreshing all channels...")
    count = rss_fetcher.refresh_all()
    log.info("Fetched %d videos across all channels", count)

    raw = rss_fetcher.get_videos(per_channel=per_channel)
    videos = rss_fetcher.enrich_for_display(raw, limit=limit) if raw else []
    feed = save_feed(videos, generated_at=datetime.now().astimezone())
    log.info("Prepared %d videos for API feed", len(videos))
    return feed
