# Voice2Text

Voice2Text は、Windows ローカル環境で音声を文字起こしし、必要に応じて LLM で整形し、録音ごとの履歴とミニッツを残せるアプリです。  
Frontend は `React + Vite`、Backend は `FastAPI + WebSocket`、文字起こしは `Moonshine` / `Groq Whisper`、整形と要約は `Ollama` または `Groq` を使います。

## このアプリでできること

- マイク入力をリアルタイムで文字起こしする
- 話者ラベルを付けてタイムライン表示する
- タイムラインの各行をその場で編集する
- リアルタイム文字起こしの横に `LLM Refined` 列を表示して整形結果を確認する
- 録音停止後に `文字起こし整形` を実行して、保存済み音声を一括再文字起こしする
- 一括整形後の本文から Markdown 形式のミニッツを生成・編集する
- 用途テンプレートを切り替えて、議事録・日記・セミナー記録などの出力方針を変える
- Groq 利用時は API 制限の残量を UI 上で確認する

## 技術構成

- Frontend: `React`, `Vite`, `Tailwind CSS`, `Framer Motion`
- Backend: `FastAPI`, `WebSocket`
- リアルタイム文字起こし: `Moonshine` または `Groq Whisper`
- バッチ文字起こし: `Faster Whisper`, `Moonshine`, `Groq Whisper`
- LLM 整形 / ミニッツ要約: `Ollama (gemma4)` または `Groq`
- 対応話者数: 1〜3 人

## 保存場所と絶対制限事項

- OneDrive 配下にはソースコード、設定ファイル、スクリプト、軽量テキストだけを置きます。
- 重い実体データを OneDrive 配下へ置いてはいけません。
- 特に `LLM\models`、`LLM\logs`、録音データ、モデルキャッシュ、仮想環境、`node_modules` を OneDrive 配下へ置く運用は禁止です。
- Ollama モデルとログは必ず `%LOCALAPPDATA%\ollama\...` に置きます。
- Moonshine / Faster Whisper モデル、録音データ、セッションデータも `%LOCALAPPDATA%\Voice2Text\...` 配下を使います。
- 旧運用で `C:\Users\<user>\OneDrive\開発\Voice2Text\LLM\models` のような場所に重いデータが残っていたら、ローカルへ移動してから使います。

### 現在の既定パス

- 設定ファイル: `%USERPROFILE%\OneDrive\開発\Voice2Text\config.json`
- リポジトリ: `%USERPROFILE%\OneDrive\開発\Voice2Text`
- Moonshine モデル: `%LOCALAPPDATA%\Voice2Text\models`
- Faster Whisper モデル: `%LOCALAPPDATA%\Voice2Text\faster_whisper_models`
- セッションデータ: `%LOCALAPPDATA%\Voice2Text\data`
- セッション一覧: `%LOCALAPPDATA%\Voice2Text\data\sessions`
- 録音データ: `%LOCALAPPDATA%\Voice2Text\temp_recordings`
- Ollama モデル: `%LOCALAPPDATA%\ollama\models`
- Ollama ログ: `%LOCALAPPDATA%\ollama\logs`
- Backend 仮想環境: `%LOCALAPPDATA%\Voice2Text\backend-venv`

## セットアップ

```bat
setup.bat
```

`setup.bat` は次を行います。

1. `%LOCALAPPDATA%\Voice2Text\backend-venv` に Python 仮想環境を作る
2. `backend/requirements.txt` をインストールする
3. `frontend` の `npm` 依存をインストールする
4. Moonshine モデルを `%LOCALAPPDATA%\Voice2Text\models` に用意する
5. Faster Whisper モデルを `%LOCALAPPDATA%\Voice2Text\faster_whisper_models` に用意する

### Ollama

Ollama 本体は別途 Windows にインストールしておきます。  
Voice2Text は `start.bat` 実行時に Ollama を起動し、Windows 起動時の常駐は使いません。
Voice2Text 以外から Ollama を起動する場合も、`OLLAMA_MODELS` は `%LOCALAPPDATA%\ollama\models` を指すようにします。

モデル確認例:

```powershell
%LOCALAPPDATA%\Programs\Ollama\ollama.exe list
```

想定モデル:

```text
gemma4:e2b
gemma4:e4b
```

### Groq API キー

Groq を使う場合の API キーは `config.json` に直接書かず、Git 管理外ファイルへ置きます。  
推奨配置先:

- `LLM/.env/.env`
- `LLM/.env`
- `.env`

書式:

```text
GROQ_API_KEY=gsk_...
```

## 起動

```bat
start.bat
```

`start.bat` は次を行います。

1. Ollama の Windows スタートアップ登録を無効化する
2. `LLM/scripts/start-ollama.ps1` で Ollama を起動する
3. Backend を `http://127.0.0.1:8000` で起動する
4. Frontend を `http://127.0.0.1:5173` で起動する

起動後の確認先:

- Frontend: `http://127.0.0.1:5173`
- Backend health: `http://127.0.0.1:8000/api/health`
- Ollama: `http://127.0.0.1:11434/api/version`

