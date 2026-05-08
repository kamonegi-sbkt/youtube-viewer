# My YouTube Viewer

自分で登録したチャンネルの新着動画だけを、時系列で表示するシンプルなビューア。YouTube本家のアルゴリズム推薦・ショート・急上昇から距離を置いて、ノイズなしでキャッチアップするためのアプリ。

## 構成

**GitHub Actions + GitHub Pages** の完全静的構成。

- **GitHub Actions** が 15 分ごとに YouTube Data API v3 で新着を取得 → `docs/index.html` を生成 → GitHub に push
- **GitHub Pages** が `docs/` をそのまま配信
- 24/7 稼働サーバー不要・認証なし・公開

## 特徴

- **11チャンネル固定**: `channels.py` に書いたチャンネルの新着だけを表示（意図的に小さく保つ）
- **YouTube公式RSS + HTMLフォールバック**: APIキー不要
- **アプリ内 iframe 再生**: 本家に飛ばない＝誘惑ゼロ、`rel=0` で関連動画も抑制
- **PWA**: スマホのホーム画面に追加するとネイティブアプリ風に起動
- **クライアント永続化**: 「あとで見る」と再生位置は localStorage に保存

## 環境変数

| 変数 | 必須 | 用途 |
|---|---|---|
| `YOUTUBE_API_KEY` | GitHub Actions 実行時は必須 | YouTube Data API v3 のキー。GitHub Actions の実行環境では公式RSS/HTMLが不安定になりやすいためAPI経由に固定 |

`YOUTUBE_API_KEY` 未設定時はローカル開発用に従来の RSS + HTML スクレイピング経路にフォールバック（住宅IPなら問題なく動く）。

## ローカルビルド

```bash
pip install -r requirements.txt
python build.py
# 生成物: docs/index.html, docs/static/*, docs/data.json
```

ローカルプレビュー:
```bash
python -m http.server -d docs 8765
# http://localhost:8765 を開く
```

API キー有りで動作確認:
```bash
YOUTUBE_API_KEY=AIza... python build.py
```

## デプロイ（自動）

`.github/workflows/refresh.yml` の GitHub Actions workflow が 15 分ごと、または手動実行で以下を実行:

```
python -m pip install -r requirements.txt
python build.py
# workflow内では docs/data.json に動画が1件以上あることも検証
git add docs/ data/video_meta.json
git diff --cached --quiet || git commit -m "auto: refresh feeds"
git push
```

### GitHub Actions に必要な設定

1. **`YOUTUBE_API_KEY` repository secret**: GitHub の `Settings > Secrets and variables > Actions > Repository secrets` に追加
   - 取得方法: https://console.cloud.google.com/ → "YouTube Data API v3" を有効化 → 認証情報 → APIキー作成
2. **Workflow permissions**: GitHub の `Settings > Actions > General > Workflow permissions` で `Read and write permissions` を許可

`YOUTUBE_API_KEY` が未設定の場合、workflow は RSS/HTML 経路へフォールバックせず明示的に失敗する。これにより、GitHub Actions 上で「成功に見えるが動画が更新されない」状態を避ける。

GitHub Pages の Source は `main` branch / `/docs` folder に設定済み。

公開URL: https://kamonegi-sbkt.github.io/youtube-viewer/

手動更新したい場合は GitHub の `Actions > Refresh YouTube Viewer > Run workflow` から実行する。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `build.py` | RSS取得→Jinja2レンダリング→docs/出力 |
| `rss_fetcher.py` | YouTube RSS取得 + HTMLスクレイピング fallback |
| `channels.py` | 表示するチャンネル定義 |
| `templates/index.html` | メイン画面テンプレート |
| `static/app.js` | iframe再生・あとで見る・再生位置保存 |
| `static/style.css` | ダークテーマUI |
| `static/manifest.json` | PWAマニフェスト |
| `data/video_meta.json` | 動画 duration の永続キャッシュ（GitHub Actions が更新） |

## 詳細

設計の詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。
