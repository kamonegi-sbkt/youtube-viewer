"""
YouTube動画を取得してマージする。

`YOUTUBE_API_KEY` 環境変数が設定されていれば YouTube Data API v3 経由で取得（クラウド routine 用）。
未設定なら従来の RSS + HTML スクレイピング経路（ローカル開発用、API キー不要）。

API v3 経路:
  - playlistItems.list で各チャンネルの uploads プレイリスト（UU{id_without_UC}）から最新15件
  - videos.list で duration / live_status をまとめて取得（バッチ50件）
  - quota: 11ch × 1 + 4 batches × 1 ≈ 15 unit/refresh、無料枠 10000/日

RSS 経路:
  - https://www.youtube.com/feeds/videos.xml?channel_id={id}
  - HTML スクレイピング (ytInitialData) で duration を補完
  - データセンターIPは YouTube に 403 で弾かれやすい
"""
import datetime as dt
import json
import logging
import os
import re
import time
from typing import Iterable

try:
    import feedparser
except Exception:
    feedparser = None  # type: ignore[assignment]
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


_LEN_TEXT_RE = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})")


def _parse_length_text(text: str | None) -> int | None:
    """`5:16` `1:23:45` `0:30` などを秒に変換。失敗時None。"""
    if not text:
        return None
    m = _LEN_TEXT_RE.fullmatch(text.strip())
    if not m:
        return None
    h, mi, se = m.group(1), m.group(2), m.group(3)
    return int(h or 0) * 3600 + int(mi) * 60 + int(se)


def _extract_live_status(vr: dict) -> str:
    """videoRenderer の thumbnailOverlays から "live" / "upcoming" を判定。
    通常動画なら空文字列を返す。"""
    overlays = vr.get("thumbnailOverlays") or []
    for ov in overlays:
        ts = ov.get("thumbnailOverlayTimeStatusRenderer")
        if not ts:
            continue
        style = ts.get("style", "")
        if style == "LIVE":
            return "live"
        if style == "UPCOMING":
            return "upcoming"
    return ""


def _scrape_channel_html(channel: dict, timeout: int = 20) -> list[dict]:
    """HTML経由で動画を取得。各videoには duration_seconds (取れた場合) と live_status も含む。"""
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

        length_text = (vr.get("lengthText") or {}).get("simpleText")
        duration_sec = _parse_length_text(length_text)
        live_status = _extract_live_status(vr)

        videos.append({
            "video_id": video_id,
            "title": title,
            "channel_title": channel["title"],
            "channel_id": channel["id"],
            "published_iso": published_dt.isoformat(),
            "published_dt": published_dt,
            "thumbnail": thumb_url,
            "duration_seconds": duration_sec,
            "live_status": live_status,
        })
        if len(videos) >= 15:
            break

    return _dedup_by_video_id(videos)


def _dedup_by_video_id(videos: list[dict]) -> list[dict]:
    """同じ video_id が複数ある場合、最初のものだけ残す。
    YouTube RSS は配信中のライブを「予約」「ライブ中」など複数のエントリで返すことがあるため。"""
    seen: set[str] = set()
    out = []
    for v in videos:
        vid = v.get("video_id")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        out.append(v)
    return out


def _scrape_channel_html_indexed(channel: dict, timeout: int = 20) -> dict[str, dict]:
    """HTMLスクレイピング結果を video_id -> video の辞書にして返す。
    RSSパスからの動画に duration / live_status を補完するために使う。"""
    return {v["video_id"]: v for v in _scrape_channel_html(channel, timeout=timeout)}


def _absorb_durations_into_cache(meta_map: dict[str, int]) -> None:
    """duration辞書を永続キャッシュへ反映。新規分があった場合のみdiskに書く。"""
    if not meta_map:
        return
    changed = False
    for vid, sec in meta_map.items():
        if vid not in _VIDEO_META_CACHE:
            _VIDEO_META_CACHE[vid] = {"duration_seconds": sec}
            changed = True
    if changed:
        _save_video_meta_cache()


