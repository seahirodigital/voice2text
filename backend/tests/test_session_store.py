from __future__ import annotations

import wave
from pathlib import Path

from app.models.schemas import SessionDetail
from app.services.session_store import SessionStore


def _write_pcm_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b"\x00\x00" * 160)


def test_update_session_title_renames_recording_and_locks_title(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    audio_path = recordings_root / "session-123.wav"
    _write_pcm_wav(audio_path)

    detail = SessionDetail.model_validate(
        {
            "id": "session-123",
            "createdAt": "2026-04-19T10:00:00Z",
            "updatedAt": "2026-04-19T10:00:00Z",
            "language": "ja",
            "deviceLabel": "Test Mic",
            "durationSeconds": 3.2,
            "lineCount": 1,
            "title": "Old Title",
            "audioUrl": "/recordings/session-123.wav",
            "segments": [],
        }
    )
    store.save_session(detail)

    updated = store.update_session_title("session-123", "Meeting Notes")

    assert updated is not None
    assert updated.title == "Meeting Notes"
    assert updated.title_locked is True
    assert updated.audio_url == "/recordings/Meeting Notes.wav"
    assert not audio_path.exists()
    assert (recordings_root / "Meeting Notes.wav").exists()


def test_update_transcript_keeps_locked_title(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    detail = SessionDetail.model_validate(
        {
            "id": "session-456",
            "createdAt": "2026-04-19T10:00:00Z",
            "updatedAt": "2026-04-19T10:00:00Z",
            "language": "ja",
            "deviceLabel": "Test Mic",
            "durationSeconds": 3.2,
            "lineCount": 0,
            "title": "Pinned Title",
            "titleLocked": True,
            "audioUrl": None,
            "segments": [],
        }
    )
    store.save_session(detail)

    updated = store.update_transcript(
        "session-456",
        [
            {
                "id": "line-1",
                "lineId": 1,
                "text": "new inferred title",
                "speakerLabel": "Speaker A",
                "speakerIndex": 0,
                "speakerSource": "moonshine",
                "startedAt": 0,
                "duration": 1.2,
                "isComplete": True,
                "latencyMs": 10,
                "updatedAt": "2026-04-19T10:01:00Z",
            }
        ],
    )

    assert updated is not None
    assert updated.title == "Pinned Title"


def test_update_transcript_keeps_unlocked_timestamp_title(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    detail = SessionDetail.model_validate(
        {
            "id": "session-789",
            "createdAt": "2026-04-21T08:56:00Z",
            "updatedAt": "2026-04-21T08:56:00Z",
            "language": "ja",
            "deviceLabel": "Test Mic",
            "durationSeconds": 3.2,
            "lineCount": 0,
            "title": "2026/04/21 17:56",
            "titleLocked": False,
            "audioUrl": None,
            "segments": [],
        }
    )
    store.save_session(detail)

    updated = store.update_transcript(
        "session-789",
        [
            {
                "id": "line-1",
                "lineId": 1,
                "text": "this should not become the title",
                "speakerLabel": "Speaker A",
                "speakerIndex": 0,
                "speakerSource": "moonshine",
                "startedAt": 0,
                "duration": 1.2,
                "isComplete": True,
                "latencyMs": 10,
                "updatedAt": "2026-04-21T08:57:00Z",
            }
        ],
    )

    assert updated is not None
    assert updated.title == "2026/04/21 17:56"


def test_save_recording_uses_windows_safe_datetime_filename(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    audio_url = store.save_recording(
        "session-date",
        b"\x00\x00" * 160,
        sample_rate=16000,
        title="2026/04/21 17:56",
    )

    assert audio_url == "/recordings/2026-04-21 17-56.flac"
    assert (recordings_root / "2026-04-21 17-56.flac").exists()


def test_delete_session_removes_stale_index_entry(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    detail = SessionDetail.model_validate(
        {
            "id": "session-stale",
            "createdAt": "2026-04-19T10:00:00Z",
            "updatedAt": "2026-04-19T10:00:00Z",
            "language": "ja",
            "deviceLabel": "Test Mic",
            "durationSeconds": 0,
            "lineCount": 0,
            "title": "Stale Entry",
            "audioUrl": None,
            "segments": [],
        }
    )
    store.save_session(detail)
    (sessions_root / "session-stale.json").unlink()

    assert store.delete_session("session-stale") is True
    assert store.list_sessions() == []


def test_delete_session_can_be_restored_with_recording(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    recordings_root = tmp_path / "recordings"
    store = SessionStore(sessions_root=sessions_root, recordings_root=recordings_root)

    audio_path = recordings_root / "session-restore.wav"
    _write_pcm_wav(audio_path)

    detail = SessionDetail.model_validate(
        {
            "id": "session-restore",
            "createdAt": "2026-04-19T10:00:00Z",
            "updatedAt": "2026-04-19T10:00:00Z",
            "language": "ja",
            "deviceLabel": "Test Mic",
            "durationSeconds": 1.2,
            "lineCount": 1,
            "title": "Restore Me",
            "audioUrl": "/recordings/session-restore.wav",
            "segments": [],
        }
    )
    store.save_session(detail)

    assert store.delete_session("session-restore") is True
    assert store.get_session("session-restore") is None
    assert not audio_path.exists()

    restored = store.restore_session("session-restore")

    assert restored is not None
    assert restored.id == "session-restore"
    assert restored.audio_url == "/recordings/session-restore.wav"
    assert (recordings_root / "session-restore.wav").exists()
    assert [session.id for session in store.list_sessions()] == ["session-restore"]
