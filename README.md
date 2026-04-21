# Voice2Text

Moonshine を使ったローカル音声文字起こしアプリです。

## Stack

- Frontend: React + Vite + Tailwind CSS + Framer Motion
- Backend: FastAPI + WebSocket + `moonshine-voice`
- Models: `%LOCALAPPDATA%\Voice2Text\models`
- Recordings: `%LOCALAPPDATA%\Voice2Text\temp_recordings`

## Setup

```bat
setup.bat
```

## Run

```bat
start.bat
```

## Notes

- 設定はルートの [config.json](./config.json) に保存されます。
- 重いファイルは OneDrive 配下に置かず、`%LOCALAPPDATA%\Voice2Text\...` に分離しています。
- Phase 1 の話者ラベルは Moonshine の話者情報が取れた場合はそれを優先し、足りない場合は音響特徴ベースのフォールバックを使います。
