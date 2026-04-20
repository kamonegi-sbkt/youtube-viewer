"""
YouTube公式RSSを並列取得してマージする。APIキー不要。

RSS: https://www.youtube.com/feeds/videos.xml?channel_id={id}
各チャンネル最新15件まで取得可能。
"""
import datetime as dt
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
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


def _parse_relative_ja(text: str, now: dt.datetime) -> dt.datetime | None:
    """「3日前」「12時間前」のような文字列を概算の絶対時刻に変換。"""
    if not text:
        return None
    m = re.search(r"(\d+)\s*(分|時間|日|週間|週|ヶ月|か月|カ月|年)", text)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2)
    if unit == "分":
        return now - dt.timedelta(minutes=n)
    if unit == "時間":
        return now - dt.timedelta(hours=n)
    if unit == "日":
        return now - dt.timedelta(days=n)
    if unit in ("週間", "週"):
        return now - dt.timedelta(weeks=n)
    if unit in ("ヶ月", "か月", "カ月"):
        return now - dt.timedelta(days=30 * n)
    if unit == "年":
        return now - dt.timedelta(days=365 * n)
    return None


def _scrape_channel_html(channel: dict, timeout: int = 20) -> list[dict]:
    """HTML経由で動画を取得するフォールバック。RSSが弾かれた時に使う。"""
    url = f"https://www.youtube.com/channel/{channel['id']}/videos"
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
        if r.status_code != 200:
            log.warning("HTML status=%s for %s", r.status_code, channel["title"])
            return []
    except requests.RequestException as e:
        log.warning("HTML request error for %s: %s", channel["title"], e)
        return []

    m = re.search(r"var ytInitialData\s*=\s*(\{.+?\});\s*</script>", r.text)
    if not m:
        log.warning("ytInitialData not found for %s", channel["title"])
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        log.warning("ytInitialData JSON decode error for %s: %s", channel["title"], e)
        return []

    # 「動画」タブのrichGridRenderer.contentsを掘る
    tabs = data.get("contents", {}).get("twoColumnBrowseResultsRenderer", {}).get("tabs", [])
    items = []
    for tab in tabs:
        tab_r = tab.get("tabRenderer") or {}
        tab_content = tab_r.get("content", {}).get("richGridRenderer", {}).get("contents")
        if tab_content:
            items = tab_content
            break
    if not items:
        log.warning("No videos tab content for %s", channel["title"])
        return []

    now = dt.datetime.now(dt.timezone.utc)
    videos = []
    # HTML上の並びは新着順。position_rankで降順ソートできるよう絶対時刻を推定
    for idx, item in enumerate(items):
        vr = item.get("richItemRenderer", {}).get("content", {}).get("videoRenderer")
        if not vr:
            continue
        video_id = vr.get("videoId")
        if not video_id:
            continue
        title_runs = vr.get("title", {}).get("runs") or []
        title = title_runs[0].get("text") if title_runs else ""
        published_text = (vr.get("publishedTimeText") or {}).get("simpleText") or ""
        published_dt = _parse_relative_ja(published_text, now) or (now - dt.timedelta(hours=idx))
        thumbs = vr.get("thumbnail", {}).get("thumbnails") or []
        thumb_url = thumbs[-1]["url"] if thumbs else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        # https:// プロトコル保証
        if thumb_url.startswith("//"):
            thumb_url = "https:" + thumb_url

        videos.append({
            "video_id": video_id,
            "title": title,
            "channel_title": channel["title"],
            "channel_id": channel["id"],
            "published_iso": published_dt.isoformat(),
            "published_dt": published_dt,
            "thumbnail": thumb_url,
        })
        if len(videos) >= 15:
            break

    return videos


def _fetch_channel(channel: dict) -> list[dict]:
    """RSSを優先、失敗したらHTMLスクレイピングにフォールバック。"""
    body = _get_rss_bytes(channel)
    if body is not None:
        feed = feedparser.parse(body)
        if feed.entries:
            videos = _parse_feed_entries(channel, feed)
            if videos:
                return videos

    # フォールバック
    log.info("Falling back to HTML scraping for %s", channel["title"])
    return _scrape_channel_html(channel)


def _parse_feed_entries(channel: dict, feed) -> list[dict]:
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

