# Voice2Text LLM Development Plan

## Goal

Moonshine のリアルタイム文字起こし結果を、ローカル LLM で自然な日本語へ整形する。
最初は Moonshine の `TRANSCRIPT` を上書きせず、右隣に LLM 整形後の列を追加して比較できるようにする。

## Target Runtime

- LLM runtime: Ollama
- Models:
  - `gemma4:e2b`
  - `gemma4:e4b`
- Ollama API: `http://localhost:11434/api`
- Voice2Text local control folder: `C:\Users\mahha\OneDrive\開発\Voice2Text\LLM`
- Ollama model storage target: `C:\Users\mahha\OneDrive\開発\Voice2Text\LLM\models`
- Voice2Text LLM logs/config target: `C:\Users\mahha\OneDrive\開発\Voice2Text\LLM`
- Ollama startup policy: do not use Windows startup. `start.bat` starts Ollama only when Voice2Text launches.

## Initial Findings

- Ollama is not currently available on PATH.
- `LLM` folder exists and is currently empty.
- `config.json` is currently invalid JSON because `paths.tempRecordingsRoot` is missing a closing quote.
- Moonshine transcript events are emitted from `backend/app/services/live_session.py`.
- The frontend transcript table is rendered in `frontend/src/App.tsx`.

## Current Status

- Ollama 0.21.0 is installed.
- Windows startup shortcut for Ollama was removed.
- `start.bat` starts Ollama through `LLM/scripts/start-ollama.ps1`.
- `start.bat` disables per-user Ollama startup entries through `LLM/scripts/disable-ollama-startup.ps1`.
- `gemma4:e2b` and `gemma4:e4b` are pulled into `LLM/models`.
- Both models returned valid Japanese refinement through Ollama API.
- Voice2Text now has a right-side `LLM Refined` transcript column.
- LLM model, context line count, debounce, complete-only mode, and enable/disable controls are in Settings.

## Step 1: Install And Verify Ollama/Gemma4

1. Create the local LLM folder layout.
   - `LLM/models`
   - `LLM/logs`
   - `LLM/prompts`
   - `LLM/scripts`
2. Repair `config.json` so the backend can load settings.
3. Install Ollama for Windows.
4. Set `OLLAMA_MODELS` to `C:\Users\mahha\OneDrive\開発\Voice2Text\LLM\models`.
5. Disable any Windows startup registration for Ollama.
6. Start Ollama from `start.bat` via `LLM/scripts/start-ollama.ps1`.
7. Pull models.
   - `ollama pull gemma4:e2b`
   - `ollama pull gemma4:e4b`
8. Verify terminal execution.
   - `ollama --version`
   - `ollama ls`
   - `ollama run gemma4:e2b "次の音声認識結果を自然な日本語に整形してください: きょう の かいぎ は じゅうじ から です"`
   - `ollama run gemma4:e4b "次の音声認識結果を自然な日本語に整形してください: きょう の かいぎ は じゅうじ から です"`
9. Verify API execution.
   - `GET http://localhost:11434/api/tags`
   - `POST http://localhost:11434/api/chat`

Step 1 is complete only after both `gemma4:e2b` and `gemma4:e4b` return valid text from the terminal or API.

## Step 2: Integrate LLM Refinement Into Voice2Text

1. Extend backend settings.
   - `llm.enabled`
   - `llm.provider`
   - `llm.baseUrl`
   - `llm.model`
   - `llm.contextLines`
   - `llm.debounceMs`
   - `llm.completeOnly`
2. Add backend Ollama client.
   - Health check via `/api/tags`
   - Chat call via `/api/chat`
   - Timeout and error handling
3. Add transcript refinement service.
   - Consume Moonshine line updates.
   - Build prompt from current line plus configurable surrounding line count.
   - Queue LLM jobs without blocking Moonshine transcription.
   - Discard stale LLM results when a newer transcript revision exists.
4. Extend transcript segment schema.
   - `llmText`
   - `llmModel`
   - `llmStatus`
   - `llmLatencyMs`
   - `llmUpdatedAt`
5. Extend WebSocket messages.
   - `llm_refinement_started`
   - `llm_refinement_updated`
   - `llm_refinement_error`
6. Update frontend display.
   - Change transcript grid from 3 columns to 4 columns.
   - Add `LLM Refined` column to the right of `Transcript Text`.
   - Keep original Moonshine text editable.
7. Add runtime controls.
   - E2B/E4B model switch.
   - Context line count control.
   - Real-time refinement ON/OFF.
   - Complete-only vs in-progress refinement toggle.
8. Persist LLM output in session JSON.
9. Verify.
   - Backend tests for settings and Ollama client.
   - WebSocket tests for LLM refinement messages.
   - Frontend build.
   - Real microphone test with Moonshine + Gemma4 E2B/E4B switching.

## Prompt Policy

The first prompt should be strict and conservative:

```text
あなたは日本語の音声認識結果を整形する編集者です。
意味を変えず、聞き間違いらしい箇所だけ自然な日本語に直してください。
句読点、漢字かな交じり、文の区切りを整えてください。
存在しない情報を追加しないでください。
出力は整形後の本文だけにしてください。
```

## Development Notes

- Do not replace the raw Moonshine transcript at first.
- Prefer low latency over perfect correction during live capture.
- `gemma4:e2b` is expected to be faster; `gemma4:e4b` is expected to be more accurate.
- If Ollama is unavailable, Voice2Text must continue raw transcription without failing.
- Keep generated model files out of Git if the model directory is inside this repository.

## References

- https://ollama.com/
- https://docs.ollama.com/windows
- https://docs.ollama.com/api/chat
- https://ollama.com/library/gemma4
- https://ai.google.dev/gemma/docs/core/model_card_4?hl=ja
