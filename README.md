---
title: YouTube Viewer
emoji: 📺
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# My YouTube Viewer

登録したYouTubeチャンネルの新着動画だけを、時系列で見るための個人用ビューア。動画本体は保存せず、YouTube iframe playerでストリーミング再生する。

## 構成

主構成は **FastAPI + React/TypeScript/Vite + Docker + Hugging Face Space**。

- GitHub Actionsが15分ごとにYouTube Data API v3で新着を取得し、`data/feed.json` を更新する。
- FastAPIがGitHub上の最新 `data/feed.json` を読み、`/api/v1/feed` で返す。Reactのビルド済みSPAも配信する。
- 「あとで見る」「再生位置」「履歴」「チャンネル絞り込み」はサーバーに保存せず、ブラウザのlocalStorageに保存する。
- Hugging Face Spaceの非永続ディスクにはユーザー状態を置かない。

## ローカル開発

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd front
npm install
npm run build
cd ..
.\.venv\Scripts\python.exe run.py
```

APIのみ確認:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests
.\.venv\Scripts\python.exe scripts\refresh_feed.py
```

フロント開発サーバー:

```powershell
cd front
npm run dev
```

Vite dev serverは `/api` を `http://127.0.0.1:8000` にproxyする。

## 環境変数 / Secrets

| 変数 | 読む場所 | 用途 |
|---|---|---|
| `YOUTUBE_API_KEY` | GitHub Actions refresh | YouTube Data API v3。Actions上では必須 |
| `HF_TOKEN` | GitHub Actions deploy | Hugging Face Spaceへ同期するトークン |
| `HF_SPACE_REPO_ID` | GitHub Actions deploy | 同期先Space repo。例: `owner/youtube-viewer` |

## データ保存

サーバー側:

- `data/feed.json`: 最新動画一覧。Actionsが更新し、FastAPIが読む。
- `data/video_meta.json`: 動画duration等の永続キャッシュ。

ブラウザ側localStorage:

- `ytv_watch_later`: あとで見る
- `ytv_hidden`: 新着から隠す動画
- `ytv_resume`: 再生位置
- `ytv_history`: 再生履歴
- `ytv_channel_filter`: チャンネル絞り込み

localStorageは「ブラウザ + プロファイル + origin」単位の保存なので、端末間同期やサーバーバックアップはしない。

## デプロイ

`deploy-space.yml` はアプリ本体のpushまたは手動実行で以下を行う。

1. Python依存をインストール
2. backend tests
3. frontend tests
4. frontend build
5. Hugging Face Spaceへ同期

`refresh.yml` は15分ごと、または手動実行で `data/feed.json` と `data/video_meta.json` を更新してcommit/pushする。このデータ更新だけではHugging Face Spaceを再デプロイしない。

## 主要ファイル

| パス | 役割 |
|---|---|
| `api/` | FastAPI app、routers、schemas、SPA配信 |
| `services/` | feed保存・更新などのドメイン境界 |
| `front/` | React + TypeScript + Vite UI |
| `scripts/refresh_feed.py` | Actions用feed更新CLI |
| `rss_fetcher.py` | YouTube API/RSS/HTML取得 |
| `channels.py` | 表示対象チャンネル定義 |
| `data/feed.json` | APIが返す最新feed |
| `data/video_meta.json` | duration等の永続キャッシュ |

詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。
