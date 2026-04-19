from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app.config import resolve_paths
from app.models.schemas import (
    AppSettings,
    StartSessionPayload,
    TranscriptUpdatePayload,
    WebSocketEnvelope,
)
from app.services.live_session import LiveTranscriptionSession
from app.services.session_store import SessionStore
from app.services.settings_service import SettingsService

settings_service = SettingsService()

app = FastAPI(title="Voice2Text API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_store() -> SessionStore:
    settings = settings_service.get_settings()
    paths = resolve_paths(settings)
    return SessionStore(
        sessions_root=Path(paths.sessions_root),
        recordings_root=Path(paths.temp_recordings_root),
    )


def get_frontend_dist() -> Path:
    settings = settings_service.get_settings()
    paths = resolve_paths(settings)
    return Path(paths.frontend_dist)


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/settings")
async def read_settings():
    return settings_service.get_settings_response()


@app.put("/api/settings")
async def write_settings(settings: AppSettings):
    return settings_service.update_settings(settings)


@app.get("/api/meta")
async def read_meta():
    return settings_service.get_meta()


@app.get("/api/sessions")
async def list_sessions():
    store = get_store()
    return store.list_sessions()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    store = get_store()
    detail = store.get_session(session_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


@app.put("/api/sessions/{session_id}/transcript")
async def update_session_transcript(session_id: str, payload: TranscriptUpdatePayload):
    store = get_store()
    detail = store.update_transcript(session_id, payload.segments)
    if detail is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    store = get_store()
    if not store.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse({"deleted": True})


@app.get("/recordings/{filename}")
async def serve_recording(filename: str):
    store = get_store()
    recording_path = store.recordings_root / filename
    if not recording_path.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(recording_path)


@app.websocket("/ws/transcribe")
async def transcription_socket(websocket: WebSocket):
    await websocket.accept()

    settings = settings_service.get_settings()
    paths = resolve_paths(settings)
    session = LiveTranscriptionSession(
        loop=asyncio.get_running_loop(),
        store=SessionStore(
            sessions_root=Path(paths.sessions_root),
            recordings_root=Path(paths.temp_recordings_root),
        ),
        models_root=Path(paths.models_root),
        update_interval_ms=settings.transcription.update_interval_ms,
        enable_word_timestamps=settings.transcription.enable_word_timestamps,
    )

    async def sender() -> None:
        try:
            while True:
                message = await session.next_message()
                await websocket.send_json(message)
        except (WebSocketDisconnect, RuntimeError):
            return

    sender_task = asyncio.create_task(sender())
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                session.ingest_audio(message["bytes"])
                continue

            text = message.get("text")
            if not text:
                continue

            envelope = WebSocketEnvelope.model_validate_json(text)
            if envelope.type == "start_session":
                payload = StartSessionPayload.model_validate(envelope.payload)
                session.start(payload)
            elif envelope.type == "pause_session":
                session.pause()
            elif envelope.type == "resume_session":
                session.resume()
            elif envelope.type == "stop_session":
                session.finalize()
            else:
                await websocket.send_json(
                    {
                        "type": "error",
                        "payload": {"message": f"Unknown message type: {envelope.type}"},
                    }
                )
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        if "disconnect message" not in str(exc):
            with contextlib.suppress(RuntimeError):
                await websocket.send_json(
                    {
                        "type": "error",
                        "payload": {"message": str(exc)},
                    }
                )
    except Exception as exc:  # pragma: no cover - defensive websocket error path
        with contextlib.suppress(RuntimeError):
            await websocket.send_json(
                {
                    "type": "error",
                    "payload": {"message": str(exc)},
                }
            )
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=1011)
    finally:
        session.shutdown()
        sender_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, RuntimeError):
            await sender_task


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("recordings/"):
        raise HTTPException(status_code=404, detail="Not found")

    frontend_dist = get_frontend_dist()
    requested_path = frontend_dist / full_path
    if full_path and requested_path.exists() and requested_path.is_file():
        return FileResponse(requested_path)

    index_path = frontend_dist / "index.html"
    if index_path.exists():
        return FileResponse(index_path)

    raise HTTPException(
        status_code=404,
        detail="Frontend build not found. Run the frontend dev server or build the app.",
    )
