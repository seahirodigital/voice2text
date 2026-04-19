from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient

from app.main import app


class FakeLiveSession:
    def __init__(self, **_: object) -> None:
        self.queue: asyncio.Queue[dict] = asyncio.Queue()

    async def next_message(self) -> dict:
        return await self.queue.get()

    def start(self, payload) -> dict:
        message = {
            "type": "started",
            "payload": {
                "sessionId": "session-test",
                "language": payload.language,
                "modelPreset": payload.model_preset,
                "deviceLabel": payload.device_label,
            },
        }
        self.queue.put_nowait(message)
        return message

    def ingest_audio(self, frame_bytes: bytes) -> None:
        return None

    def pause(self) -> None:
        self.queue.put_nowait({"type": "paused", "payload": {}})

    def resume(self) -> None:
        self.queue.put_nowait({"type": "resumed", "payload": {}})

    def finalize(self) -> None:
        return None

    def shutdown(self) -> None:
        return None


class BrokenLiveSession(FakeLiveSession):
    def start(self, payload) -> dict:
        raise RuntimeError("session startup failed")


def test_websocket_start_session_returns_started_event(monkeypatch):
    monkeypatch.setattr("app.main.LiveTranscriptionSession", FakeLiveSession)

    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as websocket:
        websocket.send_text(
            json.dumps(
                {
                    "type": "start_session",
                    "payload": {
                        "language": "ja",
                        "modelPreset": "tiny",
                        "browserSampleRate": 48000,
                        "channels": 1,
                        "deviceLabel": "Test Microphone",
                        "maxSpeakers": 3,
                    },
                }
            )
        )
        payload = websocket.receive_json()

    assert payload["type"] == "started"
    assert payload["payload"]["sessionId"] == "session-test"
    assert payload["payload"]["deviceLabel"] == "Test Microphone"


def test_websocket_startup_failure_returns_error_event(monkeypatch):
    monkeypatch.setattr("app.main.LiveTranscriptionSession", BrokenLiveSession)

    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as websocket:
        websocket.send_text(
            json.dumps(
                {
                    "type": "start_session",
                    "payload": {
                        "language": "ja",
                        "modelPreset": "tiny",
                        "browserSampleRate": 48000,
                        "channels": 1,
                        "deviceLabel": "Test Microphone",
                        "maxSpeakers": 3,
                    },
                }
            )
        )
        payload = websocket.receive_json()

    assert payload == {
        "type": "error",
        "payload": {"message": "session startup failed"},
    }
