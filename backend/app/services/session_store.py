from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from app.models.schemas import (
    SessionDetail,
    SessionSummary,
    TranscriptSegment,
    utc_now_iso,
)

DEFAULT_SESSION_TITLE = "New Transcript"
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
TARGET_RECORDING_SAMPLE_RATE = 16000


class SessionStore:
    def __init__(self, sessions_root: Path, recordings_root: Path) -> None:
        self.sessions_root = sessions_root
        self.recordings_root = recordings_root
        self.index_path = sessions_root / "index.json"
        self.trash_root = sessions_root / ".trash"
        self.sessions_root.mkdir(parents=True, exist_ok=True)
        self.recordings_root.mkdir(parents=True, exist_ok=True)
        self.trash_root.mkdir(parents=True, exist_ok=True)
        if not self.index_path.exists():
            self._write_index([])

    def list_sessions(self) -> list[SessionSummary]:
        raw_index = self._read_index()
        existing_entries = [
            entry
            for entry in raw_index
            if (self.sessions_root / f"{entry.get('id')}.json").exists()
        ]
        if len(existing_entries) != len(raw_index):
            self._write_index(existing_entries)
        return [SessionSummary.model_validate(entry) for entry in existing_entries]

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

        normalized_segments = [
            segment
            if isinstance(segment, TranscriptSegment)
            else TranscriptSegment.model_validate(segment)
            for segment in segments
        ]
        detail.segments = normalized_segments
        detail.updated_at = (
            normalized_segments[-1].updated_at
            if normalized_segments
            else detail.updated_at
        )
        detail.line_count = len(normalized_segments)
        if title is not None:
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

    def update_minutes(
        self,
        session_id: str,
        *,
        minutes_markdown: str,
        minutes_segments: list[TranscriptSegment] | None = None,
        minutes_model: str | None = None,
        minutes_error: str | None = None,
    ) -> SessionDetail | None:
        detail = self.get_session(session_id)
        if detail is None:
            return None

        now = utc_now_iso()
        detail.minutes_markdown = minutes_markdown
        if minutes_segments is not None:
            detail.minutes_segments = minutes_segments
            detail.segments = minutes_segments
            detail.line_count = len(minutes_segments)
            if minutes_segments:
                last_segment = minutes_segments[-1]
                detail.duration_seconds = round(
                    last_segment.started_at + last_segment.duration,
                    3,
                )
        detail.minutes_status = "error" if minutes_error else "complete"
        detail.minutes_progress = 100 if not minutes_error else detail.minutes_progress
        detail.minutes_updated_at = now
        detail.minutes_model = minutes_model
        detail.minutes_error = minutes_error
        detail.updated_at = now

        summary = self.save_session(detail)
        return SessionDetail.model_validate(
            {
                **detail.model_dump(by_alias=True),
                **summary.model_dump(by_alias=True),
            }
        )

    def update_minutes_progress(
        self,
        session_id: str,
        *,
        progress: int,
        minutes_model: str | None = None,
    ) -> SessionDetail | None:
        detail = self.get_session(session_id)
        if detail is None:
            return None

        now = utc_now_iso()
        detail.minutes_status = "processing"
        detail.minutes_progress = max(0, min(100, progress))
        detail.minutes_updated_at = now
        detail.minutes_error = None
        if minutes_model is not None:
            detail.minutes_model = minutes_model
        detail.updated_at = now

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
            raw_index = self._read_index()
            summaries = [entry for entry in raw_index if entry.get("id") != session_id]
            if len(summaries) != len(raw_index):
                self._write_index(summaries)
                return True
            return False

        detail_path = self.sessions_root / f"{session_id}.json"
        trash_dir = self._trash_session_dir(session_id)
        if trash_dir.exists():
            shutil.rmtree(trash_dir)
        trash_dir.mkdir(parents=True, exist_ok=True)

        if detail_path.exists():
            detail_path.rename(trash_dir / detail_path.name)

        if detail.audio_url:
            audio_path = self.recordings_root / Path(detail.audio_url).name
            if audio_path.exists():
                audio_path.rename(trash_dir / audio_path.name)

        summaries = [item for item in self.list_sessions() if item.id != session_id]
        self._write_index(summaries)
        return True

    def restore_session(self, session_id: str) -> SessionDetail | None:
        detail_path = self.sessions_root / f"{session_id}.json"
        if detail_path.exists():
            return self.get_session(session_id)

        trash_dir = self._trash_session_dir(session_id)
        trashed_detail_path = trash_dir / f"{session_id}.json"
        if not trashed_detail_path.exists():
            return None

        detail = SessionDetail.model_validate_json(
            trashed_detail_path.read_text(encoding="utf-8")
        )

        if detail.audio_url:
            trashed_audio_path = trash_dir / Path(detail.audio_url).name
            if trashed_audio_path.exists():
                restored_audio_path = self._unique_recording_path(
                    Path(detail.audio_url).stem,
                    extension=trashed_audio_path.suffix,
                )
                trashed_audio_path.rename(restored_audio_path)
                detail.audio_url = f"/recordings/{restored_audio_path.name}"
            else:
                detail.audio_url = None

        summary = self.save_session(detail)
        shutil.rmtree(trash_dir, ignore_errors=True)
        return SessionDetail.model_validate(
            {
                **detail.model_dump(by_alias=True),
                **summary.model_dump(by_alias=True),
            }
        )

    def save_recording(
        self,
        session_id: str,
        pcm_bytes: bytes,
        sample_rate: int,
        channels: int = 1,
        title: str | None = None,
    ) -> str:
        recording_path = self._unique_recording_path(
            title or session_id,
            extension=".flac",
        )
        audio = self._prepare_recording_audio(pcm_bytes, sample_rate, channels)
        sf.write(
            str(recording_path),
            audio,
            TARGET_RECORDING_SAMPLE_RATE,
            format="FLAC",
            subtype="PCM_16",
        )
        return f"/recordings/{recording_path.name}"

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
        sanitized = INVALID_FILENAME_CHARS.sub("-", title).strip().rstrip(".")
        sanitized = re.sub(r"-+", "-", sanitized)
        sanitized = re.sub(r"\s*-\s*", "-", sanitized)
        sanitized = re.sub(r"\s+", " ", sanitized)
        return (sanitized or DEFAULT_SESSION_TITLE)[:80]

    def _unique_recording_path(
        self,
        title: str,
        current_path: Path | None = None,
        extension: str | None = None,
    ) -> Path:
        stem = self._safe_filename_stem(title)
        suffix = extension or (current_path.suffix if current_path else ".flac")
        candidate = self.recordings_root / f"{stem}{suffix}"
        if current_path is not None and candidate == current_path:
            return candidate
        if not candidate.exists():
            return candidate

        index = 2
        while True:
            candidate = self.recordings_root / f"{stem}-{index}{suffix}"
            if current_path is not None and candidate == current_path:
                return candidate
            if not candidate.exists():
                return candidate
            index += 1

    def _trash_session_dir(self, session_id: str) -> Path:
        return self.trash_root / session_id

    def _rename_recording(self, audio_url: str, title: str) -> str:
        current_path = self.recordings_root / Path(audio_url).name
        if not current_path.exists():
            return audio_url

        target_path = self._unique_recording_path(title, current_path=current_path)
        if target_path == current_path:
            return audio_url

        current_path.rename(target_path)
        return f"/recordings/{target_path.name}"

    @staticmethod
    def _prepare_recording_audio(
        pcm_bytes: bytes,
        sample_rate: int,
        channels: int,
    ) -> np.ndarray:
        audio = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32)
        if audio.size == 0:
            return np.zeros(1, dtype=np.float32)

        channel_count = max(1, channels)
        if channel_count > 1:
            usable = audio[: audio.size - (audio.size % channel_count)]
            if usable.size == 0:
                return np.zeros(1, dtype=np.float32)
            audio = usable.reshape(-1, channel_count).mean(axis=1)

        audio /= 32768.0

        if sample_rate != TARGET_RECORDING_SAMPLE_RATE:
            audio = resample_poly(audio, TARGET_RECORDING_SAMPLE_RATE, sample_rate)

        return np.clip(audio.astype(np.float32), -1.0, 1.0)
