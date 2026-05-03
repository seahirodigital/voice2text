# Aqua Voice 技術リファレンス

## 対象

このドキュメントは、`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice` に作成した Aqua Voice の技術引き継ぎです。

Aqua Voice は、Groqを使う高速音声入力MVPです。話した内容を短い単位で音声認識し、Groq LLMで軽く整形し、現在カーソルがある場所へ自動貼り付けします。

## 変更範囲

作業対象は次のフォルダ内だけです。

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice`

参照のみで変更しないフォルダは次の2つです。

- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/backend`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/frontend`

## 現在の構成

主要ファイル:

- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/requirements.txt`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_mac.command`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_windows.bat`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/README.md`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.gitignore`

起動URL:

`http://127.0.0.1:8766`

## 設計方針

最初は `Tkinter` UIで作成したが、macOS 26.3.1 と Apple CommandLineTools Python 3.9.6 の `Tk 8.5.9` が `Tk()` 初期化時に `SIGABRT` で落ちたため、ローカルWeb UI方式へ変更しました。

現在は `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py` が次の役割を持ちます。

- `http.server.ThreadingHTTPServer` によるローカルWeb UI提供
- Web UIからの録音開始、停止、設定保存、貼り付け操作
- `pynput` によるグローバルショートカット監視
- `sounddevice` によるマイク録音
- Groq音声認識API呼び出し
- Groq LLM整形API呼び出し
- macOS / Windows の自動貼り付け

## 主要機能

- `Option` 長押し中だけ録音
- `Option` ダブルタップでロック録音
- ロック録音中にもう一度ダブルタップ、またはWeb UIの停止ボタンで停止
- Groq `whisper-large-v3-turbo` による音声認識
- Groq LLMによる高速整形
- macOSでは `pbcopy` と `osascript` で `Command+V` を送信
- Windowsでは `clip` と `ctypes` で `Ctrl+V` を送信
- Web UIで入力レベル、音声認識結果、LLM整形結果、レイテンシを確認
- 録音開始時の前面アプリを貼り付け先として記憶
- 整形完了時に記憶したアプリへ戻してから貼り付け
- Web UIで辞書設定を編集
- Web UIでショートカットキー、モデル、送信間隔を変更し、自動保存

## ネイティブアプリへの貼り付け

Web UIは状態確認と設定の操作盤です。実際の入力先は、録音開始時に前面にあるアプリとして記憶します。

macOSでは、録音開始時に `osascript` と `System Events` で前面アプリ名、bundle identifier、process idを取得します。整形完了後は、process id、bundle identifier、アプリ名の順で対象プロセスを探し、`System Events` で前面へ戻します。その後、`pbcopy` でクリップボードへ本文を入れてから `key code 9 using {command down}` で `Command+V` を送ります。

このため、Cursor、Obsidian、メモ、Slack、Wordなどのネイティブアプリや他のツール上にカーソルを置いてから `Option` 長押し録音を開始すると、そのアプリへ貼り付けます。

Electron系アプリでは、`tell application id <bundle identifier> to activate` が失敗することがあります。`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py` ではこの方式を避け、`System Events` の `application process` を直接前面化する実装にしています。これにより、Google Antigravity、Cursor、Obsidianなどでもブラウザ外の入力欄へ戻して貼り付けやすくしています。

Web UIのボタンから録音を開始した場合、ブラウザが前面アプリとして検出されます。ただし直近の貼り付け先が非ブラウザアプリであれば、Chromeなどのブラウザで上書きせず、その直近の非ブラウザ貼り付け先を維持します。ネイティブアプリへ確実に貼り付けたい場合は、貼り付け先アプリにカーソルを置いた状態でグローバルショートカットを使います。

Web UIのヘッダーには、現在記憶している貼り付け先アプリ名を表示します。

## 依存関係

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/requirements.txt` の内容:

```txt
httpx==0.28.1
numpy>=1.26,<2.1
pynput==1.8.1
sounddevice==0.5.3
```

`pyautogui` は削除済みです。理由は、Tkinterクラッシュ調査の過程で不要になり、現在はmacOS標準コマンドで貼り付けを実装しているためです。

## 起動方法

macOS:

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_mac.command`

起動後、ブラウザで次が開きます。

`http://127.0.0.1:8766`

Windows:

`C:\Users\HCY\OneDrive\開発\Voice2Text\Aqua_Voice\start_windows.bat`

