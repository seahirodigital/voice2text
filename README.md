# Voice2Text

Voice2Text は、Moonshine を使ってローカルで音声を文字起こしし、その出力をローカル LLM で整形するアプリです。
リアルタイム中は Moonshine の文字起こしを `TRANSCRIPT` 列に表示し、`gemma4:e2b` のリアルタイム整形結果を右隣の `LLM Refined` 列に表示します。
録音停止後に `文字起こし整形` を実行した場合は、整形済みの時系列本文で `TRANSCRIPT` 列を上書きし、`LLM Refined` 列は上書きしません。

## 構成

- Frontend: React + Vite + Tailwind CSS + Framer Motion
- Backend: FastAPI + WebSocket + `moonshine-voice`
- Speech-to-text: Moonshine
- Local LLM runtime: Ollama
- Local LLM models:
  - `gemma4:e2b`
  - `gemma4:e4b`
- Moonshine models: `%LOCALAPPDATA%\Voice2Text\models`
- Faster Whisper models: `%LOCALAPPDATA%\Voice2Text\faster_whisper_models`
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

## 最終仕様

### 既定設定

- Moonshine は `base` を既定モデルにします。
- Local LLM は既定で `ON` にします。
- リアルタイム整形モデルは `gemma4:e2b` にします。
- `文字起こし整形` の一括文字起こしエンジンは `Faster Whisper` を既定にします。
- Faster Whisper の既定モデルは `base` です。
- Faster Whisper のモデル保存先は `%LOCALAPPDATA%\Voice2Text\faster_whisper_models` で、OneDrive配下には置きません。
- ミニッツ要約モデルは `gemma4:e4b` にします。

### リアルタイム表示

- `TRANSCRIPT` 列は Moonshine の時系列文字起こしを表示します。
- `LLM Refined` 列はリアルタイム中の `gemma4:e2b` 整形結果だけを表示します。
- `LLM Refined` 列は表示/非表示を切り替えられます。

### 文字起こし整形ボタン

`文字起こし整形` は録音停止後の保存済み音源に対して実行します。

1. 既定では Faster Whisper `base` で録音ファイルを一括文字起こしします。
   設定画面の `Batch Engine` で Moonshine へ切り替えできます。
2. `gemma4:e2b` で時系列を保ったまま文字起こし本文を整形します。
3. 整形後の本文を `TRANSCRIPT` 列の各時刻行へ上書きします。
4. `LLM Refined` 列は上書きしません。以前のリアルタイムE2B結果を残します。
5. 過去の誤実装で `LLM Refined` に `[00:00:00] ...` 形式が入っていた場合は、一括整形の再実行時にその誤ったバッチ由来表示だけを消します。
6. 最終的な整形済み `TRANSCRIPT` を入力として、`gemma4:e4b` でミニッツを要約生成します。
7. ミニッツ本文のあとに `Timestamped Clean Transcript` として時系列付き整形本文を追加します。

### ミニッツ

ミニッツは要約・要点・詳細・アクション項目を残します。
時系列データはミニッツ本文を置き換えるものではなく、ミニッツの末尾に追加される補助データです。

### 文字起こし整形エンジン比較

設定画面で `Batch Engine` と `Batch Model` を選択できます。

| Engine | 既定/候補 | 用途 |
|---|---|---|
| Faster Whisper | `tiny`, `base`, `small`, `medium`, `large-v3` | 録音停止後の一括文字起こし。既定エンジン |
| Moonshine | `tiny`, `base`, `small-streaming`, `medium-streaming` | 既存Moonshineとの比較用 |

## LLM 整形仕様候補

| 案 | 仕様 | 精度 | 遅延 | 挙動 |
|---|---|---:|---:|---|
| A | 1行ずつ即時リファイン | 低 | 最小 | 今の `TRANSCRIPT` を1行単位で整形する |
| B | 過去N行 + 現在行でリファイン | 中 | 小 | 上から順に処理し、前の文脈だけ使う |
| C | 過去N行 + 現在行 + 次M行でリファイン | 高 | 中 | 少し待って前後文脈を見てから整形する |
| D | 直近K行を何度も再リファイン | 高 | 中 | 新しい音声が来るたびに直近の整形結果を更新する |
| E | 録音終了後に全文リファイン | 最高 | 大 | リアルタイムではなく最後に全体を整形する |

最終仕様は、リアルタイム表示は **案C**、録音停止後の一括文字起こし整形は **案E** を採用します。
案A-D/Eの比較表は試行錯誤の記録であり、現在の最終仕様そのものではありません。

## 案Cの現在仕様

`gemma4:e2b` を既定モデルにして、上から順に1本の LLM キューで処理します。
1行ずつ整形結果を出すのではなく、現在行から後続N行までを1つの対象ブロックとして扱い、文章らしい1つの段落に整形します。

例:

```text
ブロック先頭: 10行目
LLMに渡す文脈:
- 前の3行: 7,8,9
- 対象ブロック: 10,11,12
出力:
- 10-12行をまとめた1つの文章ブロック
```

現在の既定値:

| 設定 | config key | 初期値 | 意味 |
|---|---|---:|---|
| 使用モデル | `model` | `gemma4:e2b` | E2Bを既定にし、E4Bへ切替可能 |
| 前文脈行数 | `contextBeforeLines` | `3` | 対象行の前に何行見るか |
| ブロック後続行数 | `contextAfterLines` | `3` | 先頭行に続けて何行を同じ文章ブロックに含めるか |
| 最大待機時間 | `maxWaitMs` | `5000` | 後続行が来ない場合に待つ上限 |
| 安定待ち | `debounceMs` | `5000` | Moonshine更新直後にすぐLLMへ投げないための待機 |
| 完了行のみ | `completeOnly` | `true` | Moonshineが完了扱いにした行だけ処理するか |
| 出力列 | UI | `LLM Refined` | ブロック先頭行に文章ブロックを表示 |
| 処理順 | backend | 上から順 | 並列処理せず順序を保証 |

旧設定の `contextLines` は互換性のため残しています。案Cでは `contextBeforeLines` を前文脈、`contextAfterLines` をブロック後続行数として使います。

## LLM検証結果の記録欄

今後、E2B/E4B や文脈行数を変えた結果はここへ追記します。

| 日付 | モデル | 前文脈 | 後文脈 | 最大待機 | 結果 | メモ |
|---|---|---:|---:|---:|---|---|
| 2026-04-21 | `gemma4:e2b` | 3 | 3 | 5000ms | 構文/ビルド検証済み、実音声検証待ち | Moonshine優先の低頻度推論仕様 |
| 2026-04-21 | `gemma4:e4b` | 3 | 3 | 5000ms | 未検証 | 比較用 |

## WebSocket の流れ

1. Frontend がマイク音声を WebSocket で Backend に送信します。
2. Backend の `LiveTranscriptionSession` が Moonshine に音声を渡します。
3. Moonshine の行イベントを `TranscriptSegment` として Frontend に送ります。
4. LLM が有効な場合、Backend は対象行を LLM キューへ追加します。
5. LLM キューは上から順に、対象ブロックの後続行が揃うか `maxWaitMs` に達するまで待ちます。
6. Ollama に前文脈と対象ブロックを送り、対象ブロック全体を1つの段落として受け取ります。
7. Frontend は生の文字起こしを残し、右隣の `LLM Refined` に文章ブロックを表示します。
8. Stop 時は後続行待ちを終了し、残っている最後の行まで強制的に整形してから保存します。

Moonshine の処理を止めないように、LLM 整形は非同期で行います。

## ミニッツ生成

保存済みの録音音源に対して、リアルタイムとは別に一括文字起こしとMarkdown整形を実行できます。

- 録音完了後、フッターの時間表示の左側に `文字起こし整形` ボタンを表示します。
- サイドパネルの右クリックメニューから、選択済みの複数録音に対して順番に実行できます。
- 複数実行時は新しい録音順で、まだミニッツ生成されていないものだけを対象にします。
- 一括文字起こし整形後の `TRANSCRIPT` を入力にして、`gemma4:e4b` でミニッツ要約を生成します。
- ミニッツ本文のあとに `Timestamped Clean Transcript` を追加します。
- ヘッダーのコピーアイコン左隣に `リアルタイム` / `ミニッツ` の切替タブがあります。
- `ミニッツ` はMarkdown編集とプレビューを横並びで表示します。
- ミニッツ編集内容はセッションに保存されます。
- `リアルタイム` / `ミニッツ` タブは青い小型タブで表示します。
- `文字起こし整形` ボタンは青枠・青文字で表示します。

## 重複防止

リアルタイムLLM整形では、過去の生文字起こしをそのまま再投入せず、直前の整形済みブロックを `PREVIOUS_REFINED` として文脈に渡します。
さらに各ブロックに `llmBlockId` を付け、出力後に近い文を比較して重複文を削ります。

## リアルタイム負荷対策

- リアルタイム整形モデルは `gemma4:e2b` を既定にします。
- `completeOnly=true` とし、Moonshineが完了扱いにした行だけLLMキューへ送ります。
- `debounceMs=5000` / `maxWaitMs=5000` にして、短時間の更新ごとに推論しないようにします。
- 既存の未処理ブロックに含まれる行は追加でキュー投入しません。
- `start.bat` はBackendを `AboveNormal` 優先度で起動し、Ollamaは `BelowNormal` 優先度で起動します。

## ダウンロード形式

ダウンロードされるテキストは2段階です。

1. 整形済み文章: ミニッツがあればミニッツ、なければリアルタイムLLM整形ブロック
2. 時系列データ: 現在の `TRANSCRIPT` 列。`文字起こし整形` 後は、時刻ごとに整形済み本文が入った最終TRANSCRIPT

## 一括文字起こし後の上書き

保存済み音源に対して `文字起こし整形` を実行すると、録音ファイルをMoonshineで一括再解析します。
その結果を最終版として、リアルタイム側の `TRANSCRIPT` 時系列データに上書きします。
`LLM Refined` には上書きしません。`LLM Refined` はリアルタイム中に `gemma4:e2b` が作った整形結果を表示する列として扱います。
一括整形で作る時系列付きの正しい本文は、`TRANSCRIPT` の各時刻行に入れます。

ミニッツの `Timestamped Clean Transcript` は、既存のミニッツ要約のあとに追加される時系列付き本文です。
ミニッツ要約を置き換えるものではありません。

## LLM Refined 表示切替

リアルタイム表示では、`LLM Refined` 見出しの横にトグルを置きます。
トグルをOFFにすると `LLM Refined` 列を隠し、`TRANSCRIPT` を広く表示できます。
非表示中は `Transcript Text` 側の小さな `LLM` ボタンから再表示できます。

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
