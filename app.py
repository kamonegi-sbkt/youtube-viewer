"""
YouTube購読チャンネル限定ビューア（Flask）

GET /?k=<APP_SECRET>  → cookieを発行して /
GET /                 → cookie検証、OKなら動画一覧、NGなら gate.html
GET /refresh          → キャッシュ破棄して /
GET /logout           → cookie削除
GET /healthz          → 200 OK
"""
import logging
import os
import secrets
import threading
from functools import wraps

from flask import Flask, make_response, redirect, render_template, request, url_for
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from rss_fetcher import clear_cache, enrich_for_display, fetch_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("youtube_viewer")

APP_SECRET = os.environ.get("APP_SECRET")
if not APP_SECRET:
    log.warning("APP_SECRET is not set. Using a random one (cookies will not persist across restarts).")
    APP_SECRET = secrets.token_urlsafe(32)

COOKIE_NAME = "yv_auth"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30日
SIGNER_SALT = "youtube-viewer-auth"

app = Flask(__name__)
app.secret_key = APP_SECRET

signer = URLSafeTimedSerializer(APP_SECRET, salt=SIGNER_SALT)


REFRESH_INTERVAL = 600  # 10分ごとに自動更新
_refresh_lock = threading.Lock()


def _do_refresh() -> None:
    """キャッシュを丸ごと更新。同時に複数走らないようロックで直列化。"""
    if not _refresh_lock.acquire(blocking=False):
        log.info("Refresh already in progress, skipping")
        return
    try:
        log.info("Refreshing cache...")
        clear_cache()
        videos = fetch_all()
        log.info("Cache refreshed: %d videos", len(videos))
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


def _is_authenticated() -> bool:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return False
    try:
        signer.loads(token, max_age=COOKIE_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def _issue_cookie(resp):
    token = signer.dumps("ok")
    resp.set_cookie(
        COOKIE_NAME,
        token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=request.is_secure,
        samesite="Lax",
    )
    return resp


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not _is_authenticated():
            return render_template("gate.html"), 401
        return view(*args, **kwargs)
    return wrapper


@app.route("/healthz")
def healthz():
    return "ok", 200


@app.route("/")
def index():
    # URLトークンでの認証
    key = request.args.get("k")
    if key and secrets.compare_digest(key, APP_SECRET):
        resp = make_response(redirect(url_for("index")))
        return _issue_cookie(resp)

    if not _is_authenticated():
        return render_template("gate.html"), 401

    videos = fetch_all()
    videos = enrich_for_display(videos, limit=60)
    return render_template("index.html", videos=videos)


@app.route("/refresh")
@login_required
def refresh():
    # ブロックせずに背景で再取得を走らせ、即リダイレクト
    _trigger_async_refresh()
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    resp = make_response(render_template("gate.html", logged_out=True))
    resp.delete_cookie(COOKIE_NAME)
    return resp


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    # デバッグ時もreloaderはオフ（バックグラウンドスレッドが2つ走るのを防ぐ）
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