Windows側の実パスが異なる場合は、`C:\Users\HCY\OneDrive\開発\Voice2Text\Aqua_Voice\start_windows.bat` 内の `APP_DIR` を実際のフルパスへ変更してください。

## Groq APIキー

Web UI上部の「Groq APIキー（保存されます）」へ `gsk_` から始まるGroq APIキーを入力します。完全な `gsk_...` 形式として認識されると、設定ファイルへ保存され、次回起動時から自動利用されます。

環境変数 `GROQ_API_KEY` がある場合は自動で読みます。

APIキーは `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_config.json` に平文保存します。このファイルは `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.gitignore` でGit管理外にしています。

## 設定保持

送信間隔、サンプルレート、音声認識モデル、LLMモデル、ショートカットキー、辞書設定はWeb UIで変更すると自動保存されます。

保存先:

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_config.json`

## macOS権限

macOSでは次の許可が必要です。

- マイク
- アクセシビリティ
- 入力監視

許可がない場合、録音、Optionキー検知、`Command+V` 自動送信のいずれかが動かないことがあります。

## 速度調整

Web UIの「送信間隔（秒）」を短くすると、話している途中の表示は速くなります。ただしGroq API呼び出し回数が増えます。

初期値は `1.2` 秒です。遅く感じる場合は `0.8` 秒前後へ下げて確認します。

## 既知の問題と対応履歴

### NumPyのバージョン不一致

初回起動時、`numpy==2.4.4` が Python 3.9.6 で見つからず失敗しました。

対応:

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/requirements.txt` を次の指定へ変更済みです。

```txt
numpy>=1.26,<2.1
```

### Tkinterクラッシュ

Apple CommandLineTools付属の Python 3.9.6 が読み込む `Tk 8.5.9` が、macOS 26.3.1で `Tk()` 初期化時に `SIGABRT` でクラッシュしました。

遅延インポートでも解消しなかったため、`Tkinter` を完全に廃止し、ローカルWeb UIへ変更しました。

### Homebrew PythonのTkなし

`/opt/homebrew/bin/python3` は存在し、バージョンは `Python 3.14.2` でした。ただし `tkinter` は未搭載で、次のエラーになりました。

```txt
ModuleNotFoundError: No module named '_tkinter'
```

このため、Tkinterを使わないWeb UI方式が現在の正しい方針です。

### `.pyc` キャッシュ書き込み

仮想環境側の `py_compile` 実行時、macOS Python が `/Users/user/Library/Caches/com.apple.python/...` へ `.pyc` を書こうとして `PermissionError` になりました。

対応:

`/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_mac.command` に次を追加済みです。

```zsh
export PYTHONDONTWRITEBYTECODE=1
```

## 検証済み事項

構文チェック:

```bash
PYTHONPYCACHEPREFIX=/private/tmp/aqua_voice_pycache /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.venv/bin/python -m py_compile /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py
```

モジュール読み込み:

```bash
PYTHONDONTWRITEBYTECODE=1 /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.venv/bin/python -c "import importlib.util, sys; p='/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py'; s=importlib.util.spec_from_file_location('aqua_voice_app', p); m=importlib.util.module_from_spec(s); sys.modules[s.name]=m; s.loader.exec_module(m); print(m.SERVER_HOST, m.SERVER_PORT)"
```

期待出力:

```txt
127.0.0.1 8766
```

コントローラー初期化:

```bash
PYTHONDONTWRITEBYTECODE=1 /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/.venv/bin/python -c "import importlib.util, sys; p='/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/aqua_voice_app.py'; s=importlib.util.spec_from_file_location('aqua_voice_app', p); m=importlib.util.module_from_spec(s); sys.modules[s.name]=m; s.loader.exec_module(m); c=m.AquaVoiceController(); print(c.snapshot()['serverUrl'], c.snapshot()['status'])"
```

期待出力:

```txt
http://127.0.0.1:8766 待機中
```

## 次に確認すること

次回は `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/start_mac.command` の実行ログを確認します。

成功時の目安:

- ターミナルに `Aqua Voice Web UI: http://127.0.0.1:8766` が出る
- ブラウザが `http://127.0.0.1:8766` を開く

失敗時の切り分け:

- 依存インストールエラー: `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice/requirements.txt` を調整
- `pynput` 権限エラー: macOSの「アクセシビリティ」「入力監視」を確認
- `sounddevice` エラー: macOSのマイク許可、またはPortAudio周りを確認
- `osascript` 貼り付けエラー: macOSのアクセシビリティ許可を確認
