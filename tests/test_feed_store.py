import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import services.feed_store as feed_store


class FeedStoreTest(unittest.TestCase):
    def test_save_and_load_feed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "feed.json"
            with mock.patch.object(feed_store, "FEED_PATH", path):
                saved = feed_store.save_feed([{"video_id": "abc", "title": "Demo"}])
                loaded = feed_store.load_feed()

        self.assertEqual(saved["videos"][0]["video_id"], "abc")
        self.assertEqual(loaded["videos"][0]["title"], "Demo")

    def test_save_feed_serializes_datetime_values(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "feed.json"
            with mock.patch.object(feed_store, "FEED_PATH", path):
                feed_store.save_feed([{"video_id": "abc", "published_dt": datetime(2026, 5, 16, tzinfo=timezone.utc)}])
                loaded = feed_store.load_feed()

        self.assertEqual(loaded["videos"][0]["published_dt"], "2026-05-16T00:00:00+00:00")

    def test_legacy_list_feed_is_wrapped(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            legacy = Path(td) / "data.json"
            legacy.write_text(json.dumps([{"video_id": "legacy"}]), encoding="utf-8")
            with (
                mock.patch.object(feed_store, "FEED_PATH", Path(td) / "missing.json"),
                mock.patch.object(feed_store, "LEGACY_FEED_PATH", legacy),
            ):
                loaded = feed_store.load_feed()

        self.assertEqual(loaded["videos"][0]["video_id"], "legacy")


if __name__ == "__main__":
    unittest.main()
