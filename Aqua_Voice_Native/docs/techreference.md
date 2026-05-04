# Aqua Voice Native 技術リファレンス

## 対象

このドキュメントは、`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native` に作成したAqua Voiceネイティブ版の技術引き継ぎです。

実行計画は次にあります。

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/nativeapps_plan.md`

## 既存版との関係

既存のブラウザ版は次に残します。

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice`

ネイティブ版は次に独立して作成します。

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native`

既存版はテスト用として残すため、ネイティブ版から既存版のファイルは変更しません。

## 主要ファイル

- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/aqua_voice_native_app.py`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/requirements.txt`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/start_mac.command`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/start_windows.bat`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/README.md`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/.gitignore`

## 技術構成

- UI: `PySide6`
- 録音: `sounddevice`
- グローバルショートカット: `pynput`
- HTTPクライアント: `httpx`
- 音声認識: Groq audio transcriptions API
- LLM整形: Groq chat completions API
- macOS貼り付け: `pbcopy`、`osascript`、`System Events`
- Windows貼り付け: `ctypes`、`clip`、`Ctrl+V`

## 設計方針

ブラウザ版 `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py` から、次の処理を必要分コピーして再利用しています。

- `AudioRecorder` 相当の録音処理
- `GroqClient` 相当の音声認識とLLM整形
- `HotkeyMonitor` 相当のグローバルショートカット
- `AutoPaste` 相当の自動貼り付け
- 設定保存と辞書置換

ブラウザUIとローカルHTTPサーバーは使わず、`PySide6` のネイティブUIから直接コントローラーを操作します。

## ネイティブUI

ネイティブUIは画面上部に表示します。

表示内容:

- ステータス
- 貼り付け先アプリ
- APIキー状態
- 入力レベル
- 音声認識レイテンシ
- LLMレイテンシ
- 音声認識結果
- LLM整形結果

操作:

- 録音開始
- 停止して貼り付け
- ロック録音
- 再貼り付け
- クリア
- 設定
- 終了

## 自動貼り付け

録音開始時に前面アプリを記憶し、整形後にそのアプリへ戻して貼り付けます。

ネイティブUI自身が前面の場合は、Aqua Voice Native自身を貼り付け先として記憶せず、直前の非Aqua Voice Nativeアプリを維持します。

macOSではbundle identifier、Windowsではウィンドウハンドルを優先して対象を識別します。

## 設定保存

設定保存先:

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/aqua_voice_native_config.json`

保存する主な項目:

- Groq APIキー
- 音声認識モデル
- LLMモデル
- 言語
- サンプルレート
- 送信間隔
- ショートカットキー
- 自動貼り付けON/OFF
- 辞書設定

## 検証コマンド

構文チェック:

```bash
PYTHONPYCACHEPREFIX=/private/tmp/aqua_voice_native_pycache python3 -m py_compile /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/aqua_voice_native_app.py
```

エンコーディング確認:

```bash
file /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice_Native/aqua_voice_native_app.py
```

## 既知の注意点

- `PySide6` は初回インストールに時間がかかります。
- macOSではマイク、アクセシビリティ、入力監視の権限が必要です。
- WindowsではOSの前面ウィンドウ制御により、対象アプリを前面化できない場合があります。その場合もクリップボードには整形済みテキストが入ります。