## 使い方

### 1. 録音を始める

1. アプリを起動する
2. 設定パネルで必要なら言語、文字起こしエンジン、LLM 設定、用途テンプレートを調整する
3. `New` を押して録音を開始する

### 2. リアルタイムで確認する

- 画面中央に波形が表示される
- タイムラインに文字起こし行が順次追加される
- 各行はその場で編集できる
- `LLM Refined` が有効なら、右列に整形結果が表示される
- `LLM Refined` 列は表示 / 非表示を切り替えられる

### 3. 録音を止める

- `Pause` で一時停止
- `Resume` で再開
- `Stop` で録音終了と保存

### 4. 一括文字起こし整形を実行する

録音停止後、保存済みセッションに対して `文字起こし整形` を実行できます。

- フッターから現在セッションへ実行できる
- サイドバーの右クリックメニューから複数録音へ順番に実行できる

一括処理で行うこと:

1. 保存済み音声を選択中のバッチ文字起こしエンジンで再処理する
2. 整形済み本文を `TRANSCRIPT` 列へ反映する
3. LLM でミニッツ本文を生成する
4. ミニッツ末尾へ `Timestamped Clean Transcript` を追加する

### 5. ミニッツを編集する

- 上部タブで `リアルタイム` と `ミニッツ` を切り替える
- `ミニッツ` タブでは Markdown 編集とプレビューを横並びで確認できる
- 編集内容はセッションに保存される

### 6. 用途テンプレートを使う

- 設定から用途テンプレートを切り替える
- 用途テンプレートは追加、編集、削除、並び替え、インポート、エクスポートができる
- 現在の用途テンプレートは、LLM 整形とミニッツ生成の `systemPrompt` に反映される

## 現在の既定設定

これはリポジトリ同梱の `config.json` の既定値です。

### 文字起こし

- 言語: `ja`
- リアルタイム文字起こしエンジン: `groq`
- リアルタイム Groq モデル: `whisper-large-v3-turbo`
- モデルプリセット: `base`
- 話者数: `3`
- 更新間隔: `5000ms`

### バッチ文字起こし

- バッチ文字起こしエンジン: `groq`
- バッチ Groq モデル: `whisper-large-v3-turbo`
- バッチ Moonshine プリセット: `base`
- Faster Whisper モデル: `base`

### LLM

- LLM 有効: `true`
- LLM プロバイダー: `ollama`
- LLM モデル: `gemma4:e4b`
- ミニッツ要約モデル: `gemma4:e4b`
- Groq reasoning effort: `medium`
- Groq service tier: `on_demand`
- 文脈前行数: `3`
- 文脈後行数: `3`
- debounce: `5000ms`
- max wait: `5000ms`
- complete only: `false`
- アクティブ用途テンプレート: `meeting-minutes`

## 機能仕様

### リアルタイム文字起こし

- リアルタイム文字起こしエンジンは `Moonshine` と `Groq` を切り替え可能
- タイムラインは時刻、話者、本文、LLM 整形列を中心に構成される
- 話者ラベルは最大 3 人まで扱う
- 文字起こし行は編集できる
- 全文コピーできる

### 話者ラベル

- Moonshine 由来の話者情報があれば優先する
- 取得できない場合は特徴量ベースのフォールバックで `話者A/B/C` を付与する
- 後から表示名を変更できる

### LLM 整形

- プロバイダーは `Ollama` と `Groq` に対応
- リアルタイム整形結果は `LLM Refined` 列へ表示する
- リアルタイム整形は非同期で行い、文字起こし本体を止めない
- 直前の整形済みブロックと対象ブロックを使って、重複を減らす

### 一括文字起こし整形

- バッチ文字起こしエンジンは `Faster Whisper`、`Moonshine`、`Groq` に対応
- 一括処理後は `TRANSCRIPT` 列を最終版本文へ更新する
- `LLM Refined` 列はリアルタイム中の整形表示列として扱い、一括整形の結果で上書きしない

### ミニッツ

- ミニッツは Markdown 形式で保存される
- 一括文字起こし整形の後段で生成する
- 出力テンプレートは用途テンプレートに従う
- `Timestamped Clean Transcript` を末尾に付与する

### Groq 使用量表示

- Groq API 呼び出し時、レスポンスヘッダーから制限情報を取得する
- UI 右上から使用量ポップオーバーを開ける
- 残りリクエスト、残りトークン、リセットまでの時間を確認できる

## データの流れ

### リアルタイム

1. Frontend がマイク音声を WebSocket で Backend に送る
2. Backend の `LiveTranscriptionSession` が文字起こしエンジンへ渡す
3. 文字起こし結果を `TranscriptSegment` として Frontend へ返す
4. LLM が有効なら、Backend が別キューで整形する
5. Frontend は `TRANSCRIPT` と `LLM Refined` を描画する

### 一括処理

