# YouTube Viewer — iPhone 15 Pro Max UX調査 & 改善レポート

調査・実装: Claude Opus 4.8 / 対象本番: https://kamonegi-sbkt-youtube-viewer.hf.space
日付: 2026-06-08 / 反映コミット: `feat(ux): iPhone向けに未完成だった4導線を補完し、旧GitHub Pages遺物を整理`

---

## 1. 調査方法

iPhone 15 Pro Max の実機相当条件（**WebKit エンジン + ビューポート 430×932**、Safari=WebKitのため）で本番環境を操作し、**ソースを見ずに純粋なユーザー体験**として全導線を評価した。新着フィード → 動画再生 → PiP/全画面 → あとで見る → 履歴 → チャンネル絞り込み → 再読み込み を一通り通過。

## 2. 評価サマリ — このアプリは「よく作り込まれている」

Codex製だが完成度は高く、以下はすべて良好に動作していた:

| 観点 | 状態 |
|---|---|
| セーフエリア / Dynamic Island 対応 | ✅ `.topbar` が `padding-top: calc(10px + env(safe-area-inset-top))`、channel-filter / body下端 / PiP も対応済み |
| 再生位置の復元 + サムネ進捗バー | ✅ 実装済み（5秒ごと保存・95%で消去） |
| PiP（小窓）⇔ 全画面 切替 | ✅ 実装済み |
| ブックマーク（トグル + 「あとで N」バッジ） | ✅ アクセシブル（aria-pressed） |
| 空状態 / ローディング / エラー表示 | ✅ あり |
| レスポンシブ（430pxで1カラム, 481/769/1200pxで2/3/4列） | ✅ 一貫 |

> 当初「key.txtがGit漏洩」「新着が2カラムで窮屈」と見えたが、`git ls-files` と実測グリッド（`grid-template-columns: 398px` = 1カラム）で**いずれも誤りと確認・撤回**した。key.txt はGit追跡外でどのコードからも読まれない孤立ファイル（＝漏洩なし）。

## 3. 見つかった「作りかけ / 欠落していた体験」と改善（A〜D）

| | 課題（調査で判明） | 改善内容 | 本番検証 |
|---|---|---|---|
| **A** | `ytv_hidden`（隠す）と除外フィルタは実装済みだが、**隠すためのUI導線が存在しなかった**（唯一「あとで」解除時に自動hiddenのみ） | 新着カード左上に「興味なし」×ボタンを追加。5秒間「元に戻す」トースト付き | ✅ ×で即除去 → トースト「…を非表示にしました｜元に戻す」表示 → undoで復活（cards復元）を本番確認 |
| **B** | 再読み込みが `location.replace(?reload=…)` による**フルページ再読込**（白フラッシュ・スクロール位置リセット・再初期化）。pull-to-refreshなし | トップバー再読込を `/api/v1/feed` の**in-place再fetch**化（fetchFeed再利用）。`scrollY<=0`+下方向ドラッグ限定の pull-to-refresh も追加 | ✅ 再読込後も JSグローバル変数とスクロール位置600pxが保持＝フル再読込なしを本番確認。通常スクロール非破壊も確認。**プルの物理スワイプはヘッドレスWebKitで合成不可（`new Touch`不可）のため、最終タッチ確認のみ実機推奨** |
| **C** | 履歴は保持しているが、**新着で視聴済み動画を区別する表示がなかった** | 履歴にある動画をサムネ半透明（opacity .5）＋左下「✓視聴済み」緑バッジで区別（既存watchHistory再利用） | ✅ 視聴済みカードでバッジ＋半透明表示、duration/進捗バーと非衝突を本番確認 |
| **D** | プレーヤーに**動画タイトル・チャンネル名が出ず**、再生中の文脈が分からなかった | `openPlayer` を `meta` 受け取りに変更し、全画面時に動画下へタイトル(2行)＋チャンネル名を表示（PiP時は非表示） | ✅ 再生時に「第136回…」＋「両学長 リベラルアーツ大学」表示を本番確認 |

実装は `front/src/main.tsx` / `front/src/styles.css` に集約、**新規ライブラリ追加なし**。`npm run build`（型チェック）・`vitest`・`unittest` 全グリーン。

## 4. カレントディレクトリ整理

| 対象 | 判定 | 対応 |
|---|---|---|
| 旧GitHub Pagesパイプライン `build.py` / `templates/` / `static/` / `docs/` | React+FastAPI on HF Space 移行で**未使用の遺物**（deploy-space.yml も元々デプロイ対象外） | **Git削除**（5,300行超を除去）。`api/main.py` の docs フォールバックは明示的404へ。`channels.py` docstring更新。deploy-space.yml の不要exclude整理 |
| アイコン/manifest の3重複（docs/static, ルートstatic） | 上記削除で**自動解消**。正＝`front/public/static/`（→ビルドで `/static`） | — |
| `key.txt`（平文APIキー / Git追跡外 / どこからも未参照） | ユーザー指定で**残す** | 変更なし |
| `data/*.png`(22枚 ~33MB) / `__pycache__/` / `.playwright-mcp/` / `.playwright-cli/` | すべてgitignore済みの**ローカルディスク汚れ** | ローカル削除（約40MB解放）。`data/` は feed.json / video_meta.json のみに |

## 5. 本番デプロイ & 最終確認

- main へ push → GitHub Actions `deploy-space.yml` 成功（29s）→ HF Space 再ビルド → 新バンドル `index-BJnC62rl.js` 配信を確認。
- `/api/v1/health` = `{"status":"ok"}`、トップ初期ロードで**アプリ起因のコンソールエラー0**（再生中のYouTube広告CORSは無害・既存）。
- A / C / D / B(ソフト再読込) を本番 iPhone 15 Pro Max 相当で動作確認済み。

## 6. 残課題 / 今後の提案（未実装）

- **pull-to-refresh の物理スワイプ最終確認**: 実機 iPhone で1回タッチ確認推奨（ロジックは投入済み）。
- **ローディングのスケルトン化**: 現状スピナーのみ（許容範囲）。体感をさらに上げるならカードスケルトン。
- **履歴/あとでからの個別削除UI**: 現状あとでは解除時に自動hidden、履歴は明示削除なし。
