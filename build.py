"""
静的サイトビルダー（Claude Code routines + GitHub Pages 用）

- RSS / HTML スクレイピングで全チャンネルを更新
- Jinja2 で templates/index.html をレンダリングして docs/index.html に書き出し
- static/* を docs/static/ にコピー
- 全動画リストを docs/data.json に書き出し（任意・将来拡張用）

実行: python build.py
"""
import json
import logging
import os
import shutil
from datetime import datetime

from jinja2 import Environment, FileSystemLoader, select_autoescape

import rss_fetcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("build")

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def _url_for(endpoint: str, **kwargs) -> str:
    """Flask の url_for 互換 shim。
    既存テンプレート ({{ url_for('static', filename='...') }}) を無修正で使うため。
    """
    if endpoint == "static":
        filename = kwargs.get("filename", "")
        return f"static/{filename}"
    return "#"


def _json_default(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"not serializable: {type(obj).__name__}")


def main() -> None:
    log.info("Refreshing all channels...")
    count = rss_fetcher.refresh_all()
    log.info("Fetched %d videos across all channels", count)

    raw = rss_fetcher.get_videos(per_channel=15)
    videos = rss_fetcher.enrich_for_display(raw, limit=60) if raw else []
    log.info("Prepared %d videos for rendering", len(videos))

    env = Environment(
        loader=FileSystemLoader("templates"),
        autoescape=select_autoescape(["html"]),
    )
    env.globals["url_for"] = _url_for

    html = env.get_template("index.html").render(
        videos=videos,
        initial_ready=bool(videos),
        last_refresh=datetime.now().isoformat(timespec="seconds"),
    )

    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    log.info("Wrote docs/index.html (%d bytes)", len(html))

    docs_static = os.path.join("docs", "static")
    if os.path.isdir(docs_static):
        shutil.rmtree(docs_static)
    shutil.copytree("static", docs_static)
    log.info("Copied static/ → docs/static/")

    with open(os.path.join("docs", "data.json"), "w", encoding="utf-8") as f:
        json.dump(videos, f, default=_json_default, ensure_ascii=False)
    log.info("Wrote docs/data.json")

    nojekyll = os.path.join("docs", ".nojekyll")
    if not os.path.exists(nojekyll):
        open(nojekyll, "w").close()


if __name__ == "__main__":
    main()
