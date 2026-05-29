import unittest
from unittest import mock

from services import feed_refresh


class FeedRefreshTest(unittest.TestCase):
    def test_refresh_feed_defaults_to_150_videos_from_50_per_channel(self) -> None:
        with (
            mock.patch.object(feed_refresh.rss_fetcher, "refresh_all", return_value=50),
            mock.patch.object(feed_refresh.rss_fetcher, "get_videos", return_value=[{"video_id": "abc"}]) as get_videos,
            mock.patch.object(feed_refresh.rss_fetcher, "enrich_for_display", return_value=[{"video_id": "abc"}]) as enrich,
            mock.patch.object(feed_refresh, "save_feed", return_value={"videos": [{"video_id": "abc"}]}) as save_feed,
        ):
            result = feed_refresh.refresh_feed()

        get_videos.assert_called_once_with(per_channel=50)
        enrich.assert_called_once_with([{"video_id": "abc"}], limit=150)
        save_feed.assert_called_once()
        self.assertEqual(result["videos"][0]["video_id"], "abc")


if __name__ == "__main__":
    unittest.main()
