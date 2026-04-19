from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
from moonshine_voice import ModelArch, Transcriber, TranscriptEventListener
from moonshine_voice.download import get_model_for_language
from moonshine_voice.transcriber import (
    Error,
    LineCompleted,
    LineStarted,
    LineTextChanged,
    LineUpdated,
)

from app.models.schemas import (
    SessionDetail,
    StartSessionPayload,
    TranscriptSegment,
    utc_now_iso,
)
from app.services.session_store import SessionStore
from app.services.settings_service import MODEL_PRESET_CANDIDATES
from app.services.speaker_labeler import SpeakerLabeler


def _resolve_model(
    language: str, model_preset: str, models_root: Path
) -> tuple[str, ModelArch, str]:
    presets = MODEL_PRESET_CANDIDATES.get(model_preset, MODEL_PRESET_CANDIDATES["tiny"])
    last_error: Exception | None = None
    for candidate in presets:
        try:
            model_path, model_arch = get_model_for_language(
                language, candidate, cache_root=models_root
            )
            return model_path, model_arch, model_preset
        except ValueError as exc:
            last_error = exc
            continue

    for fallback_preset in ("tiny", "base", "small-streaming", "medium-streaming"):
        if fallback_preset == model_preset:
            continue
        for candidate in MODEL_PRESET_CANDIDATES[fallback_preset]:
            try:
                model_path, model_arch = get_model_for_language(
                    language, candidate, cache_root=models_root
                )
                return model_path, model_arch, fallback_preset
            except ValueError as exc:
                last_error = exc
                continue

    raise ValueError(f"No compatible Moonshine model found: {last_error}")


@dataclass(slots=True)
class SessionContext:
    session_id: str
    language: str
    model_preset: str
    browser_sample_rate: int
    channels: int
    device_label: str
    started_at: str


class LiveSessionListener(TranscriptEventListener):
    def __init__(self, owner: "LiveTranscriptionSession") -> None:
        self.owner = owner

    def on_line_started(self, event: LineStarted) -> None:
        self.owner.publish_line("line_started", event.line)

    def on_line_updated(self, event: LineUpdated) -> None:
        self.owner.publish_line("line_updated", event.line)

    def on_line_text_changed(self, event: LineTextChanged) -> None:
        self.owner.publish_line("line_text_changed", event.line)

    def on_line_completed(self, event: LineCompleted) -> None:
        self.owner.publish_line("line_completed", event.line)

    def on_error(self, event: Error) -> None:
        self.owner.publish_error(str(event.error))