1. 保存済みセッションの録音ファイルを読む
2. 選択中のバッチ文字起こしエンジンで全文を再文字起こしする
3. 整形済み本文を `TRANSCRIPT` に反映する
4. LLM でミニッツを生成する
5. セッション JSON に保存する

## 設定項目の要点

### リアルタイム

- 言語
- リアルタイム文字起こしエンジン
- リアルタイムモデル
- 話者数
- 更新間隔

### バッチ処理

- バッチ文字起こしエンジン
- Faster Whisper モデル
- Moonshine モデル
- Groq 文字起こしモデル
- ミニッツ生成時の用途テンプレート

### LLM

- 有効 / 無効
- プロバイダー
- モデル
- ミニッツ要約モデル
- 文脈行数
- 待機時間
- `completeOnly`

### Paths

- `modelsRoot`
- `dataRoot`
- `tempRecordingsRoot`
- `frontendDist`

### AI Providers

- OpenAI API キー
- Anthropic API キー
- Groq API キー
- プロバイダー別モデル

通常のローカル利用では、OpenAI / Anthropic は空欄でも問題ありません。

## 主要ファイル

- [config.json](./config.json): アプリ設定
- [start.bat](./start.bat): アプリ起動
- [setup.bat](./setup.bat): 初期セットアップ
- [LLM/scripts/start-ollama.ps1](./LLM/scripts/start-ollama.ps1): Ollama 起動
- [LLM/scripts/disable-ollama-startup.ps1](./LLM/scripts/disable-ollama-startup.ps1): Ollama スタートアップ無効化
- [spec.md](./spec.md): 仕様書
- [techreference.md](./techreference.md): 実装ログ
- [LLM/llm-development-plan.md](./LLM/llm-development-plan.md): LLM 導入メモ
- [backend/app/services/live_session.py](./backend/app/services/live_session.py): リアルタイム処理
- [backend/app/services/minutes_service.py](./backend/app/services/minutes_service.py): 一括文字起こしとミニッツ生成
- [backend/app/services/ollama_client.py](./backend/app/services/ollama_client.py): Ollama クライアント
- [backend/app/services/groq_client.py](./backend/app/services/groq_client.py): Groq クライアント
- [frontend/src/App.tsx](./frontend/src/App.tsx): UI 全体

## 検証済み

- Ollama 0.21.0 インストール済み
- `gemma4:e2b` pull 済み
- `gemma4:e4b` pull 済み
- Ollama API 応答確認済み
- 日本語整形 API 応答確認済み
- `npm.cmd run build` 成功
- `python -m compileall app` 成功
- Backend health check 成功
- Frontend HTTP 応答確認済み

## 注意

- `LLM\models` と `LLM\logs` を OneDrive 配下の実データ置き場として使ってはいけません。
- `gemma4:e2b` は軽め、`gemma4:e4b` は重めです。
- Ollama が起動していなくても、文字起こし自体は継続できる設計です。
- Groq キーは Git に入れず、`.env` 系の Git 管理外ファイルに置きます。

## 過去の試行錯誤とトラブル対応

### README / config の破損

- README が文字化けしていた時期があった
- `config.json` が壊れて JSON として読めなかった時期があった
- そのため README を UTF-8 で再構成し、`config.json` を修復した

### Ollama の常駐と起動まわり

- Ollama インストール直後に Windows スタートアップへ登録されることがあった
- `Ollama.lnk` を削除し、`disable-ollama-startup.ps1` を追加した
- `start.bat` から必要なときだけ Ollama を起動する運用にした
- GPU/runner 検出後に不安定になることがあり、`OLLAMA_LLM_LIBRARY=cpu` で固定した
- `ollama` が PATH で見つからない環境があり、既知のインストール先を探索するようにした

### OneDrive と重量データ

- Ollama モデルを OneDrive 配下に置くと容量と同期の面で不利だった
- そのため Ollama モデルとログを `%LOCALAPPDATA%\ollama\...` へ移した
- Moonshine / Faster Whisper / 録音データもローカル側へ寄せる方針に統一した

### 日本語と API テスト

- PowerShell から直接日本語 JSON を投げると文字化けすることがあった
- API テスト時は Unicode escape を使う対応を入れた
- Ollama が `thinking` 側へ返すことがあり、`think: false` を明示するようにした

### 起動競合と WebSocket

- backend と frontend の起動順で初回 `ECONNREFUSED` が出ることがあった
- 古い `uvicorn` や `vite` が残ると、ポート競合で起動に失敗した
- `run-dev` / `start` 系は既存プロセスを止め、health check 後に frontend を開く方針にした
- WebSocket の失敗時に `connecting` のまま見えることがあり、エラー表示とタイムアウトを強めた

### pytest と Windows ACL

- 一部の `pytest` が一時ディレクトリ権限で失敗することがあった
- そのため最低限の検証として `python -m compileall app` と frontend build を重視した

### フロント初期化ループ

- 初期化 effect の再実行ループで API が大量発行され、録音開始直後に WebSocket を自分で閉じる問題があった
- cleanup と bootstrap の責務を分け、録音中の teardown 条件を見直す必要があると整理した
