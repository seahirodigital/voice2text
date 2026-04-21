# Voice2Text

Voice2Text は、Moonshine を使ってローカルで音声をリアルタイム文字起こしし、必要に応じてローカル LLM で文字起こし結果を整形するアプリです。

音声認識の生テキストは保持したまま、右隣の `LLM Refined` 列に整形後テキストを表示します。

## 構成

- Frontend: React + Vite + Tailwind CSS + Framer Motion
- Backend: FastAPI + WebSocket + `moonshine-voice`
- Speech-to-text: Moonshine
- Local LLM runtime: Ollama
- Local LLM models:
  - `gemma4:e2b`
  - `gemma4:e4b`
- Moonshine models: `%LOCALAPPDATA%\Voice2Text\models`
- Recordings: `%LOCALAPPDATA%\Voice2Text\temp_recordings`
- Ollama models: `LLM\models`
- Ollama logs: `LLM\logs`

## 起動

```bat
start.bat
```

`start.bat` は次を行います。

1. Ollama の Windows スタートアップ登録を無効化します。
2. `LLM\scripts\start-ollama.ps1` で Ollama を起動します。
3. Backend を `http://127.0.0.1:8000` で起動します。
4. Frontend を `http://127.0.0.1:5173` で起動します。

Ollama は Windows 起動時に常駐させません。Voice2Text 起動時だけ動かす方針です。

## セットアップ

```bat
setup.bat
```

Ollama/Gemma4 は導入済みです。モデル一覧確認:

```powershell
%LOCALAPPDATA%\Programs\Ollama\ollama.exe list
```

期待されるモデル:

```text
gemma4:e2b
gemma4:e4b
```

## LLM 整形仕様

設定は [config.json](./config.json) の `llm` にあります。

```json
{
  "enabled": true,
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "model": "gemma4:e2b",
  "contextLines": 3,
  "debounceMs": 1200,
  "completeOnly": false
}
```

- `enabled`: LLM 整形の ON/OFF
- `model`: `gemma4:e2b` または `gemma4:e4b`
- `contextLines`: 何行分の文脈を LLM に渡すか
- `debounceMs`: 文字起こし更新後、整形開始まで待つ時間
- `completeOnly`: Moonshine が完了扱いにした行だけ整形するか

Frontend の Settings からも、モデル、文脈行数、debounce、完了行のみ、ON/OFF を切り替えられます。

## WebSocket の流れ

1. Frontend がマイク音声を WebSocket で Backend に送信します。
2. Backend の `LiveTranscriptionSession` が Moonshine に音声を渡します。
3. Moonshine の行イベントを `TranscriptSegment` として Frontend に送ります。
4. LLM が有効な場合、Backend が Ollama に非同期で整形依頼します。
5. LLM 結果は `llm_refinement_started` / `llm_refinement_updated` / `llm_refinement_error` として Frontend に送られます。
6. Frontend は元の `Transcript Text` を残し、右隣の `LLM Refined` に整形結果を表示します。

Moonshine の処理を止めないよう、LLM 整形は非同期キューで実行します。新しい文字起こし更新が来た場合、古い LLM 結果は破棄されます。

## 検証済み

- Ollama 0.21.0 インストール済み
- `gemma4:e2b` pull 済み
- `gemma4:e4b` pull 済み
- Ollama API `http://127.0.0.1:11434/api/version` 応答確認済み
- `gemma4:e2b` / `gemma4:e4b` の日本語整形 API 応答確認済み
- `npm.cmd run build` 成功
- `python -m compileall app` 成功
- Backend health check 成功
- Frontend HTTP 応答成功

## うまくいかなかったことと解決

### README と config.json の文字化け/破損

`README.md` に文字化けがあり、`config.json` は `tempRecordingsRoot` の引用符が壊れて JSON として読めない状態でした。

解決:

- `README.md` を UTF-8 の日本語仕様書として再作成しました。
- `config.json` を valid JSON に修復しました。
- 録音先を `%LOCALAPPDATA%\Voice2Text\temp_recordings` に戻しました。

### Ollama が Norton にブロックされた

winget 経由のインストール中に Norton が `powershell.exe` / `cmd` を危険として検知しました。

解決:

- 公式 winget パッケージ `Ollama.Ollama` からインストールしました。
- インストーラーハッシュ検証が成功したことを確認しました。
- Windows スタートアップ常駐は使わず、Voice2Text 起動時だけ Ollama を起動する方針に変更しました。

### Ollama が Windows スタートアップに登録された

Ollama インストール後、`Ollama.lnk` が Windows スタートアップフォルダに作成されました。

解決:

- スタートアップショートカットを削除しました。
- `LLM\scripts\disable-ollama-startup.ps1` を作成しました。
- `start.bat` 起動時にもスタートアップ登録を無効化するようにしました。

### Ollama 起動が不安定だった

初回起動時に GPU/runner 検出後、Ollama が落ちることがありました。

解決:

- `OLLAMA_LLM_LIBRARY=cpu` を設定し、CPU ライブラリ固定で起動するようにしました。
- `LLM\scripts\start-ollama.ps1` で `OLLAMA_MODELS` と `OLLAMA_HOST` を明示して起動するようにしました。

### `ollama` コマンドが PATH で見つからなかった

インストール後も、この作業環境では `ollama` が PATH 上で見つからないことがありました。

解決:

- 実行時は `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` を直接参照しました。
- `start-ollama.ps1` でも一般的なインストール先を探索するようにしました。

### 日本語 API テストで文字化けした

PowerShell から直接日本語 JSON を投げた際、`?` に化けることがありました。

解決:

- API 検証では Unicode escape を使って日本語入力を送信しました。
- 実アプリでは JSON 通信なので、通常の UI 経由ではこの回避は不要です。

### Gemma4 が thinking だけ返した

初回 API テストで `message.content` が空になり、`thinking` 側だけ返ることがありました。

解決:

- Ollama `/api/chat` 呼び出しに `think: false` を付けました。
- Backend の `OllamaClient` でも `think: false` を明示しています。

### pytest が一部失敗した

`pytest` は 4 件通過しましたが、2 件は `tmp_path` 用ディレクトリの ACL 権限で失敗しました。

解決/対応:

- コード構文確認として `python -m compileall app` は成功しています。
- Frontend build は成功しています。
- pytest が残した一時ディレクトリは権限で削除できなかったため、Git には入らないよう `.gitignore` に追加しました。

## 主要ファイル

- [config.json](./config.json): アプリ設定
- [start.bat](./start.bat): Voice2Text 起動
- [LLM/llm-development-plan.md](./LLM/llm-development-plan.md): LLM 導入計画と進捗
- [LLM/scripts/start-ollama.ps1](./LLM/scripts/start-ollama.ps1): Ollama 起動
- [LLM/scripts/disable-ollama-startup.ps1](./LLM/scripts/disable-ollama-startup.ps1): Ollama スタートアップ無効化
- [backend/app/services/live_session.py](./backend/app/services/live_session.py): Moonshine と LLM 整形の統合
- [backend/app/services/ollama_client.py](./backend/app/services/ollama_client.py): Ollama API クライアント
- [frontend/src/App.tsx](./frontend/src/App.tsx): UI と WebSocket 表示

## 注意

- `LLM\models` と `LLM\logs` は Git 管理対象外です。
- `gemma4:e2b` は軽め、`gemma4:e4b` は重めですが精度比較用に導入しています。
- Ollama が起動していなくても、Moonshine の生文字起こし自体は継続できる設計です。