# ── 動画メタ（duration）の永続キャッシュ ──────────────────
# durationは不変なので一度取得したら永続保存する。サーバ再起動後も即座にバッジ表示が可能。
VIDEO_META_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "video_meta.json")
SHORTS_THRESHOLD_SEC = 60

_VIDEO_META_CACHE: dict[str, dict] = {}
_LENGTH_RE = re.compile(r'"lengthSeconds":"(\d+)"')


def _load_video_meta_cache() -> None:
    global _VIDEO_META_CACHE
    try:
        with open(VIDEO_META_CACHE_PATH, "r", encoding="utf-8") as f:
            _VIDEO_META_CACHE = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _VIDEO_META_CACHE = {}


def _save_video_meta_cache() -> None:
    os.makedirs(os.path.dirname(VIDEO_META_CACHE_PATH), exist_ok=True)
    tmp = VIDEO_META_CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_VIDEO_META_CACHE, f, ensure_ascii=False)
    os.replace(tmp, VIDEO_META_CACHE_PATH)


_load_video_meta_cache()


def _fetch_video_meta(video_id: str, timeout: int = 15) -> dict | None:
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=timeout)
        if r.status_code != 200:
            return None
        m = _LENGTH_RE.search(r.text)
        if not m:
            return None
        return {"duration_seconds": int(m.group(1))}
    except requests.RequestException:
        return None


def _enrich_meta_for_new_ids(video_ids: list[str], max_workers: int = 5) -> None:
    """未取得の動画IDに対してwatchページからdurationを取得して永続キャッシュへ。"""
    seen: set[str] = set()
    todo: list[str] = []
    for vid in video_ids:
        if vid in _VIDEO_META_CACHE or vid in seen:
            continue
        seen.add(vid)
        todo.append(vid)
    if not todo:
        return
    log.info("Fetching video meta for %d new videos", len(todo))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        results = list(ex.map(_fetch_video_meta, todo))
    changed = False
    for vid, meta in zip(todo, results):
        if meta is not None:
            _VIDEO_META_CACHE[vid] = meta
            changed = True
    if changed:
        _save_video_meta_cache()


def refresh_all(inter_request_delay: float = 2.0) -> int:
    """全チャンネルを順次取得してキャッシュを更新。失敗したチャンネルは前回値を残す。
    成功した件数（動画数）を返す。
    各チャンネルのfetch直後にそのチャンネル分のdurationメタを取得することで、
    初回ロード時にも先頭のチャンネルからdurationバッジが表示できるようにする。
    """
    success_count = 0
    for ch in CHANNELS:
        entries = _fetch_channel(ch)
        if entries:
            _CHANNEL_CACHE[ch["id"]] = entries
            success_count += len(entries)
            _enrich_meta_for_new_ids([e["video_id"] for e in entries])
        else:
            log.info("Fetch failed for %s; keeping previous cache", ch["title"])
        time.sleep(inter_request_delay)
    return success_count


def get_videos(per_channel: int | None = 5) -> list[dict]:
    """キャッシュから動画リストを組み立てる。publishedの降順でマージ。
    durationが分かっていて60秒以下のものはShortsとして除外。
    未取得の動画は次回refreshで判定されるまで一旦表示する。
    """
    all_videos: list[dict] = []
    for ch in CHANNELS:
        entries = _CHANNEL_CACHE.get(ch["id"], [])
        filtered = []
        for e in entries:
            meta = _VIDEO_META_CACHE.get(e["video_id"])
            if meta and meta.get("duration_seconds", 0) <= SHORTS_THRESHOLD_SEC:
                continue
            filtered.append(e)
        if per_channel is not None:
            filtered = filtered[:per_channel]
        all_videos.extend(filtered)
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


def _format_duration(sec: int) -> str:
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def enrich_for_display(videos: Iterable[dict], limit: int = 60) -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for v in list(videos)[:limit]:
        meta = _VIDEO_META_CACHE.get(v["video_id"])
        duration_text = _format_duration(meta["duration_seconds"]) if meta else ""
        out.append({
            **v,
            "rel_time": humanize_delta(now, v["published_dt"]),
            "duration_text": duration_text,
        })
    return out