class LiveTranscriptionSession:
    def __init__(
        self,
        *,
        loop: asyncio.AbstractEventLoop,
        store: SessionStore,
        models_root: Path,
        update_interval_ms: int,
        enable_word_timestamps: bool,
    ) -> None:
        self.loop = loop
        self.store = store
        self.models_root = models_root
        self.update_interval_ms = update_interval_ms
        self.enable_word_timestamps = enable_word_timestamps

        self.context: SessionContext | None = None
        self.transcriber: Transcriber | None = None
        self.listener: LiveSessionListener | None = None
        self.labeler = SpeakerLabeler()
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.raw_audio = bytearray()
        self.segments: dict[int, TranscriptSegment] = {}
        self.active = False
        self.paused = False

    async def next_message(self) -> dict:
        return await self.queue.get()

    def start(self, payload: StartSessionPayload) -> dict:
        if self.active:
            raise RuntimeError("A live transcription session is already active.")

        model_path, model_arch, resolved_preset = _resolve_model(
            payload.language, payload.model_preset, self.models_root
        )
        options: dict[str, str] = {}
        if self.enable_word_timestamps:
            options["word_timestamps"] = "true"

        self.context = SessionContext(
            session_id=f"session-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}",
            language=payload.language,
            model_preset=resolved_preset,
            browser_sample_rate=payload.browser_sample_rate,
            channels=payload.channels,
            device_label=payload.device_label,
            started_at=utc_now_iso(),
        )
        self.labeler = SpeakerLabeler(payload.max_speakers)
        self.raw_audio = bytearray()
        self.segments = {}

        self.transcriber = Transcriber(
            model_path=model_path,
            model_arch=model_arch,
            update_interval=self.update_interval_ms / 1000.0,
            options=options or None,
        )
        self.listener = LiveSessionListener(self)
        self.transcriber.add_listener(self.listener)
        self.transcriber.start()
        self.active = True
        self.paused = False

        started_payload = {
            "type": "started",
            "payload": {
                "sessionId": self.context.session_id,
                "language": self.context.language,
                "modelPreset": self.context.model_preset,
                "deviceLabel": self.context.device_label,
            },
        }
        self._put_nowait(started_payload)
        return started_payload

    def pause(self) -> None:
        self.paused = True
        self._put_nowait({"type": "paused", "payload": {}})

    def resume(self) -> None:
        self.paused = False
        self._put_nowait({"type": "resumed", "payload": {}})

    def ingest_audio(self, frame_bytes: bytes) -> None:
        if not self.active or self.paused or self.transcriber is None or self.context is None:
            return

        self.raw_audio.extend(frame_bytes)
        pcm = np.frombuffer(frame_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.transcriber.add_audio(
            pcm.tolist(),
            sample_rate=self.context.browser_sample_rate,
        )

    def publish_line(self, event_type: str, line) -> None:
        if self.context is None:
            return

        moonshine_index = line.speaker_index if bool(line.has_speaker_id) else None
        speaker_label, speaker_index, speaker_source = self.labeler.assign(
            line.line_id,
            line.audio_data,
            16000,
            moonshine_index,
        )

        segment = TranscriptSegment(
            id=f"line-{line.line_id}",
            lineId=line.line_id,
            text=line.text,
            speakerLabel=speaker_label,
            speakerIndex=speaker_index,
            speakerSource=speaker_source,
            startedAt=round(float(line.start_time), 3),
            duration=round(float(line.duration), 3),
            isComplete=bool(line.is_complete),
            latencyMs=int(line.last_transcription_latency_ms),
            updatedAt=utc_now_iso(),
        )
        self.segments[line.line_id] = segment
        self._put_nowait(
            {
                "type": event_type,
                "payload": segment.model_dump(by_alias=True),
            }
        )

    def publish_error(self, message: str) -> None:
        self._put_nowait({"type": "error", "payload": {"message": message}})

    def finalize(self) -> dict | None:
        if not self.active or self.context is None:
            return None

        if self.transcriber is not None:
            self.transcriber.stop()
            self.transcriber.close()

        ordered_segments = [
            self.segments[key] for key in sorted(self.segments, key=lambda item: item)
        ]
        duration_seconds = 0.0
        if ordered_segments:
            last_segment = ordered_segments[-1]
            duration_seconds = round(
                last_segment.started_at + last_segment.duration,
                3,
            )

        derived_title = (
            ordered_segments[0].text[:40].strip()
            if ordered_segments and ordered_segments[0].text.strip()
            else "New Transcript"
        )
        audio_url = self.store.save_recording(
            self.context.session_id,
            bytes(self.raw_audio),
            self.context.browser_sample_rate,
            self.context.channels,
            title=derived_title,
        )
        detail = SessionDetail(
            id=self.context.session_id,
            createdAt=self.context.started_at,
            updatedAt=utc_now_iso(),
            language=self.context.language,
            deviceLabel=self.context.device_label,
            durationSeconds=duration_seconds,
            lineCount=len(ordered_segments),
            title=derived_title,
            titleLocked=False,
            audioUrl=audio_url,
            segments=ordered_segments,
        )
        summary = self.store.save_session(detail)

        payload = {
            "type": "session_saved",
            "payload": {
                "session": summary.model_dump(by_alias=True),
            },
        }
        self._put_nowait(payload)
        self.active = False
        return payload

    def shutdown(self) -> None:
        if not self.active:
            return
        self.finalize()

    def _put_nowait(self, payload: dict) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, payload)
