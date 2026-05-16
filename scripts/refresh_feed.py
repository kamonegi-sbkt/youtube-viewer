from __future__ import annotations

import logging
import os
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from services.feed_refresh import refresh_feed


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main() -> None:
    os.chdir(ROOT_DIR)
    feed = refresh_feed()
    if os.environ.get("YOUTUBE_API_KEY") and not feed["videos"]:
        raise RuntimeError("No videos fetched via YouTube Data API; refusing to publish an empty feed")


if __name__ == "__main__":
    main()