_API_BASE = "https://www.googleapis.com/youtube/v3"
_ISO8601_DURATION_RE = re.compile(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$")


def _redact_api_key(text: object) -> str:
    """ログにAPIキーを出さないため、例外文字列内の key=... を伏せる。"""
    return re.sub(r"([?&]key=)[^&\s]+", r"\1<redacted>", str(text))


def _parse_iso8601_duration(s: str | None) -> int | None:
    """`PT5M16S` `PT1H23M45S` `PT30S` を秒に変換。"""
    if not s:
        return None
    m = _ISO8601_DURATION_RE.match(s)
    if not m:
        return None
    h, mi, se = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + int(se or 0)


def _best_thumbnail(thumbs: dict, video_id: str) -> str:
    """API レスポンスの thumbnails dict から最大解像度の URL を返す。"""
    for k in ("maxres", "standard", "high", "medium", "default"):
        if k in thumbs and thumbs[k].get("url"):
            return thumbs[k]["url"]
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def _api_get(path: str, params: dict, timeout: int = 20) -> dict:
    r = requests.get(f"{_API_BASE}/{path}", params=params, timeout=timeout)
    if r.status_code != 200:
        raise requests.HTTPError(f"YouTube API {path} returned {r.status_code}: {r.text[:200]}")
    return r.json()


def _api_playlist_items(api_key: str, playlist_id: str, max_results: int = 15) -> list[dict]:
    return _api_get("playlistItems", {
        "key": api_key,
        "playlistId": playlist_id,
        "part": "snippet",
        "maxResults": max_results,
    }).get("items", [])


def _api_videos_details(api_key: str, video_ids: list[str]) -> dict[str, dict]:
    """video_id -> {duration_seconds, live_status} のマップ。最大50件ずつバッチ取得。"""
    out: dict[str, dict] = {}
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        items = _api_get("videos", {
            "key": api_key,
            "id": ",".join(batch),
            "part": "contentDetails,snippet",
        }).get("items", [])
        for item in items:
            vid = item.get("id")
            if not vid:
                continue
            duration_sec = _parse_iso8601_duration(item.get("contentDetails", {}).get("duration"))
            broadcast = item.get("snippet", {}).get("liveBroadcastContent")
            live_status = broadcast if broadcast in ("live", "upcoming") else ""
            out[vid] = {"duration_seconds": duration_sec, "live_status": live_status}
    return out


def _fetch_channel_via_api(api_key: str, channel: dict) -> list[dict]:
    """YouTube Data API v3 経由でチャンネルの最新動画を取得。
    `UC{id}` の uploads プレイリストは規則的に `UU{id}` でアクセスできる。"""
    uploads_playlist_id = "UU" + channel["id"][2:] if channel["id"].startswith("UC") else channel["id"]
    try:
        items = _api_playlist_items(api_key, uploads_playlist_id, max_results=15)
    except requests.RequestException as e:
        log.warning("playlistItems.list failed for %s: %s", channel["title"], _redact_api_key(e))
        return []

    if not items:
        return []

    video_ids = [
        it.get("snippet", {}).get("resourceId", {}).get("videoId")
        for it in items
    ]
    video_ids = [v for v in video_ids if v]
    try:
        details = _api_videos_details(api_key, video_ids)
    except requests.RequestException as e:
        log.warning("videos.list failed for %s: %s", channel["title"], _redact_api_key(e))
        details = {}

    videos: list[dict] = []
    for it in items:
        snippet = it.get("snippet", {}) or {}
        vid = snippet.get("resourceId", {}).get("videoId")
        if not vid:
            continue
        published_iso = snippet.get("publishedAt", "")
        try:
            published_dt = dt.datetime.fromisoformat(published_iso.replace("Z", "+00:00"))
        except ValueError:
            continue
        d = details.get(vid, {})
        videos.append({
            "video_id": vid,
            "title": snippet.get("title", ""),
            "channel_title": channel["title"],
            "channel_id": channel["id"],
            "published_iso": published_iso,
            "published_dt": published_dt,
            "thumbnail": _best_thumbnail(snippet.get("thumbnails", {}) or {}, vid),
            "duration_seconds": d.get("duration_seconds"),
            "live_status": d.get("live_status", ""),
        })

    _absorb_durations_into_cache({
        v["video_id"]: v["duration_seconds"]
        for v in videos
        if v.get("duration_seconds") is not None
    })
    return _dedup_by_video_id(videos)


def _fetch_channel(channel: dict) -> list[dict]:
    """API キーがあれば YouTube Data API v3 を使い、無ければ RSS+HTML 経路。
    両経路とも duration を永続キャッシュへ書き込み、live_status も付与する。"""
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if api_key:
        return _fetch_channel_via_api(api_key, channel)
    body = _get_rss_bytes(channel)
    if body is not None:
        feed = feedparser.parse(body)
        if feed.entries:
            videos = _parse_feed_entries(channel, feed)
            if videos:
                # RSSパスは duration / live_status 無しなので HTML から補完
                html_map = _scrape_channel_html_indexed(channel)
                for v in videos:
                    h = html_map.get(v["video_id"])
                    if not h:
                        continue
                    if h.get("duration_seconds") is not None:
                        v["duration_seconds"] = h["duration_seconds"]
                    if h.get("live_status"):
                        v["live_status"] = h["live_status"]
                _absorb_durations_into_cache({
                    vid: h["duration_seconds"]
                    for vid, h in html_map.items()
                    if h.get("duration_seconds") is not None
                })
                return videos

    # フォールバック
    log.info("Falling back to HTML scraping for %s", channel["title"])
    videos = _scrape_channel_html(channel)
    _absorb_durations_into_cache({
        v["video_id"]: v["duration_seconds"]
        for v in videos
        if v.get("duration_seconds") is not None
    })
    return videos


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
    return _dedup_by_video_id(videos)


# チャンネル別キャッシュ: 成功時に上書き、失敗しても残す（permanent）
_CHANNEL_CACHE: dict[str, list[dict]] = {}

# ── 動画メタ（duration）の永続キャッシュ ──────────────────
# durationは不変なので一度取得したら永続保存する。サーバ再起動後も即座にバッジ表示が可能。
VIDEO_META_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "video_meta.json")

