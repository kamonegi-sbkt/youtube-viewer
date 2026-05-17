import unittest

from fastapi.testclient import TestClient

import api.routers.feed as feed_router
from api.main import app


class ApiTest(unittest.TestCase):
    def test_health(self) -> None:
        client = TestClient(app)
        response = client.get("/api/v1/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_feed(self) -> None:
        client = TestClient(app)
        original = feed_router.load_feed
        feed_router.load_feed = lambda: {
            "generated_at": "2026-05-16T00:00:00+09:00",
            "videos": [
                {
                    "video_id": "abc",
                    "title": "Demo",
                    "channel_title": "Channel",
                    "channel_id": "UC123",
                    "published_iso": "2026-05-16T00:00:00Z",
                    "thumbnail": "https://example.com/thumb.jpg",
                }
            ],
        }
        try:
            response = client.get("/api/v1/feed")
        finally:
            feed_router.load_feed = original

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")
        self.assertEqual(response.headers["pragma"], "no-cache")
        self.assertEqual(response.json()["videos"][0]["video_id"], "abc")


if __name__ == "__main__":
    unittest.main()
