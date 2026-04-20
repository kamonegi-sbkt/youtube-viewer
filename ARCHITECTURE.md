# youtube_viewer アーキテクチャ & テンプレート仕様書

このドキュメントは `youtube_viewer` の設計を記録すると同時に、**今後の「フロント込みのWebアプリ」の参照テンプレート**として使われることを想定している。

---

## 1. アプリの全体像

- **種別**: Flask + Jinja2 による小〜中規模のデータキュレーションWebアプリ
- **用途**: 複数チャンネルのYouTube動画を1画面に集約して視聴するPWA
- **特徴**:
  - URLトークン + 署名Cookieによるシンプル認証
  - バックグラウンドスレッドで10分ごとの自動更新
  - YouTube RSS → HTMLスクレイピングのフォールバック機構
  - PWA対応（ホーム画面追加・スタンドアロン表示）
  - Docker化 + GitHub Actions で HuggingFace Spaces へ自動デプロイ

---

## 2. ディレクトリ構成

```
youtube_viewer/
├── .github/workflows/deploy.yml   # HF Spaces 自動デプロイ
├── .dockerignore
├── .gitignore
├── Dockerfile                      # gunicorn -w 1 --threads 8
├── README.md                       # HF Spacesメタデータ + 説明
├── requirements.txt                # flask, gunicorn, itsdangerous, requests, feedparser
├── app.py                          # Flaskエントリ、認証、ルーティング、BGスレッド
├── rss_fetcher.py                  # データ取得ロジック（RSS + HTMLスクレイプ）
├── cache.py                        # スレッドセーフ TTLCache
├── channels.py                     # 購読対象のマスターデータ
├── templates/
│   ├── base.html                   # 共通レイアウト（継承元）
│   ├── gate.html                   # 認証ゲート画面
│   └── index.html                  # メイン画面（グリッド + プレイヤー）
├── static/
│   ├── style.css                   # ダークテーマ + レスポンシブグリッド
│   ├── app.js                      # カードクリック → iframeオーバーレイ
│   ├── manifest.json               # PWA設定
│   └── icon-192.png / icon-512.png
└── data/                           # スクショ等、git対象外
```

---

## 3. バックエンド設計

### 3.1 認証（URLトークン + 署名Cookie）

```python
# app.py
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

APP_SECRET = os.environ["APP_SECRET"]
COOKIE_NAME = "yv_auth"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30日
signer = URLSafeTimedSerializer(APP_SECRET, salt="youtube-viewer-auth")

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
        COOKIE_NAME, token, max_age=COOKIE_MAX_AGE,
        httponly=True, secure=request.is_secure, samesite="Lax"
    )
    return resp
```

- ユーザーは `https://app/?k=<APP_SECRET>` でアクセス → トークン検証 → Cookie発行 → 以降Cookieだけで認証
- `secrets.compare_digest()` でタイミング攻撃対策
- Cookieは `httponly`, `secure`, `samesite=Lax`

### 3.2 ルーティング

| エンドポイント | 認証 | 役割 |
|---|---|---|
| `GET /?k=<token>` | 不要 | トークン検証 → Cookie発行 → `/` へリダイレクト |
| `GET /` | 要 | データ取得 → `index.html` |
| `GET /refresh` | 要 | バックグラウンドで手動リフレッシュ |
| `GET /logout` | 不要 | Cookie削除 → `gate.html` |
| `GET /healthz` | 不要 | ヘルスチェック |

### 3.3 バックグラウンド自動更新

```python
REFRESH_INTERVAL = 600  # 10分

def _refresh_loop():
    while True:
        _do_refresh()
        time.sleep(REFRESH_INTERVAL)

def _start_background_thread():
    # Flask reloaderの二重起動防止
    if os.environ.get("WERKZEUG_RUN_MAIN") is None:
        threading.Thread(target=_refresh_loop, daemon=True).start()
```

- `_refresh_lock` で同時実行防止
- 失敗したチャンネルは前回キャッシュを保持

### 3.4 データ取得（rss_fetcher.py）

- **2段フォールバック**: RSS (feedparser) → 失敗時は HTML の `ytInitialData` から JSON抽出
- **指数バックオフ**: 2s, 4s, 8s, 16s, 32s
- **ブラウザ風ヘッダー**: User-Agent, Referer, Sec-Fetch-* でブロック回避
- **日本語相対時刻パース**: 「3日前」→ datetime
- **マージ & ソート**: 全チャンネル分を published_dt 降順で統合

### 3.5 キャッシュ（cache.py）

```python
class TTLCache:
    def __init__(self, ttl_seconds: int = 900):
        self._ttl = ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_compute(self, key, compute):
        cached = self.get(key)
        if cached is not None:
            return cached
        value = compute()
        self.set(key, value)
        return value
```

- スレッドセーフ（`threading.Lock`）
- TTL経過で自動削除
- ワーカー単位のメモリキャッシュ（Redisなし）

---

## 4. フロントエンド設計

### 4.1 テンプレート継承

```
base.html (HTMLスケルトン + head + <body>)
  ├─ gate.html (認証前 / ログアウト画面)
  └─ index.html (認証後のメイン画面)
```

`base.html` には:
- `<meta name="viewport">`
- PWA manifest リンク
- `apple-mobile-web-app-capable`
- 共通CSSロード

### 4.2 CSS（ダーク + レスポンシブ）

