"""
YouTube公式RSSを並列取得してマージする。APIキー不要。

RSS: https://www.youtube.com/feeds/videos.xml?channel_id={id}
各チャンネル最新15件まで取得可能。
"""
import datetime as dt
import logging
import time
from typing import Iterable

import feedparser
import requests

from channels import CHANNELS

log = logging.getLogger(__name__)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Referer": "https://www.youtube.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={}"


def _get_rss_bytes(channel: dict, timeout: int = 20, retries: int = 5) -> bytes | None:
    """指数バックオフ + Referer付きでRSSを取得。

    YouTubeは連続アクセスでIP単位に404/500を返すことが多いので、
    じっくり時間をかけて再試行する。
    """
    url = RSS_URL.format(channel["id"])
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
            if r.status_code == 200 and r.content:
                return r.content
            log.warning("RSS status=%s for %s (attempt %d)", r.status_code, channel["title"], attempt + 1)
        except requests.RequestException as e:
            log.warning("RSS request error for %s (attempt %d): %s", channel["title"], attempt + 1, e)
        # 2s, 4s, 8s, 16s, 32s
        if attempt < retries:
            time.sleep(2 ** (attempt + 1))
    return None


def _fetch_channel(channel: dict) -> list[dict]:
    """1チャンネル分のRSSを取得してエントリを正規化。失敗時は空リスト。"""
    body = _get_rss_bytes(channel)
    if body is None:
        return []

    feed = feedparser.parse(body)

    if feed.bozo and not feed.entries:
        log.warning("RSS parse error for %s: %s", channel["title"], feed.bozo_exception)
        return []

    videos = []
    for entry in feed.entries:
        video_id = entry.get("yt_videoid")
        if not video_id:
            continue

        published_iso = entry.get("published", "")
        try:
            published_dt = dt.datetime.fromisoformat(published_iso.replace("Z", "+00:00"))
        except ValueError:
            continue

        thumbnails = entry.get("media_thumbnail") or []
        thumb_url = thumbnails[0].get("url") if thumbnails else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

        videos.append({
            "video_id": video_id,
            "title": entry.get("title", ""),
            "channel_title": channel["title"],
            "channel_id": channel["id"],
            "published_iso": published_iso,
            "published_dt": published_dt,
            "thumbnail": thumb_url,
        })
    return videos


# チャンネル別キャッシュ: 成功時に上書き、失敗しても残す（permanent）
_CHANNEL_CACHE: dict[str, list[dict]] = {}


def refresh_all(inter_request_delay: float = 2.0) -> int:
    """全チャンネルを順次取得してキャッシュを更新。失敗したチャンネルは前回値を残す。
    成功した件数（動画数）を返す。
    """
    success_count = 0
    for ch in CHANNELS:
        entries = _fetch_channel(ch)
        if entries:
            _CHANNEL_CACHE[ch["id"]] = entries
            success_count += len(entries)
        else:
            log.info("Fetch failed for %s; keeping previous cache", ch["title"])
        time.sleep(inter_request_delay)
    return success_count


def get_videos(per_channel: int | None = 5) -> list[dict]:
    """キャッシュから動画リストを組み立てる。publishedの降順でマージ。"""
    all_videos: list[dict] = []
    for ch in CHANNELS:
        entries = _CHANNEL_CACHE.get(ch["id"], [])
        if per_channel is not None:
            entries = entries[:per_channel]
        all_videos.extend(entries)
    all_videos.sort(key=lambda v: v["published_dt"], reverse=True)
    return all_videos


# 後方互換: 旧API名も残す（最初のリクエストで同期的に温める用途）
def fetch_all(per_channel: int | None = 5) -> list[dict]:
    if not _CHANNEL_CACHE:
        refresh_all()
    return get_videos(per_channel=per_channel)


def clear_cache() -> None:
    _CHANNEL_CACHE.clear()


def humanize_delta(now: dt.datetime, then: dt.datetime) -> str:
    """相対時刻「X分前」「X時間前」「X日前」を返す。"""
    if then.tzinfo is None:
        then = then.replace(tzinfo=dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    delta = now - then
    s = int(delta.total_seconds())
    if s < 60:
        return "たった今"
    if s < 3600:
        return f"{s // 60}分前"
    if s < 86400:
        return f"{s // 3600}時間前"
    if s < 86400 * 7:
        return f"{s // 86400}日前"
    if s < 86400 * 30:
        return f"{s // (86400 * 7)}週間前"
    if s < 86400 * 365:
        return f"{s // (86400 * 30)}ヶ月前"
    return f"{s // (86400 * 365)}年前"


def enrich_for_display(videos: Iterable[dict], limit: int = 60) -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for v in list(videos)[:limit]:
        out.append({
            **v,
            "rel_time": humanize_delta(now, v["published_dt"]),
        })
    return out
