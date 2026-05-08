# youtube_viewer アーキテクチャ仕様書

このドキュメントは `youtube_viewer` の設計を記録する。**「フロント込み + 15分〜1日に数回更新するコンテンツビューア」の参照テンプレート**として使うことを想定している。

> 過去の Flask + HuggingFace Spaces 構成と Claude Code routines 構成は廃止し、GitHub Actions + GitHub Pages の完全静的構成に移行した（2026-05）。

---

## 1. アプリの全体像

- **種別**: スケジュール駆動の静的サイトジェネレータ + クライアントサイド再生プレイヤー
- **用途**: 複数YouTubeチャンネルの新着動画を1画面に集約して視聴するPWA
- **特徴**:
  - 24/7 サーバー不要（GitHub Pages のみで配信）
  - GitHub Actions が 15 分ごとに YouTube Data API v3 で取得 → HTML を再生成 → git push
  - 認証なし・公開
  - PWA 対応（ホーム画面追加・スタンドアロン表示）
  - 「あとで見る」「再生位置」は localStorage に永続化（サーバー側状態ゼロ）

---

## 2. ディレクトリ構成

```
youtube_viewer/
├── .gitignore
├── README.md
├── ARCHITECTURE.md
├── requirements.txt              # feedparser, requests, Jinja2
├── .github/workflows/refresh.yml # 15分ごとの自動更新 workflow
├── build.py                      # GitHub Actions が呼ぶ静的サイトビルダー
├── rss_fetcher.py                # データ取得（RSS + HTMLスクレイプ fallback）
├── channels.py                   # 購読対象のマスタデータ
├── templates/
│   ├── base.html                 # 共通レイアウト
│   └── index.html                # メイン画面（グリッド + プレイヤー）
├── static/
│   ├── style.css                 # ダークテーマ + レスポンシブグリッド
│   ├── app.js                    # iframe再生・あとで見る・再生位置保存
│   ├── manifest.json             # PWA設定
│   └── icon-192.png / icon-512.png
├── data/
│   └── video_meta.json           # 動画 duration の永続キャッシュ（GitHub Actions が更新）
└── docs/                         # GitHub Pages 配信ターゲット（GitHub Actions が再生成）
    ├── .nojekyll
    ├── index.html
    ├── data.json
    └── static/
```

---

## 3. データフロー

```
[GitHub Actions] (cron */15 * * * *)
  └ checkout
  └ YOUTUBE_API_KEY secret が未設定なら失敗
  └ python build.py
       ├ rss_fetcher.refresh_all()           # 全チャンネル取得（API経由なら待機なし）
       ├ get_videos + enrich_for_display     # マージ・ソート・表示用整形
       ├ Jinja2 で templates/index.html を render → docs/index.html
       ├ shutil.copytree static/ → docs/static/
       ├ json.dump videos → docs/data.json
       └ data/video_meta.json 更新（duration 永続キャッシュ）
  └ git add docs/ data/video_meta.json
  └ 差分があれば commit && push、なければ正常終了

[GitHub Pages] main / docs/
  └ ユーザーアクセス時に docs/index.html を即配信
```

---

## 4. データ取得（rss_fetcher.py）

`YOUTUBE_API_KEY` 環境変数が設定されているかどうかで取得経路が切り替わる。

### API 経路（`YOUTUBE_API_KEY` 設定時、GitHub Actions 用）

YouTube Data API v3 を使用。データセンターIPは公式RSS/HTMLが 403 で弾かれるため、クラウド実行時は必須。

- **`playlistItems.list`**: 各チャンネルの uploads プレイリスト（`UU{id_without_UC}`）から最新15件
- **`videos.list`**: `contentDetails`（duration ISO8601）と `snippet`（liveBroadcastContent）をバッチ50件で取得
- **quota**: 11ch × 1 + 4 batches × 1 ≈ 15 unit/refresh、15分ごと運用なら約1440 unit/日。無料枠 10000/日内に収まる想定。
- **リクエスト間隔**: 0 秒（API は IP ブロックされない）

### RSS + HTML 経路（`YOUTUBE_API_KEY` 未設定時、ローカル開発用）

- **2段フォールバック**: RSS (feedparser) → 失敗時は HTML の `ytInitialData` から JSON抽出
- **指数バックオフ**: 2s, 4s, 8s, 16s, 32s（最大5回）
- **ブラウザ風ヘッダー**: User-Agent, Referer, Sec-Fetch-*
- **日本語相対時刻パース**: 「3日前」→ datetime
- **チャンネル間 2 秒インターバル**: IP ブロック回避

### 共通

- **duration の永続キャッシュ**: `data/video_meta.json`（append-only、リポにコミット）
- **マージ & ソート**: 全チャンネル分を published_dt 降順で統合、`#shorts` 含むタイトルは除外

---

## 5. ビルド（build.py）

シンプルな同期スクリプト。`os.chdir` で自身の場所を cwd に固定するので GitHub Actions の cwd に依存しない。

Flask との互換性のため `url_for('static', filename='...')` の Jinja グローバルを shim として提供:

