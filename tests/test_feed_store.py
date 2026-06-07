import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import services.feed_store as feed_store


def reset_remote_cache() -> None:
    feed_store._remote_feed_cache = None
    feed_store._remote_feed_next_refresh_at = 0.0


class FeedStoreTest(unittest.TestCase):
    def tearDown(self) -> None:
        reset_remote_cache()

    def test_save_and_load_feed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "feed.json"
            with (
                mock.patch.object(feed_store, "FEED_PATH", path),
                mock.patch.object(feed_store, "_load_remote_feed", return_value=None),
            ):
                saved = feed_store.save_feed([{"video_id": "abc", "title": "Demo"}])
                loaded = feed_store.load_feed()

        self.assertEqual(saved["videos"][0]["video_id"], "abc")
        self.assertEqual(loaded["videos"][0]["title"], "Demo")

    def test_save_feed_serializes_datetime_values(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "feed.json"
            with (
                mock.patch.object(feed_store, "FEED_PATH", path),
                mock.patch.object(feed_store, "_load_remote_feed", return_value=None),
            ):
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
                mock.patch.object(feed_store, "_load_remote_feed", return_value=None),
            ):
                loaded = feed_store.load_feed()

        self.assertEqual(loaded["videos"][0]["video_id"], "legacy")

    def test_load_feed_prefers_remote_feed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / "feed.json"
            local.write_text(json.dumps({"videos": [{"video_id": "local"}]}), encoding="utf-8")
            response = mock.Mock()
            response.json.return_value = {
                "generated_at": "2026-06-07T00:00:00+09:00",
                "videos": [{"video_id": "remote"}],
            }
            response.raise_for_status.return_value = None

            with (
                mock.patch.object(feed_store, "FEED_PATH", local),
                mock.patch.object(feed_store.requests, "get", return_value=response),
            ):
                loaded = feed_store.load_feed()

        self.assertEqual(loaded["generated_at"], "2026-06-07T00:00:00+09:00")
        self.assertEqual(loaded["videos"][0]["video_id"], "remote")

    def test_load_feed_uses_last_remote_success_when_refresh_fails(self) -> None:
        success = mock.Mock()
        success.json.return_value = {"videos": [{"video_id": "remote"}], "generated_at": "fresh"}
        success.raise_for_status.return_value = None

        with mock.patch.object(feed_store.requests, "get", return_value=success):
            self.assertEqual(feed_store.load_feed()["videos"][0]["video_id"], "remote")

        feed_store._remote_feed_next_refresh_at = 0.0
        with (
            mock.patch.object(feed_store.requests, "get", side_effect=feed_store.requests.RequestException("boom")),
            mock.patch.object(feed_store.log, "warning"),
        ):
            loaded = feed_store.load_feed()

        self.assertEqual(loaded["generated_at"], "fresh")
        self.assertEqual(loaded["videos"][0]["video_id"], "remote")

    def test_load_feed_falls_back_to_local_when_remote_has_no_cache(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / "feed.json"
            local.write_text(json.dumps({"videos": [{"video_id": "local"}]}), encoding="utf-8")
            with (
                mock.patch.object(feed_store, "FEED_PATH", local),
                mock.patch.object(feed_store.requests, "get", side_effect=feed_store.requests.RequestException("boom")),
                mock.patch.object(feed_store.log, "warning"),
            ):
                loaded = feed_store.load_feed()

        self.assertEqual(loaded["videos"][0]["video_id"], "local")


if __name__ == "__main__":
    unittest.main()
