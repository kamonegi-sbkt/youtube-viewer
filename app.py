"""
YouTube購読チャンネルビューア（Flask, 認証なし）

GET /        → 動画一覧
GET /refresh → 背景でキャッシュ更新して /
GET /healthz → 200 OK
"""
import logging
import os
import threading

from flask import Flask, redirect, render_template, url_for

from rss_fetcher import enrich_for_display, get_videos, refresh_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("youtube_viewer")

app = Flask(__name__)


REFRESH_INTERVAL = 600  # 10分ごとに自動更新
_refresh_lock = threading.Lock()


def _do_refresh() -> None:
    """全チャンネル再取得。成功したチャンネルだけキャッシュ上書き、失敗は前回値維持。"""
    if not _refresh_lock.acquire(blocking=False):
        log.info("Refresh already in progress, skipping")
        return
    try:
        log.info("Refreshing cache...")
        count = refresh_all()
        log.info("Refresh done: %d videos fetched this round", count)
    except Exception as e:
        log.warning("Refresh failed: %s", e)
    finally:
        _refresh_lock.release()


def _refresh_loop():
    import time as _t
    while True:
        _do_refresh()
        _t.sleep(REFRESH_INTERVAL)


def _trigger_async_refresh() -> None:
    threading.Thread(target=_do_refresh, daemon=True).start()


def _start_background_thread() -> None:
    # Flaskのreloaderを使うと親プロセスでもモジュールが読まれてスレッドが二重に走るので、
    # "reloaderの親" の場合だけスキップ（WERKZEUG_RUN_MAIN が未設定のケース）。
    # gunicorn など通常起動では WERKZEUG_RUN_MAIN は定義されないので下の条件は真になる。
    flask_reloader_parent = (
        os.environ.get("WERKZEUG_RUN_MAIN") is None
        and "flask" in (os.environ.get("FLASK_RUN_FROM_CLI") or "")
    )
    if not flask_reloader_parent:
        threading.Thread(target=_refresh_loop, daemon=True).start()


_start_background_thread()


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/")
def index():
    videos = get_videos()
    if not videos:
        _do_refresh()
        videos = get_videos()
    videos = enrich_for_display(videos, limit=60)
    return render_template("index.html", videos=videos)


@app.route("/refresh")
def refresh():
    _trigger_async_refresh()
    return redirect(url_for("index"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    # デバッグ時もreloaderはオフ（バックグラウンドスレッドが2つ走るのを防ぐ）
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
