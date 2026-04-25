# Voice2Text 実装ログ / Tech Reference

## 現在の実装方針

- 仕様書に従い、`frontend` は `React + Vite + Tailwind CSS`、`backend` は `FastAPI + WebSocket + Moonshine` で構成する。
- 重い実行資産はリポジトリ外に逃がす前提で設計する。
  - モデル: `%LOCALAPPDATA%\\Voice2Text\\models`
  - Ollama: `%LOCALAPPDATA%\\ollama\\models`
  - Ollama logs: `%LOCALAPPDATA%\\ollama\\logs`
  - 仮想環境: `%LOCALAPPDATA%\\Voice2Text\\backend-venv`
  - 一時録音: `%LOCALAPPDATA%\\Voice2Text\\temp_recordings`
- OneDrive 配下にはソースコード、設定、軽量な永続データのみを置く。
- Ollama モデルやログを `LLM\\models` / `LLM\\logs` に置く運用は禁止する。

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


## 2026/04/19_16:09

結論

主因はフロント側です。App.tsx (line 376) の初期化 useEffect が再実行ループに入っており、実ログでも Maximum update depth exceeded が大量発生し、backend 側には /api/settings /api/meta /api/sessions が各約1300回飛んでいます。
その結果、cleanup で App.tsx (line 384) の teardownAudio() / closeSocket() が走り、録音開始直後の WebSocket を自分で切って Connecting のまま止まる可能性が高いです。

原因一覧

確定: 初期化 effect の無限再実行
App.tsx (line 376) で useEffectEvent 由来の関数を依存配列に入れており、bootstrapApplication() が回り続けています。証拠は tmp-f2.err.log (line 1) の Maximum update depth exceeded と tmp-b2.log (line 1) の異常な API 連打です。
対策: bootstrap 用 effect を mount 時1回に限定し、useEffectEvent を dependency array に入れない。

高確度推定: 上記 loop の cleanup が録音開始を破壊
同じ effect の cleanup が teardownAudio() と closeSocket() を呼ぶため、録音開始中でも再レンダーで socket/audio が閉じられます。started を受ける前に切れると Connecting から進みません。
対策: unmount cleanup と bootstrap effect を分離し、録音中 teardown は stop / error / unmount のみに限定する。

確定: 画面の Failed to fetch は「録音失敗そのもの」ではなく bootstrap 系 fetch 失敗文言
Failed to fetch は App.tsx (line 213) の bootstrapApplication() など fetch 系 catch でそのまま error に入る文言です。録音開始本体の失敗は別文言 (WebSocket connection failed., Backend closed..., timeout) です。
対策: bootstrapError と recordingError を分離し、UI に「どの処理が失敗したか」を明示する。

確定: 起動プロセスの二重化 / port 競合がある
tmp-backend.err.log に WinError 10048、tmp-frontend.err.log に Port 5173 is already in use が出ています。さらに 8000 用の python -m uvicorn が別 Python で二重に存在していました。引き継ぎメモの注意点とも一致します。
対策: 8000/5173 は毎回1プロセスだけにし、起動前に stale uvicorn / vite を確実に kill、PID と command line を確認する。

確定: backend 側に「切断時の例外ログ」が残り、真因を見えにくくしている
main.py (line 92) の WebSocket 処理は、クライアント側が急に閉じると Cannot call "receive" once a disconnect message has been received. がログに出ています。これは主因ではないですが、診断を難しくします。
対策: client disconnect を正常系として握りつぶし、不要な stack trace を出さない。

否定できたもの: Moonshine backend 自体が起動不能、モデル未配置、API 全滅
GET /api/health は ok、GET /api/meta も正常、モデルも %LOCALAPPDATA%\\Voice2Text\\models に存在し、WebSocket へ直接 start_session を送ると {"type":"started"...} が返りました。live_session.py (line 123) の backend 本体は少なくとも今回の環境では動いています。
対策: backend 本体より先に frontend lifecycle と起動経路を直すべきです。

対策の優先順

App.tsx (line 376) の bootstrap effect を見直し、mount-only 化する。
cleanup から teardownAudio() / closeSocket() を外し、録音セッション破壊を防ぐ。
error state を用途別に分離し、Failed to fetch が録音失敗に見えないようにする。
run-dev.bat / run-backend.bat の前後で 8000 と 5173 の実 PID を確認し、古い process を残さない。
backend の disconnect 例外ログを静かにして、次回の切り分けをしやすくする。