```python
def _url_for(endpoint, **kwargs):
    if endpoint == "static":
        return f"static/{kwargs['filename']}"
    return "#"
env.globals["url_for"] = _url_for
```

これでテンプレート側はほぼ無修正のまま静的化できる。

---

## 6. フロントエンド設計

### 6.1 テンプレート継承

```
base.html (HTMLスケルトン + head + <body>)
  └─ index.html (メイン画面)
```

`base.html` には: `<meta name="viewport">`、PWA manifest リンク、`apple-mobile-web-app-capable`、共通CSSロード。

### 6.2 CSS（ダーク + レスポンシブ）

CSS変数 `--bg`, `--bg-gradient`, `--accent` で印象をコントロール。`grid-template-columns` をブレイクポイントごとに 1/2/3/4 列に切り替え。`prefers-reduced-motion` 対応あり。

### 6.3 JS（app.js）

- カード全件にクリックリスナー → YouTube IFrame Player API でオーバーレイ再生
- iOS Safari の autoplay 制約を user gesture 内で `loadVideoById` することで突破
- 「あとで見る」「再生位置」は localStorage に保存
- 終盤95%以上 or duration-10s で「観終わり」扱い → サムネ進捗バー消去 + 新着から非表示
- タブ切替・visibilitychange・pagehide で自動保存（モバイル Safari の beforeunload 不発対策）

### 6.4 PWA（manifest.json）

```json
{
  "start_url": "../",
  "scope": "../",
  "icons": [{"src": "icon-192.png", "sizes": "192x192"}]
}
```

manifest.json は `/<repo>/static/manifest.json` に配置されるので、相対 `../` で `/<repo>/` を指す。サブパスデプロイでもカスタムドメインのルートデプロイでも動く。

---

## 7. デプロイ

### 7.1 GitHub Pages 設定

- リポ Settings → Pages → Source: `main` branch / `/docs` folder
- `docs/.nojekyll` で Jekyll 処理を無効化（先頭 `_` 始まりのファイル等を弾かれないため）

### 7.2 GitHub Actions 設定

`.github/workflows/refresh.yml`:

```
name: Refresh YouTube Viewer
cron: */15 * * * *   (15分ごと)
steps:
  python -m pip install -r requirements.txt
  python build.py
  python -c "docs/data.json に動画が1件以上あることを検証"
  git add docs/ data/video_meta.json
  git diff --cached --quiet || git commit -m "auto: refresh feeds"
  git push
```

**重要**: `git add data/` ではなく `data/video_meta.json` のみを stage する（`data/*.png` のスクリーンショット類を巻き込まないため）。`.gitignore` 側でも `data/*` を除外して `!data/video_meta.json` のみ許可済み。

### 7.3 GitHub Actions 環境の前提条件

GitHub Actions 経由で動作させるには以下 2 つが必須：

1. **`YOUTUBE_API_KEY` repository secret**: GitHub の `Settings > Secrets and variables > Actions > Repository secrets` に設定する。未設定時は workflow 冒頭で明示的に失敗させる。
2. **GitHub Actions の `contents: write` 権限**: workflow 側で `permissions: contents: write` を宣言し、リポ設定側でも `Read and write permissions` を許可する。

どちらかが欠けると workflow は失敗する。Secret 未設定時は RSS/HTML フォールバックを使わず、空更新や古い表示を「成功」に見せない。

公開URL: https://kamonegi-sbkt.github.io/youtube-viewer/

手動更新は GitHub の `Actions > Refresh YouTube Viewer > Run workflow` から実行する。

---

## 8. 採用しなかった構成と理由

| 案 | 不採用理由 |
|---|---|
| Flask 維持 + routine で更新ジョブだけ切り出す | HF Spaces のスリープ・スレッド死亡問題が残る。表示と更新の同期が複雑化 |
| Claude Code routine で定期ビルド | GitHub Actions のほうがSecret、実行ログ、手動再実行、commit権限をGitHub内で完結できる |
| クライアント側で data.json を fetch する SPA | 初回表示が遅くなる。既存テンプレートが SSR 前提（`{% for v in videos %}`）なので JS シェル化はメリットなし |
| Cloudflare Workers Cron + KV | サーバーレスだが課金・運用学習コストが増える |

---

## 9. このアプリをコピーして新規アプリを作るとき

### 再利用率の高いファイル（コピーだけで済む）

- `build.py` ← データ取得とテンプレート名を差し替えるだけ
- `static/style.css` ← カラー変数だけ調整
- `static/manifest.json` ← name/icon 差し替え
- `templates/base.html` ← ほぼそのまま
- `.gitignore` ← そのまま

### 新規に書く部分

- 目的別のデータ取得層（`rss_fetcher.py` 相当）
- `templates/index.html` のカード構造
- `static/app.js` のインタラクション

### 適用条件

このテンプレートは **「15分〜1日に数回更新で十分なコンテンツビューア」向け**。リアルタイム性が必要・ユーザー入力をサーバー側で受ける必要がある場合は別アーキテクチャ（Flask / Cloudflare Workers / etc.）を検討。
