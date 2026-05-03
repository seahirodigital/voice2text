# Aqua Voice

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice` は、Groqを使った高速音声入力の体感確認用MVPです。

## 目的

話した内容を短い単位でGroq音声認識へ送り、Groq LLMで軽く整形し、現在カーソルがある場所へ自動貼り付けします。精度よりもレスポンスを優先し、まず「どれくらい速く使えるか」を確認するためのアプリです。

## 重要な変更

macOS標準の `Python 3.9.6 + Tk 8.5.9` が `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py` の旧Tkinter UI起動時にクラッシュしたため、UIはローカルWeb UIへ変更しました。

起動後はブラウザで次を開きます。

`http://127.0.0.1:8766`

## 主な機能

- `Option` 長押し中だけ録音
- `Option` ダブルタップでロック録音、もう一度ダブルタップまたは画面ボタンで停止
- Groq `whisper-large-v3-turbo` による音声認識
- Groq LLMによる高速整形
- 整形結果をクリップボードへ入れたうえで、macOSは `Command+V`、Windowsは `Ctrl+V` を自動送信
- 入力レベル、音声認識結果、LLM整形結果、レイテンシをWeb UIで確認
- 辞書設定 UI で認識されやすい表記を任意の単語へ置換
- ショートカットキーをWeb UIから変更

## macOSでの起動

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_mac.command` を実行します。

初回起動時に `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.venv` を作り、必要なPythonパッケージを入れます。起動後、ブラウザが自動で `http://127.0.0.1:8766` を開きます。

## Windowsでの起動

`C:\Users\HCY\OneDrive\開発\Voice2Text\Aqua_Voice\start_windows.bat` を実行します。

Windows側の実パスが異なる場合は、`C:\Users\HCY\OneDrive\開発\Voice2Text\Aqua_Voice\start_windows.bat` 内の `APP_DIR` を実際のフルパスへ変更してください。

## Groq APIキー

Web UI上部の「Groq APIキー（保存しない）」へ `gsk_` から始まるGroq APIキーを入力し、設定保存を押してください。環境変数 `GROQ_API_KEY` が設定されている場合は自動で読みます。

このMVPはAPIキーを `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_config.json` に保存しません。理由は、APIキーをGit管理下やOneDrive上へ誤って残さないためです。

## macOS権限

自動貼り付けとグローバルショートカットには、macOSの許可が必要です。

- マイク
- アクセシビリティ
- 入力監視

許可がない場合、録音、Optionキー検知、`Command+V` 自動送信のいずれかが動かないことがあります。

## 速度調整

Web UIの「送信間隔（秒）」を短くすると、話している途中の表示は速くなります。ただしGroq API呼び出し回数が増えます。最初は `1.2` 秒で試し、遅く感じたら `0.8` 秒前後へ下げてください。

## 生成・保存されるファイル

- 設定: `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_config.json`
- 仮想環境: `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.venv`

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/backend` と `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/frontend` は参照元であり、このアプリから変更しません。
