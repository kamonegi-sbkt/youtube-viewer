# My YouTube Viewer

自分で登録したチャンネルの新着動画だけを、時系列で表示するシンプルなビューア。YouTube本家のアルゴリズム推薦・ショート・急上昇から距離を置いて、ノイズなしでキャッチアップするためのアプリ。

## 構成

**Claude Code routines + GitHub Pages** の完全静的構成。

- **routine** が 4 時間ごとに RSS を取得 → `docs/index.html` を生成 → GitHub に push
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
| `YOUTUBE_API_KEY` | クラウド routine 実行時は必須 | YouTube Data API v3 のキー。データセンターIPは公式RSS/HTMLが 403 で弾かれるためAPI経由が必要 |

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

`/schedule` で作成した Claude Code routine が以下を実行:

```
cd youtube_viewer
pip install -r requirements.txt --quiet
python build.py
git add docs/ data/video_meta.json
git diff --cached --quiet || git commit -m "auto: refresh feeds"
git push
```

### routine 環境に必要な設定

1. **`YOUTUBE_API_KEY` 環境変数**: Anthropic Cloud の環境設定 or routine の prompt で渡す
   - 取得方法: https://console.cloud.google.com/ → "YouTube Data API v3" を有効化 → 認証情報 → APIキー作成
2. **GitHub への push 権限**: 以下のいずれか
   - Anthropic GitHub Integration に `kamonegi-sbkt/youtube-viewer` への `contents: write` 権限を付与
   - リポへの push 権限を持つ PAT (`repo` スコープ) を git credential として routine 環境に設定

GitHub Pages の Source は `main` branch / `/docs` folder に設定済み。

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
| `data/video_meta.json` | 動画 duration の永続キャッシュ（routine が更新） |

## 詳細

設計の詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。