_VIDEO_META_CACHE: dict[str, dict] = {}


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


def refresh_all(inter_request_delay: float | None = None) -> int:
    """全チャンネルを順次取得してキャッシュを更新。失敗したチャンネルは前回値を残す。
    duration は _fetch_channel 内のAPI/HTMLスクレイプから永続キャッシュに書き込まれる。
    成功した件数（動画数）を返す。
    inter_request_delay 未指定時: API キーがあれば 0、無ければ 2.0 秒（IPブロック回避）。
    """
    if inter_request_delay is None:
        inter_request_delay = 0.0 if os.environ.get("YOUTUBE_API_KEY") else 2.0
    success_count = 0
    for ch in CHANNELS:
        entries = _fetch_channel(ch)
        if entries:
            _CHANNEL_CACHE[ch["id"]] = entries
            success_count += len(entries)
        else:
            log.info("Fetch failed for %s; keeping previous cache", ch["title"])
        if inter_request_delay > 0:
            time.sleep(inter_request_delay)
    return success_count


def _is_shorts_title(title: str | None) -> bool:
    """タイトルに #shorts (大文字小文字無視) が含まれていればShortsと判定。"""
    return "#shorts" in (title or "").lower()


def get_videos(per_channel: int | None = 5) -> list[dict]:
    """キャッシュから動画リストを組み立てる。publishedの降順でマージ。
    タイトルに `#shorts` を含む動画はShortsとして除外。video_id で重複排除する。
    """
    all_videos: list[dict] = []
    for ch in CHANNELS:
        entries = _CHANNEL_CACHE.get(ch["id"], [])
        filtered = [e for e in entries if not _is_shorts_title(e.get("title", ""))]
        deduped = _dedup_by_video_id(filtered)
        if per_channel is not None:
            deduped = deduped[:per_channel]
        all_videos.extend(deduped)
    all_videos.sort(key=lambda v: v["published_dt"], reverse=True)
    return _dedup_by_video_id(all_videos)


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
        live_status = v.get("live_status", "")
        duration_sec = v.get("duration_seconds")
        if duration_sec is None:
            meta = _VIDEO_META_CACHE.get(v["video_id"])
            if meta:
                duration_sec = meta.get("duration_seconds")

        if live_status == "live":
            badge_text, badge_kind = "LIVE", "live"
        elif live_status == "upcoming":
            badge_text, badge_kind = "配信予定", "upcoming"
        elif duration_sec is not None:
            badge_text, badge_kind = _format_duration(duration_sec), ""
        else:
            badge_text, badge_kind = "", ""

        out.append({
            **v,
            "rel_time": humanize_delta(now, v["published_dt"]),
            "duration_text": badge_text,
            "badge_kind": badge_kind,
        })
    return out