```css
:root {
  --bg: #0a0a0b;
  --bg-gradient: radial-gradient(1200px 800px at 0% -10%,
                   rgba(99,102,241,0.08), transparent 60%),
                 radial-gradient(900px 700px at 100% 110%,
                   rgba(244,63,94,0.06), transparent 60%),
                 #0a0a0b;
  --accent: #6366f1;
}

.grid { display: grid; gap: 20px; grid-template-columns: 1fr; }
@media (min-width: 481px) and (max-width: 768px) {
  .grid { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 769px) { .grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 1200px) { .grid { grid-template-columns: repeat(4, 1fr); } }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; }
}
```

### 4.3 JS（app.js, 33行）

- カード全件にクリックリスナー登録
- `data-video-id` 取得 → iframe src 組立
- オーバーレイ表示中は `body.overflow: hidden` でスクロール禁止
- Escapeキーで閉じる

### 4.4 PWA（manifest.json）

```json
{
  "name": "My YouTube Viewer",
  "display": "standalone",
  "start_url": "/",
  "scope": "/",
  "background_color": "#0b0b0b",
  "icons": [{"src": "/static/icon-192.png", "sizes": "192x192"}]
}
```

---

## 5. インフラ & デプロイ

### 5.1 Dockerfile

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 7860
CMD ["gunicorn", "-b", "0.0.0.0:7860", "-w", "1", "--threads", "8",
     "--timeout", "120", "--access-logfile", "-", "app:app"]
```

- `-w 1 --threads 8`: I/O待機型アプリに最適（RSS取得は待ち時間が長い）
- ポート 7860（HuggingFace Spaces 標準）

### 5.2 環境変数

| 変数 | 役割 |
|---|---|
| `APP_SECRET` | URLトークン + Cookie署名（`secrets.token_urlsafe(32)` 推奨） |
| `PORT` | 起動ポート（デフォルト 7860） |

### 5.3 CI/CD

`.github/workflows/deploy.yml`:
- `push: branches: [main]` で自動起動
- HF Spaces へ `git push hf hf-deploy:main --force`
- Secrets: `HF_TOKEN`

---

## 6. 新規「フロント込みアプリ」を作るときの手順

### ステップ

1. **youtube_viewer をコピー** → プロジェクト名に変更
2. **app.py を修正**:
   - `SIGNER_SALT` / `COOKIE_NAME` をアプリ固有に
   - ルーティングを目的に合わせて書き換え
3. **データ取得層を差し替え**:
   - `rss_fetcher.py` → 自分のデータ取得ロジックに
   - `channels.py` → 対応するマスタデータに
4. **テンプレートを編集**:
   - `base.html` は基本そのまま
   - `index.html` のグリッド内容を置き換え
5. **CSS微調整**: カラー変数（`--accent`, `--bg-gradient`）だけ変えれば印象が変わる
6. **PWA**: `manifest.json` の `name`, `short_name`, icons を差し替え
7. **Dockerfile**: そのまま流用可
8. **CI/CD**: `.github/workflows/deploy.yml` の Space 名を書き換え

### 再利用率の高いファイル（コピーだけで済む）

- `cache.py` ← 100% そのまま
- `Dockerfile` ← 100% そのまま
- `.dockerignore` / `.gitignore` ← 100% そのまま
- `app.py` の認証・バックグラウンド更新部分 ← ほぼそのまま
- `static/style.css` のグリッド・ダークテーマ変数 ← カラー変更のみ
- `static/manifest.json` ← name/icon 変更のみ
- `templates/base.html` ← ほぼそのまま
- `.github/workflows/deploy.yml` ← Space名変更のみ

### 新規に書く部分

- 目的別のデータ取得ロジック
- `templates/index.html` の中身（グリッド内のカード構造）
- `static/app.js` のインタラクション（クリック時の挙動）

---

## 7. チェックリスト（新アプリ適用時）

**バックエンド**
- [ ] APP_SECRET 環境変数を `secrets.token_urlsafe(32)` で生成
- [ ] `SIGNER_SALT` / `COOKIE_NAME` をアプリ固有の値に変更
- [ ] `login_required` デコレータ を適用
- [ ] バックグラウンド更新の間隔（`REFRESH_INTERVAL`）をユースケースに合わせる
- [ ] `/healthz` を残す（ヘルスチェック用）

**フロントエンド**
- [ ] `base.html` テンプレート継承を維持
- [ ] レスポンシブグリッドの列数がコンテンツに合うか
- [ ] CSS変数（`--bg`, `--accent`）をブランドカラーに
- [ ] `prefers-reduced-motion` 対応を残す
- [ ] PWA manifest の name/icon を差し替え

**インフラ**
- [ ] Dockerfile のポート・ワーカー数を確認
- [ ] `.gitignore` で `.venv/`, `data/`, `__pycache__/` 除外
- [ ] GitHub Actions の Secrets に `HF_TOKEN`（または相当のトークン）
- [ ] requirements.txt のバージョン固定

**セキュリティ**
- [ ] Cookie `httponly=True`, `secure=request.is_secure`, `samesite="Lax"`
- [ ] URLトークン比較は `secrets.compare_digest()`
- [ ] APP_SECRET を git に含めない
- [ ] スレッド安全性（`threading.Lock`）

---

## 8. アーキテクチャの強み・弱み

### 強み
- シンプル（Flask + Jinja2 + 静的ファイル）
- 依存最小（5パッケージのみ）
- PWA対応でスマホでも快適
- Docker + CI/CD で1分デプロイ

### 弱み & スケール時の改善案
- キャッシュがワーカー単位 → Redis で共有
- データ取得が順次 → Celery / AsyncIO で並列化
- 10分ポーリング → WebSocket / SSE でリアルタイム化
- 認証が単一トークン → OAuth / 複数ユーザー対応
