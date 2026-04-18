---
title: My YouTube Viewer
emoji: 📺
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: true
---

# My YouTube Viewer

自分で登録したチャンネルの新着動画だけを、時系列で表示するシンプルなビューア。YouTube本家のアルゴリズム推薦・ショート・急上昇から距離を置いて、ノイズなしでキャッチアップするためのアプリ。

## 特徴

- **11チャンネル固定**：`channels.py` に書いた11チャンネルの新着だけを表示（サブスク自動同期しない＝意図的に小さく保つ）
- **YouTube公式RSS**：APIキー不要、feedparser でパース
- **URL合い言葉トークン**：`?k=<APP_SECRET>` で初回アクセス、以降 cookie で素通り（30日）
- **アプリ内 iframe 再生**：本家に飛ばない＝誘惑ゼロ、`rel=0` で関連動画も抑制
- **PWA**：スマホのホーム画面に追加するとネイティブアプリ風に起動

## 環境変数

| 変数 | 用途 |
|---|---|
| `APP_SECRET` | URLトークン＆cookie署名キー。32文字以上のランダム推奨 |

## ローカル起動

```bash
pip install -r requirements.txt
APP_SECRET=test python app.py
# http://localhost:7860/?k=test を開く
```
