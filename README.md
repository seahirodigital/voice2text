# Voice2Text

Voice2Text は、Moonshine を使ってローカルで音声を文字起こしし、その出力をローカル LLM で整形するアプリです。
Moonshine の生の文字起こしは `TRANSCRIPT` 列に残し、LLM 整形後の文章は右隣の `LLM Refined` 列に表示します。

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

`start.bat` は次を実行します。

1. Ollama の Windows スタートアップ登録を無効化します。
2. `LLM\scripts\start-ollama.ps1` で Ollama を起動します。
3. Backend を `http://127.0.0.1:8000` で起動します。
4. Frontend を `http://127.0.0.1:5173` で起動します。

Ollama は Windows 起動時に常駐させず、Voice2Text を起動した時だけ動かす方針です。

## セットアップ

```bat
setup.bat
```

Ollama/Gemma4 の確認:

```powershell
%LOCALAPPDATA%\Programs\Ollama\ollama.exe list
```

期待されるモデル:

```text
gemma4:e2b
gemma4:e4b
```

## LLM 整形仕様候補

| 案 | 仕様 | 精度 | 遅延 | 挙動 |
|---|---|---:|---:|---|
| A | 1行ずつ即時リファイン | 低 | 最小 | 今の `TRANSCRIPT` を1行単位で整形する |
| B | 過去N行 + 現在行でリファイン | 中 | 小 | 上から順に処理し、前の文脈だけ使う |
| C | 過去N行 + 現在行 + 次M行でリファイン | 高 | 中 | 少し待って前後文脈を見てから整形する |
| D | 直近K行を何度も再リファイン | 高 | 中 | 新しい音声が来るたびに直近の整形結果を更新する |
| E | 録音終了後に全文リファイン | 最高 | 大 | リアルタイムではなく最後に全体を整形する |

採用仕様は **案C** です。

## 案Cの現在仕様

`gemma4:e2b` を既定モデルにして、上から順に1本の LLM キューで処理します。
対象行だけを返すように Ollama へ指示し、前後の行は文脈としてだけ使います。

例:

```text
対象行: 10行目
LLMに渡す文脈:
- 前の3行: 7,8,9
- 対象行: 10
- 次の2行: 11,12
出力:
- 10行目のLLM整形結果だけ
```

現在の既定値:

| 設定 | config key | 初期値 | 意味 |
|---|---|---:|---|
| 使用モデル | `model` | `gemma4:e2b` | E2Bを既定にし、E4Bへ切替可能 |
| 前文脈行数 | `contextBeforeLines` | `3` | 対象行の前に何行見るか |
| 後文脈行数 | `contextAfterLines` | `2` | 対象行の後に何行待つか |
| 最大待機時間 | `maxWaitMs` | `3000` | 後続行が来ない場合に待つ上限 |
| 安定待ち | `debounceMs` | `1200` | Moonshine更新直後にすぐLLMへ投げないための待機 |
| 完了行のみ | `completeOnly` | `false` | Moonshineが完了扱いにした行だけ処理するか |
| 出力列 | UI | `LLM Refined` | `TRANSCRIPT` 右隣に表示 |
| 処理順 | backend | 上から順 | 並列処理せず順序を保証 |

旧設定の `contextLines` は互換性のため残しています。案Cでは `contextBeforeLines` と `contextAfterLines` を使います。

## LLM検証結果の記録欄

今後、E2B/E4B や文脈行数を変えた結果はここへ追記します。

| 日付 | モデル | 前文脈 | 後文脈 | 最大待機 | 結果 | メモ |
|---|---|---:|---:|---:|---|---|
| 2026-04-21 | `gemma4:e2b` | 3 | 2 | 3000ms | 構文/ビルド検証済み、実音声検証待ち | 案Cの初期仕様 |
| 2026-04-21 | `gemma4:e4b` | 3 | 2 | 3000ms | 未検証 | 比較用 |

## WebSocket の流れ

1. Frontend がマイク音声を WebSocket で Backend に送信します。
2. Backend の `LiveTranscriptionSession` が Moonshine に音声を渡します。
3. Moonshine の行イベントを `TranscriptSegment` として Frontend に送ります。
4. LLM が有効な場合、Backend は対象行を LLM キューへ追加します。
5. LLM キューは上から順に、前後文脈が揃うか `maxWaitMs` に達するまで待ちます。
6. Ollama に対象行と前後文脈を送り、対象行だけの整形結果を受け取ります。
7. Frontend は生の文字起こしを残し、右隣の `LLM Refined` に整形結果を表示します。

Moonshine の処理を止めないように、LLM 整形は非同期で行います。

## 検証済み

- Ollama 0.21.0 インストール済み
- `gemma4:e2b` pull 済み
- `gemma4:e4b` pull 済み
- Ollama API `http://127.0.0.1:11434/api/version` 応答確認済み
- `gemma4:e2b` / `gemma4:e4b` の日本語整形 API 応答確認済み
- `npm.cmd run build` 成功
- `python -m compileall app` 成功
- Backend health check 成功
- Frontend HTTP 応答確認済み

## うまくいかなかったことと解決

### README と config.json の文字化け/破損

`README.md` に文字化けがあり、`config.json` は `tempRecordingsRoot` の引用符が壊れて JSON として読めない状態でした。

解決:

- `README.md` を UTF-8 の日本語仕様書として再作成しました。
- `config.json` を valid JSON に修復しました。
- 録音先を `%LOCALAPPDATA%\Voice2Text\temp_recordings` に戻しました。

### Norton が Ollama / PowerShell をブロックした

winget 経由のインストール中に Norton が `powershell.exe` / `cmd` を脅威として検知しました。

解決:

- 公式 winget パッケージ `Ollama.Ollama` からインストールしました。
- インストーラーハッシュ検証が成功したことを確認しました。
- Windows スタートアップ常駐は使わず、Voice2Text 起動時だけ Ollama を起動する方針にしました。

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
- `LLM\scripts\start-ollama.ps1` で `OLLAMA_MODELS` と `OLLAMA_HOST` を明示して起動します。

### `ollama` コマンドが PATH で見つからなかった

インストール後も、この作業環境では `ollama` が PATH 上で見つからないことがありました。

解決:

- 実行時は `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` を直接参照します。
- `start-ollama.ps1` でも一般的なインストール先を探索します。

### 日本語 API テストで文字化けした

PowerShell から直接日本語 JSON を投げた際、`?` に化けることがありました。

解決:

- API 検証では Unicode escape を使って日本語入力を送信しました。
- 実アプリでは JSON 通信なので、通常の UI 経由ではこの回避は不要です。

### Gemma4 が thinking 側に返すことがあった

初回 API テストで `message.content` が空になり、`thinking` 側に返ることがありました。

解決:

- Ollama `/api/chat` 呼び出しに `think: false` を付けました。
- Backend の `OllamaClient` でも `think: false` を明示しています。

### pytest が一部失敗した

`pytest` は一部、`tmp_path` 用ディレクトリの ACL 権限で失敗しました。

対応:

- コード構文確認として `python -m compileall app` は成功しています。
- Frontend build は成功しています。
- 権限付き一時ディレクトリは Git に入らないよう `.gitignore` に追加しました。

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
