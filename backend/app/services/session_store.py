from __future__ import annotations

import json
import re
import wave
from pathlib import Path

from app.models.schemas import (
    SessionDetail,
    SessionSummary,
    TranscriptSegment,
    utc_now_iso,
)

DEFAULT_SESSION_TITLE = "New Transcript"
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class SessionStore:
    def __init__(self, sessions_root: Path, recordings_root: Path) -> None:
        self.sessions_root = sessions_root
        self.recordings_root = recordings_root
        self.index_path = sessions_root / "index.json"
        self.sessions_root.mkdir(parents=True, exist_ok=True)
        self.recordings_root.mkdir(parents=True, exist_ok=True)
        if not self.index_path.exists():
            self._write_index([])

    def list_sessions(self) -> list[SessionSummary]:
        raw_index = self._read_index()
        return [SessionSummary.model_validate(entry) for entry in raw_index]

    def get_session(self, session_id: str) -> SessionDetail | None:
        detail_path = self.sessions_root / f"{session_id}.json"
        if not detail_path.exists():
            return None
        return SessionDetail.model_validate_json(detail_path.read_text(encoding="utf-8"))

    def save_session(self, detail: SessionDetail) -> SessionSummary:
        summary = SessionSummary.model_validate(detail.model_dump(by_alias=True))
        detail_path = self.sessions_root / f"{detail.id}.json"
        payload = detail.model_dump(by_alias=True)
        detail_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        summaries = [item for item in self.list_sessions() if item.id != detail.id]
        summaries.insert(0, summary)
        self._write_index(summaries)
        return summary

    def update_transcript(
        self,
        session_id: str,
        segments: list[TranscriptSegment],
        title: str | None = None,
    ) -> SessionDetail | None:
        detail = self.get_session(session_id)
        if detail is None:
            return None

        detail.segments = segments
        detail.updated_at = segments[-1].updated_at if segments else detail.updated_at
        detail.line_count = len(segments)
        if title is not None:
            normalized_title = self._normalize_title(title)
            detail.title = normalized_title
            detail.title_locked = True
            detail.updated_at = utc_now_iso()
            if detail.audio_url:
                detail.audio_url = self._rename_recording(detail.audio_url, normalized_title)
        elif not detail.title_locked:
            detail.title = self._derive_title(segments)
        summary = self.save_session(detail)
        return SessionDetail.model_validate(
            {
                **detail.model_dump(by_alias=True),
                **summary.model_dump(by_alias=True),
            }
        )

    def update_session_title(self, session_id: str, title: str) -> SessionDetail | None:
        detail = self.get_session(session_id)
        if detail is None:
            return None

        normalized_title = self._normalize_title(title)
        detail.title = normalized_title
        detail.title_locked = True
        detail.updated_at = utc_now_iso()

        if detail.audio_url:
            detail.audio_url = self._rename_recording(detail.audio_url, normalized_title)

        summary = self.save_session(detail)
        return SessionDetail.model_validate(
            {
                **detail.model_dump(by_alias=True),
                **summary.model_dump(by_alias=True),
            }
        )

    def delete_session(self, session_id: str) -> bool:
        detail = self.get_session(session_id)
        if detail is None:
            return False

        detail_path = self.sessions_root / f"{session_id}.json"
        if detail_path.exists():
            detail_path.unlink()

        if detail.audio_url:
            audio_path = self.recordings_root / Path(detail.audio_url).name
            if audio_path.exists():
                audio_path.unlink()

        summaries = [item for item in self.list_sessions() if item.id != session_id]
        self._write_index(summaries)
        return True

    def save_recording(
        self,
        session_id: str,
        pcm_bytes: bytes,
        sample_rate: int,
        channels: int = 1,
        title: str | None = None,
    ) -> str:
        wav_path = self._unique_recording_path(title or session_id)
        with wave.open(str(wav_path), "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_bytes)
        return f"/recordings/{wav_path.name}"

    def _read_index(self) -> list[dict]:
        return json.loads(self.index_path.read_text(encoding="utf-8"))

    def _write_index(self, summaries: list[SessionSummary] | list[dict]) -> None:
        if summaries and isinstance(summaries[0], SessionSummary):
            payload = [item.model_dump(by_alias=True) for item in summaries]
        else:
            payload = summaries
        self.index_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _derive_title(segments: list[TranscriptSegment]) -> str:
        if not segments:
            return DEFAULT_SESSION_TITLE
        first_text = segments[0].text.strip() or DEFAULT_SESSION_TITLE
        return first_text[:40]

    @staticmethod
    def _normalize_title(title: str) -> str:
        normalized = " ".join(title.split()).strip()
        return (normalized or DEFAULT_SESSION_TITLE)[:120]

    @classmethod
    def _safe_filename_stem(cls, title: str) -> str:
        sanitized = INVALID_FILENAME_CHARS.sub("", title).strip().rstrip(".")
        sanitized = re.sub(r"\s+", " ", sanitized)
        return (sanitized or DEFAULT_SESSION_TITLE)[:80]

    def _unique_recording_path(self, title: str, current_path: Path | None = None) -> Path:
        stem = self._safe_filename_stem(title)
        candidate = self.recordings_root / f"{stem}.wav"
        if current_path is not None and candidate == current_path:
            return candidate
        if not candidate.exists():
            return candidate

        suffix = 2
        while True:
            candidate = self.recordings_root / f"{stem}-{suffix}.wav"
            if current_path is not None and candidate == current_path:
                return candidate
            if not candidate.exists():
                return candidate
            suffix += 1

    def _rename_recording(self, audio_url: str, title: str) -> str:
        current_path = self.recordings_root / Path(audio_url).name
        if not current_path.exists():
            return audio_url

        target_path = self._unique_recording_path(title, current_path=current_path)
        if target_path == current_path:
            return audio_url

        current_path.rename(target_path)
        return f"/recordings/{target_path.name}"
