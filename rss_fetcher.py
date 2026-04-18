"""
YouTube公式RSSを並列取得してマージする。APIキー不要。

RSS: https://www.youtube.com/feeds/videos.xml?channel_id={id}
各チャンネル最新15件まで取得可能。
"""
import datetime as dt
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable

import feedparser

from channels import CHANNELS

log = logging.getLogger(__name__)

# feedparserのデフォルトUAだとYouTubeが間欠的に空レスポンスを返すので差し替える
feedparser.USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={}"


def _fetch_channel(channel: dict) -> list[dict]:
    """1チャンネル分のRSSを取得してエントリを正規化。失敗時は空リスト。"""
    url = RSS_URL.format(channel["id"])
    try:
        feed = feedparser.parse(url)
    except Exception as e:
        log.warning("RSS fetch failed for %s: %s", channel["title"], e)
        return []

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


def fetch_all(max_workers: int = 11, per_channel: int | None = 5) -> list[dict]:
    """全チャンネルを並列取得し、publishedの降順でマージ。

    per_channel: 1チャンネルあたりの最大件数。Noneで制限なし。
    デフォルト5件にすることで、更新の激しいチャンネルがグリッドを占有するのを防ぐ。
    """
    all_videos: list[dict] = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_fetch_channel, ch): ch for ch in CHANNELS}
        for fut in as_completed(futures):
            entries = fut.result()
            # RSSは既にpublishedDesc順で返るので先頭からper_channel件でOK
            if per_channel is not None:
                entries = entries[:per_channel]
            all_videos.extend(entries)

    all_videos.sort(key=lambda v: v["published_dt"], reverse=True)
    return all_videos


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
