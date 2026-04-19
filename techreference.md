# Voice2Text 実装ログ / Tech Reference

## 現在の実装方針

- 仕様書に従い、`frontend` は `React + Vite + Tailwind CSS`、`backend` は `FastAPI + WebSocket + Moonshine` で構成する。
- 重い実行資産はリポジトリ外に逃がす前提で設計する。
  - モデル: `%LOCALAPPDATA%\\Voice2Text\\models`
  - 仮想環境: `%LOCALAPPDATA%\\Voice2Text\\backend-venv`
  - 一時録音: `%LOCALAPPDATA%\\Voice2Text\\temp_recordings`
- OneDrive 配下にはソースコード、設定、軽量な永続データのみを置く。

## 初期計画

1. Moonshine の Python 実装でリアルタイム音声投入が成立するかを検証する。
2. FastAPI バックエンドの骨格を作る。
3. React フロントエンドを白基調の Apple 風 UI で構築する。
4. 録音、波形、WebSocket、タイムライン編集をつなぐ。
5. セットアップスクリプトと設定保存を追加する。

## 実施ログ

### 2026-04-19 初動

- `spec.md` は確認時点で更新されていた。初回確認時に空と判断したのは更新前状態を読んだため。
- `DESIGN_reference.md` は UTF-8 で読む必要があった。PowerShell の既定出力だと文字化けして見えることがある。
- Python 3.12 / Node 24 は利用可能。`npm` は PowerShell 実行ポリシーに引っかかるため `npm.cmd` を使う。
- `moonshine-voice 0.0.56` は Python 3.12 で導入可能。
- 日本語 (`ja`) で取得できる Moonshine モデルは確認時点で `tiny-ja` / `base-ja` で、英語のような streaming 系モデル指定はそのまま使えなかった。
- そのため Phase 1 のリアルタイム文字起こしは「小さい区切りで更新しつつ、確定行を高速反映する」方針にする。

### 2026-04-19 実装

- `backend` に `FastAPI + WebSocket + moonshine-voice` ベースのリアルタイム文字起こし API を実装した。
- 録音データは `%LOCALAPPDATA%\\Voice2Text\\temp_recordings`、モデルは `%LOCALAPPDATA%\\Voice2Text\\models` に保存するようにした。
- `config.json` はリポジトリ直下に置き、重いファイルだけローカルストレージ分離にした。
- `frontend` は `React + Vite + Tailwind CSS + Framer Motion` で白基調 UI を実装した。
- タイムラインは `[経過時間] | [話者ラベル] | [編集可能なテキスト]` の 3 列構成にした。
- 話者ラベルは Moonshine の speaker 情報を優先し、取れない場合は音響特徴ベースのフォールバックで `話者A/B/C` を割り当てる設計にした。
- `setup.bat` と `run-dev.bat` を追加し、別 PC でも起動しやすい形にした。

### 2026-04-19 検証

- `npm.cmd run build` は成功。
- `pytest backend/tests -q` は成功。
- `FastAPI TestClient` で `/api/health`, `/api/meta`, `/api/settings` の 200 応答を確認した。

## 苦戦したこと

- `spec.md` の初回確認で更新タイミングを見落とした。
- 日本語の Moonshine モデル選定で、英語向け streaming 系アーキテクチャを前提にすると失敗する。
- PowerShell では `&&` がそのまま使えず、Unix 風の連結でコマンドを書くと止まる。
- Pydantic の `snake_case` と API JSON の `camelCase` を混在させると、`Field(alias=...)` を入れ忘れた箇所がランタイムで落ちる。
- `fastapi.testclient` は `httpx` が別途必要。
- `rg --files frontend` をそのまま打つと `node_modules` まで拾ってノイズが大きい。

## 再発防止ノウハウ

- OneDrive 配下のファイルは、内容確認前に `Length` と `LastWriteTime` を毎回セットで確認する。
- 日本語 Markdown は PowerShell で読むときに `-Encoding UTF8` を明示する。
- 「空に見えた」だけで確定せず、絶対パスで再確認してから実装判断する。
- PowerShell では `npm` ではなく `npm.cmd` を使うと実行ポリシー問題を回避しやすい。
- Moonshine は言語ごとに利用可能なモデル構成が違う。先に `get_model_for_language()` で存在確認してからアーキテクチャを決める。
- PowerShell で複数コマンドを流すときは `&&` 前提で書かず、別実行に分ける。
- FastAPI の JSON 出力モデルは最初に `snake_case` / `camelCase` のルールを固定し、`Field(alias=...)` をまとめて定義する。
- テストで `TestClient` を使うなら `httpx` を最初から `requirements.txt` に入れる。
- `rg --files` でフロントエンドを見るときは `-g '!node_modules'` を付ける。

## 2026-04-19 追加調査

- `run-dev.bat` で frontend と backend を同時起動すると、frontend の初回 `/api/settings` `/api/meta` `/api/sessions` が backend より先に走って `ECONNREFUSED` になることがある。
- この初回失敗時、画面自体は表示されても `draftSettings` が `null` のまま残るため、`Start Recording` が「押せない」ように見える無反応状態になる。
- Windows 環境では `uvicorn --reload` が `WinError 10013` を出して不安定だったため、開発用起動は通常モードに寄せたほうが安全だった。
- `run-dev.bat` は backend の `/api/health` が 200 になるまで待ってから frontend を開くように修正した。
- frontend 側も初期ロード失敗時に自動リトライし、接続待ち中はボタンを `Waiting for Backend` にして、明示的な `Retry Connection` も出すようにした。
- Windows では古い `uvicorn app.main:app --port 8000` が残留すると、新しい backend が起動したつもりでも frontend が壊れた旧プロセスにつながることがある。`run-dev.bat` / `run-backend.bat` で対象 port の既存 Voice2Text backend を先に止める。
- WebSocket の開始失敗は、frontend 側で `connecting` のまま放置すると原因が見えなくなる。`onclose` で開始中断を `error` に落とし、backend 側も例外時に `error` payload を返す。
- Vite も旧 `node ... vite.js` が残ると、`run-dev` の新しい frontend 起動が裏で `Port 5173 is already in use` で落ちる。frontend も起動前に既存 Vite を止め、`127.0.0.1:5173` 固定で待ち合わせる。
- `run-dev.bat` は `start cmd /k ...` 連打より、`Start-Process` で backend/frontend をバックグラウンド起動し、`%LOCALAPPDATA%\Voice2Text\logs` にログを吐く形のほうが Windows では安定した。起動確認後に `http://127.0.0.1:5173/` を開く。
- API が相対パスなのに WebSocket だけ `127.0.0.1:8000` を直書きすると、`localhost` / `127.0.0.1` / dev proxy の差で詰まりやすい。frontend の WebSocket も current origin の `/ws/transcribe` に寄せて、Vite proxy に統一する。
- `connecting` の無限継続は、成功条件が見えないまま詰まる最悪パターン。録音開始には明示タイムアウトを置き、失敗時はログの場所まで含めて UI に出す。
