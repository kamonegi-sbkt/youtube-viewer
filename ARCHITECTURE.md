# youtube_viewer アーキテクチャ仕様書

このプロジェクトは、複数YouTubeチャンネルの新着動画を1画面で追うための個人用PWAである。現在の主構成は **FastAPI + React/TypeScript/Vite + Docker + Hugging Face Space**。

## 1. 全体像

- **表示**: React SPA
- **API**: FastAPI
- **定期更新**: GitHub Actions
- **配信**: Hugging Face Docker Space
- **動画本体**: 保存しない。YouTube iframe playerでストリーミング再生する
- **ユーザー状態**: localStorageに保存し、DB/API保存はしない

## 2. ディレクトリ構成

```text
youtube_viewer/
├── api/                         # FastAPI app, routers, schemas, SPA配信
├── services/                    # feed保存・更新などのドメイン処理
├── front/                       # React + TypeScript + Vite
├── scripts/refresh_feed.py      # GitHub Actions用feed更新CLI
├── tests/                       # Python API/service tests
├── data/
│   ├── feed.json                # APIが読む最新feed
│   └── video_meta.json          # duration等の永続キャッシュ
├── rss_fetcher.py               # YouTube API/RSS/HTML取得
├── channels.py                  # チャンネル定義
├── Dockerfile
└── .github/workflows/
```

旧GitHub Pages用の `docs/`, `templates/`, `static/`, `build.py` は移行互換のため残している。主経路は `front/dist` と `api/`。

## 3. データフロー

```text
[GitHub Actions refresh.yml]
  └ YOUTUBE_API_KEY secretを確認
  └ python scripts/refresh_feed.py
       ├ rss_fetcher.refresh_all()
       ├ rss_fetcher.get_videos()
       ├ rss_fetcher.enrich_for_display()
       └ data/feed.json と data/video_meta.json を更新
  └ 変更があればcommit/push

[Hugging Face Docker Space]
  └ uvicorn api.main:app
       ├ GET /api/v1/health
       ├ GET /api/v1/feed -> data/feed.json
       └ React SPA -> front/dist

[Browser]
  └ React UI
       ├ /api/v1/feed を取得
       ├ YouTube iframe playerで再生
       └ localStorageに個人状態を保存
```

## 4. API

- `GET /api/v1/health`
  - 稼働確認用。
- `GET /api/v1/feed`
  - `data/feed.json` を読み、動画一覧と生成時刻を返す。

APIは動画ファイル、秘密値、ローカル実ファイルパスを返さない。

## 5. localStorage方針

今回のユーザー状態はDB化しない。保存キーは既存互換を維持する。

```text
ytv_watch_later      あとで見る
ytv_hidden           新着から隠す動画
ytv_resume           再生位置
ytv_history          再生履歴
ytv_channel_filter   チャンネル絞り込み
```

localStorageは「ブラウザ + プロファイル + origin」単位で保存される。端末間同期、サーバーバックアップ、複数ユーザー共有は提供しない。APIキー、認証トークン、秘密情報は置かない。

## 6. フロントエンド

ReactはAPIレスポンスと公開URLのみを見る。主なUI機能:

- 新着、あとで見る、履歴のタブ
- チャンネル絞り込み
- ブックマーク
- YouTube iframe再生
- 再生位置保存とサムネイル進捗バー
- モバイル向けレスポンシブ表示

CSSは `front/src/styles.css` に集約する。PWA icon/manifestは `front/public/static/` に置く。

## 7. デプロイ

`deploy-space.yml` はpushまたは手動実行で以下を行う。

1. backend依存インストール
2. Python tests
3. Node依存インストール
4. frontend tests
5. frontend build
6. Hugging Face Spaceへ同期

必要なGitHub Secrets:

- `HF_TOKEN`
- `HF_SPACE_REPO_ID`

`refresh.yml` は15分ごとにfeedを更新する。必要なGitHub Secret:

- `YOUTUBE_API_KEY`

## 8. 検証

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests
cd front
npm run test
npm run build
cd ..
.\.venv\Scripts\python.exe run.py
```

UI変更後はブラウザでPC幅とiPhone相当幅を確認し、localStorageに保存したあとリロードして状態が残ることを確認する。
