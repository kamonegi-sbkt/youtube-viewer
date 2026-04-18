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
    clear_cache()
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    resp = make_response(render_template("gate.html", logged_out=True))
    resp.delete_cookie(COOKIE_NAME)
    return resp


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    app.run(host="0.0.0.0", port=port, debug=True)
