from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from uuid import uuid4

import numpy as np
import httpx
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
    LlmSettings,
    SessionDetail,
    StartSessionPayload,
    TranscriptSegment,
    utc_now_iso,
)
from app.services.groq_client import GroqClient, pcm16_wav_bytes
from app.services.refinement_client import (
    create_refinement_client,
    refinement_enabled,
)
from app.services.session_store import SessionStore
from app.services.settings_service import MODEL_PRESET_CANDIDATES
from app.services.speaker_labeler import SpeakerLabeler

GROQ_MIN_LIVE_CHUNK_SECONDS = 1.0
GROQ_FINAL_FLUSH_MIN_SECONDS = 0.25


def _format_session_title(started_at: str) -> str:
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except ValueError:
        started = datetime.now(timezone.utc)
    return started.astimezone().strftime("%Y/%m/%d %H:%M")


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
    title: str
    language: str
    realtime_transcription_engine: str
    model_preset: str
    groq_transcription_model: str
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
        llm_settings: LlmSettings,
    ) -> None:
        self.loop = loop
        self.store = store
        self.models_root = models_root
        self.update_interval_ms = update_interval_ms
        self.enable_word_timestamps = enable_word_timestamps
        self.llm_settings = llm_settings

        self.context: SessionContext | None = None
        self.transcriber: Transcriber | None = None
        self.listener: LiveSessionListener | None = None
        self.labeler = SpeakerLabeler()
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.raw_audio = bytearray()
        self.segments: dict[int, TranscriptSegment] = {}
        self.llm_revisions: dict[int, int] = {}
        self.llm_pending_line_ids: set[int] = set()
        self.llm_requested_at: dict[int, float] = {}
        self.llm_worker_future = None
        self.llm_wake_event = asyncio.Event()
        self.groq_worker_future = None
        self.groq_wake_event = asyncio.Event()
        self.groq_processed_offset = 0
        self.groq_line_id = 0
        self.groq_error_reported = False
        self.moonshine_line_id_offset = 0
        self.moonshine_time_offset = 0.0
        self.active = False
        self.paused = False
        self.recognition_stopped = False

    async def next_message(self) -> dict:
        return await self.queue.get()

    def start(self, payload: StartSessionPayload) -> dict:
        if self.active:
            raise RuntimeError("A live transcription session is already active.")

        resolved_preset = payload.model_preset
        model_path: str | None = None
        model_arch: ModelArch | None = None
        if payload.realtime_transcription_engine == "moonshine":
            model_path, model_arch, resolved_preset = _resolve_model(
                payload.language, payload.model_preset, self.models_root
            )
        started_at = utc_now_iso()
        title = _format_session_title(started_at)
        self.context = SessionContext(
            session_id=f"session-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}",
            title=title,
            language=payload.language,
            realtime_transcription_engine=payload.realtime_transcription_engine,
            model_preset=resolved_preset,
            groq_transcription_model=payload.groq_transcription_model,
            browser_sample_rate=payload.browser_sample_rate,
            channels=payload.channels,
            device_label=payload.device_label,
            started_at=started_at,
        )
        self.labeler = SpeakerLabeler(payload.max_speakers)
        self.raw_audio = bytearray()
        self.segments = {}
        self.llm_revisions = {}
        self.llm_pending_line_ids = set()
        self.llm_requested_at = {}
        self._cancel_llm_tasks()
        self._cancel_groq_tasks()
        self.groq_processed_offset = 0
        self.groq_line_id = 0
        self.groq_error_reported = False
        self.moonshine_line_id_offset = 0
        self.moonshine_time_offset = 0.0
        self.recognition_stopped = False
        if payload.llm_settings is not None:
            self.llm_settings = payload.llm_settings

        self.paused = False
        if payload.realtime_transcription_engine == "moonshine":
            if model_path is None or model_arch is None:
                raise ValueError("Moonshine model could not be resolved.")
            self._start_moonshine_transcriber(model_path, model_arch)
        else:
            self.transcriber = None
            self.listener = None
        self.active = True
        if payload.realtime_transcription_engine == "groq":
            self._ensure_groq_worker()

        started_payload = {
            "type": "started",
            "payload": {
                "sessionId": self.context.session_id,
                "title": self.context.title,
                "createdAt": self.context.started_at,
                "language": self.context.language,
                "realtimeTranscriptionEngine": self.context.realtime_transcription_engine,
                "modelPreset": self.context.model_preset,
                "groqTranscriptionModel": self.context.groq_transcription_model,
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

    def update_llm_settings(self, settings: LlmSettings) -> None:
        self.llm_settings = settings
        if not settings.enabled or self.recognition_stopped:
            self._cancel_llm_tasks()
        self._put_nowait(
            {
                "type": "llm_settings_updated",
                "payload": settings.model_dump(by_alias=True),
            }
        )
        if settings.enabled and not self.recognition_stopped:
            for line_id, segment in list(self.segments.items()):
                if segment.text.strip() and (
                    not settings.complete_only or segment.is_complete
                ):
                    self._schedule_llm_refinement(line_id)

    def _moonshine_options(self) -> dict[str, str] | None:
        options: dict[str, str] = {}
        if self.enable_word_timestamps:
            options["word_timestamps"] = "true"
        return options or None

    def _start_moonshine_transcriber(
        self,
        model_path: str,
        model_arch: ModelArch,
    ) -> None:
        if self.transcriber is not None:
            self.transcriber.stop()
            self.transcriber.close()
        self.transcriber = Transcriber(
            model_path=model_path,
            model_arch=model_arch,
            update_interval=self.update_interval_ms / 1000.0,
            options=self._moonshine_options(),
        )
        self.listener = LiveSessionListener(self)
        self.transcriber.add_listener(self.listener)
        self.transcriber.start()

    def stop_recognition(self) -> None:
        if not self.active or self.recognition_stopped:
            return

        self.recognition_stopped = True
        pending_line_ids = set(self.llm_pending_line_ids)
        self._cancel_llm_tasks()
        self._cancel_groq_tasks()
        for line_id in pending_line_ids:
            segment = self.segments.get(line_id)
            if segment is None:
                continue
            segment.llm_status = "idle"
            segment.llm_error = None
            segment.llm_updated_at = utc_now_iso()
            self._publish_llm_segment("llm_refinement_updated", segment)

        if self.transcriber is not None:
            self.transcriber.stop()
            self.transcriber.close()
        self.transcriber = None
        self.listener = None
        self._put_nowait(
            {
                "type": "recognition_stopped",
                "payload": {"recordingOnly": True},
            }
        )

    def ingest_audio(self, frame_bytes: bytes) -> None:
        if not self.active or self.paused or self.context is None:
            return

        self.raw_audio.extend(frame_bytes)
        if self.recognition_stopped:
            return
        if self.context.realtime_transcription_engine == "groq":
            self._wake_groq_worker()
            return
        self._ingest_moonshine_audio(frame_bytes)

    def _ingest_moonshine_audio(self, frame_bytes: bytes) -> None:
        if self.context is None or self.transcriber is None:
            return
        pcm = np.frombuffer(frame_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.transcriber.add_audio(
            pcm.tolist(),
            sample_rate=self.context.browser_sample_rate,
        )

    def publish_line(self, event_type: str, line) -> None:
        if self.context is None or self.recognition_stopped:
            return

        effective_line_id = int(line.line_id) + self.moonshine_line_id_offset
        moonshine_index = line.speaker_index if bool(line.has_speaker_id) else None
        speaker_label, speaker_index, speaker_source = self.labeler.assign(
            effective_line_id,
            line.audio_data,
            16000,
            moonshine_index,
        )

        existing_segment = self.segments.get(effective_line_id)
        segment = TranscriptSegment(
            id=f"line-{effective_line_id}",
            lineId=effective_line_id,
            text=line.text,
            speakerLabel=speaker_label,
            speakerIndex=speaker_index,
            speakerSource=speaker_source,
            startedAt=round(float(line.start_time) + self.moonshine_time_offset, 3),
            duration=round(float(line.duration), 3),
            isComplete=bool(line.is_complete),
            latencyMs=int(line.last_transcription_latency_ms),
            updatedAt=utc_now_iso(),
            transcriptionModel=self._moonshine_transcription_model_label(),
            llmText=existing_segment.llm_text if existing_segment else None,
            llmStatus=existing_segment.llm_status if existing_segment else "idle",
            llmModel=existing_segment.llm_model if existing_segment else None,
            llmLatencyMs=existing_segment.llm_latency_ms if existing_segment else None,
            llmUpdatedAt=existing_segment.llm_updated_at if existing_segment else None,
            llmError=existing_segment.llm_error if existing_segment else None,
            llmBlockId=existing_segment.llm_block_id if existing_segment else None,
            llmBlockStartLineId=(
                existing_segment.llm_block_start_line_id if existing_segment else None
            ),
            llmBlockEndLineId=(
                existing_segment.llm_block_end_line_id if existing_segment else None
            ),
        )
        self.segments[effective_line_id] = segment
        self._put_nowait(
            {
                "type": event_type,
                "payload": segment.model_dump(by_alias=True),
            }
        )
        if event_type == "line_completed" or not self.llm_settings.complete_only:
            self._schedule_llm_refinement(effective_line_id)

    def publish_error(self, message: str) -> None:
        self._put_nowait({"type": "error", "payload": {"message": message}})

    def finalize(self) -> dict | None:
        if not self.active or self.context is None:
            return None

        if self.transcriber is not None:
            self.transcriber.stop()
            self.transcriber.close()
        self.transcriber = None
        self.listener = None

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
        if self.raw_audio:
            bytes_per_sample = 2
            raw_duration = len(self.raw_audio) / (
                self.context.browser_sample_rate * self.context.channels * bytes_per_sample
            )
            duration_seconds = max(duration_seconds, round(raw_duration, 3))

        derived_title = self.context.title
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
        self._cancel_groq_tasks()
        self._cancel_llm_tasks()
        return payload

    async def finalize_after_refinement(self) -> dict | None:
        if not self.active or self.context is None:
            return None
        await self._drain_groq_for_finalize()
        await self._drain_llm_for_finalize()
        return self.finalize()

    def shutdown(self) -> None:
        if not self.active:
            return
        self.finalize()
        self._cancel_groq_tasks()
        self._cancel_llm_tasks()

    def _put_nowait(self, payload: dict) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, payload)

    def _cancel_groq_tasks(self) -> None:
        future = self.groq_worker_future
        if future is not None and not future.done():
            future.cancel()
        self.groq_worker_future = None
        self._wake_groq_worker()

    def _ensure_groq_worker(self) -> None:
        if not self.active:
            return
        if self.groq_worker_future is None or self.groq_worker_future.done():
            self.groq_worker_future = asyncio.run_coroutine_threadsafe(
                self._groq_worker_loop(),
                self.loop,
            )
        self._wake_groq_worker()

    def _wake_groq_worker(self) -> None:
        self.loop.call_soon_threadsafe(self.groq_wake_event.set)

    def _bytes_per_second(self) -> int:
        if self.context is None:
            return 0
        return self.context.browser_sample_rate * self.context.channels * 2

    def _moonshine_transcription_model_label(self) -> str:
        if self.context is None:
            return "Moonshine"
        return f"Moonshine {self.context.model_preset}".strip()

    def _groq_transcription_model_label(self) -> str:
        if self.context is None:
            return "Groq"
        return f"Groq {self.context.groq_transcription_model}".strip()

    @staticmethod
    def _is_groq_rate_limit_error(exc: Exception) -> bool:
        return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429

    def _start_moonshine_fallback(self, start_offset: int, reason: str) -> bool:
        if self.context is None or self.recognition_stopped:
            return False

        try:
            model_path, model_arch, resolved_preset = _resolve_model(
                self.context.language,
                self.context.model_preset,
                self.models_root,
            )
        except Exception as exc:
            self.groq_error_reported = True
            self.publish_error(
                f"Groq transcription rate limit was reached, but Moonshine fallback failed: {exc}"
            )
            return False

        self.groq_worker_future = None
        self.context.realtime_transcription_engine = "moonshine"
        self.context.model_preset = resolved_preset
        self.moonshine_line_id_offset = max(self.segments.keys(), default=-1) + 1
        bytes_per_second = self._bytes_per_second()
        self.moonshine_time_offset = (
            start_offset / bytes_per_second if bytes_per_second else 0.0
        )
        self._start_moonshine_transcriber(model_path, model_arch)
        self._put_nowait(
            {
                "type": "transcription_engine_changed",
                "payload": {
                    "realtimeTranscriptionEngine": "moonshine",
                    "modelPreset": resolved_preset,
                    "transcriptionModel": self._moonshine_transcription_model_label(),
                    "reason": reason,
                },
            }
        )
        return True

    def _take_groq_chunk(
        self,
        *,
        final: bool,
    ) -> tuple[int, int, bytes] | None:
        if self.context is None:
            return None

        bytes_per_second = self._bytes_per_second()
        if bytes_per_second <= 0:
            return None

        available = len(self.raw_audio)
        pending = available - self.groq_processed_offset
        minimum_seconds = (
            GROQ_FINAL_FLUSH_MIN_SECONDS
            if final
            else max(GROQ_MIN_LIVE_CHUNK_SECONDS, self.update_interval_ms / 1000.0)
        )
        if pending < int(bytes_per_second * minimum_seconds):
            return None

        start_offset = self.groq_processed_offset
        end_offset = available
        self.groq_processed_offset = end_offset
        return start_offset, end_offset, bytes(self.raw_audio[start_offset:end_offset])

    async def _groq_worker_loop(self) -> None:
        try:
            while self.active and not self.recognition_stopped:
                if self.context is None or self.context.realtime_transcription_engine != "groq":
                    return
                if self.groq_error_reported:
                    return

                self.groq_wake_event.clear()
                chunk = self._take_groq_chunk(final=False)
                if chunk is None:
                    try:
                        await asyncio.wait_for(self.groq_wake_event.wait(), timeout=0.5)
                    except asyncio.TimeoutError:
                        pass
                    continue
                await self._transcribe_groq_chunk(*chunk)
        except asyncio.CancelledError:
            return

    async def _drain_groq_for_finalize(self) -> None:
        if (
            self.context is None
            or self.context.realtime_transcription_engine != "groq"
            or self.groq_error_reported
        ):
            return

        future = self.groq_worker_future
        if future is not None and not future.done():
            future.cancel()
        self.groq_worker_future = None

        chunk = self._take_groq_chunk(final=True)
        if chunk is not None:
            await self._transcribe_groq_chunk(*chunk)

    async def _transcribe_groq_chunk(
        self,
        start_offset: int,
        end_offset: int,
        frame_bytes: bytes,
    ) -> None:
        if self.context is None:
            return

        try:
            bytes_per_second = self._bytes_per_second()
            wav_bytes = pcm16_wav_bytes(
                frame_bytes,
                sample_rate=self.context.browser_sample_rate,
                channels=self.context.channels,
            )
            result = await GroqClient().transcribe_wav(
                wav_bytes=wav_bytes,
                filename=f"{self.context.session_id}-{self.groq_line_id}.wav",
                model=self.context.groq_transcription_model,
                language=self.context.language,
            )
        except asyncio.CancelledError:
            return
        except Exception as exc:
            if self._is_groq_rate_limit_error(exc):
                if self._start_moonshine_fallback(start_offset, str(exc)):
                    self._ingest_moonshine_audio(frame_bytes)
                return
            self.groq_error_reported = True
            self.publish_error(f"Groq transcription failed: {exc}")
            return

        text = result.text.strip()
        if not text:
            return

        previous_segment = self.segments.get(self.groq_line_id - 1)
        if previous_segment and self._too_similar(previous_segment.text, text):
            return

        line_id = self.groq_line_id
        self.groq_line_id += 1
        start_seconds = start_offset / bytes_per_second if bytes_per_second else 0.0
        duration_seconds = (
            (end_offset - start_offset) / bytes_per_second
            if bytes_per_second
            else 0.0
        )
        segment = TranscriptSegment(
            id=f"groq-line-{line_id}",
            lineId=line_id,
            text=text,
            speakerLabel="Audio",
            speakerIndex=0,
            speakerSource="groq",
            startedAt=round(start_seconds, 3),
            duration=round(duration_seconds, 3),
            isComplete=True,
            latencyMs=result.latency_ms,
            updatedAt=utc_now_iso(),
            transcriptionModel=self._groq_transcription_model_label(),
        )
        self.segments[line_id] = segment
        self._put_nowait(
            {
                "type": "line_completed",
                "payload": segment.model_dump(by_alias=True),
            }
        )
        self._schedule_llm_refinement(line_id)

    def _cancel_llm_tasks(self) -> None:
        self.llm_pending_line_ids.clear()
        self.llm_requested_at.clear()
        future = self.llm_worker_future
        if future is not None and not future.done():
            future.cancel()
        self.llm_worker_future = None
        self._wake_llm_worker()

    def _schedule_llm_refinement(self, line_id: int) -> None:
        settings = self.llm_settings
        segment = self.segments.get(line_id)
        if (
            not self.active
            or self.recognition_stopped
            or not refinement_enabled(settings)
            or segment is None
            or not segment.text.strip()
            or (settings.complete_only and not segment.is_complete)
        ):
            return

        pending_covering_line = next(
            (
                pending_line_id
                for pending_line_id in self.llm_pending_line_ids
                if pending_line_id <= line_id
                and line_id <= pending_line_id + settings.context_after_lines
            ),
            None,
        )
        if pending_covering_line is not None and pending_covering_line != line_id:
            return

        revision = self.llm_revisions.get(line_id, 0) + 1
        self.llm_revisions[line_id] = revision
        self.llm_pending_line_ids.add(line_id)
        self.llm_requested_at[line_id] = time.monotonic()

        segment.llm_status = "pending"
        segment.llm_model = settings.model
        segment.llm_updated_at = utc_now_iso()
        segment.llm_error = None
        self._publish_llm_segment("llm_refinement_started", segment)

        self._ensure_llm_worker()

    def _ensure_llm_worker(self) -> None:
        if not self.active:
            return
        if self.llm_worker_future is None or self.llm_worker_future.done():
            self.llm_worker_future = asyncio.run_coroutine_threadsafe(
                self._llm_worker_loop(),
                self.loop,
            )
        self._wake_llm_worker()

    def _wake_llm_worker(self) -> None:
        self.loop.call_soon_threadsafe(self.llm_wake_event.set)

    async def _drain_llm_for_finalize(self) -> None:
        settings = self.llm_settings.model_copy(deep=True)
        if not refinement_enabled(settings):
            return

        future = self.llm_worker_future
        if future is not None and not future.done():
            future.cancel()
        self.llm_worker_future = None

        now = time.monotonic()
        for line_id, segment in sorted(self.segments.items()):
            if not segment.text.strip():
                continue
            if (
                line_id not in self.llm_pending_line_ids
                and segment.llm_status == "complete"
                and segment.llm_text is not None
            ):
                continue
            self.llm_revisions[line_id] = self.llm_revisions.get(line_id, 0) + 1
            self.llm_pending_line_ids.add(line_id)
            self.llm_requested_at[line_id] = now
            segment.llm_status = "pending"
            segment.llm_model = settings.model
            segment.llm_updated_at = utc_now_iso()
            segment.llm_error = None
            self._publish_llm_segment("llm_refinement_started", segment)

        while self.active and self.llm_pending_line_ids:
            block_start_line_id = min(self.llm_pending_line_ids)
            revision = self.llm_revisions.get(block_start_line_id, 0)
            await self._refine_block(
                block_start_line_id,
                revision,
                settings,
            )

    async def _llm_worker_loop(self) -> None:
        try:
            while self.active:
                settings = self.llm_settings.model_copy(deep=True)
                if not refinement_enabled(settings):
                    return

                self.llm_wake_event.clear()
                block_start_line_id, wait_seconds = self._next_llm_work(settings)
                if block_start_line_id is None:
                    if wait_seconds is None:
                        await self.llm_wake_event.wait()
                    else:
                        try:
                            await asyncio.wait_for(
                                self.llm_wake_event.wait(),
                                timeout=max(0.0, wait_seconds),
                            )
                        except asyncio.TimeoutError:
                            pass
                    continue

                revision = self.llm_revisions.get(block_start_line_id, 0)
                await self._refine_block(
                    block_start_line_id,
                    revision,
                    settings,
                )
        except asyncio.CancelledError:
            return

    def _next_llm_work(self, settings: LlmSettings) -> tuple[int | None, float | None]:
        now = time.monotonic()
        for line_id in sorted(self.llm_pending_line_ids):
            segment = self.segments.get(line_id)
            if segment is None or not segment.text.strip():
                self.llm_pending_line_ids.discard(line_id)
                self.llm_requested_at.pop(line_id, None)
                continue

            if settings.complete_only and not segment.is_complete:
                return None, None

            requested_at = self.llm_requested_at.setdefault(line_id, now)
            debounce_delay = requested_at + (settings.debounce_ms / 1000) - now
            if debounce_delay > 0:
                return None, debounce_delay

            if not self._has_required_after_context(line_id, settings):
                timeout_delay = requested_at + (settings.max_wait_ms / 1000) - now
                if timeout_delay > 0:
                    return None, timeout_delay

            return line_id, None

        return None, None

    def _has_required_after_context(
        self,
        line_id: int,
        settings: LlmSettings,
    ) -> bool:
        required_after_lines = settings.context_after_lines
        if required_after_lines <= 0:
            return True

        ordered_segments = self._ordered_segments()
        current_index = self._segment_index(ordered_segments, line_id)
        if current_index is None:
            return False

        after_segments = ordered_segments[current_index + 1 :]
        available_after_lines = sum(
            1 for segment in after_segments if segment.text.strip()
        )
        return available_after_lines >= required_after_lines

    async def _refine_block(
        self,
        block_start_line_id: int,
        revision: int,
        settings: LlmSettings,
    ) -> None:
        try:
            if (
                not self.active
                or self.llm_revisions.get(block_start_line_id) != revision
            ):
                return

            target_segments = self._target_block_segments(block_start_line_id, settings)
            if not target_segments:
                self.llm_pending_line_ids.discard(block_start_line_id)
                return

            context = self._build_refinement_context(
                block_start_line_id,
                settings.context_before_lines,
                settings.context_after_lines,
            )
            result = await create_refinement_client(settings).refine(context)

            if (
                not self.active
                or self.llm_revisions.get(block_start_line_id) != revision
            ):
                return

            anchor_segment = self.segments.get(block_start_line_id)
            if anchor_segment is None:
                return

            covered_line_ids = {segment.line_id for segment in target_segments}
            block_end_line_id = max(covered_line_ids)
            block_id = f"llm-block-{block_start_line_id}-{block_end_line_id}"
            previous_texts = self._previous_refined_texts(block_start_line_id)
            refined_text = self._dedupe_refined_text(result.text, previous_texts)
            self.llm_pending_line_ids.difference_update(covered_line_ids)
            for segment in target_segments:
                segment.llm_status = "complete"
                segment.llm_model = settings.model
                segment.llm_latency_ms = result.latency_ms
                segment.llm_updated_at = utc_now_iso()
                segment.llm_error = None
                segment.llm_block_id = block_id
                segment.llm_block_start_line_id = block_start_line_id
                segment.llm_block_end_line_id = block_end_line_id
                segment.llm_text = (
                    refined_text if segment.line_id == block_start_line_id else ""
                )
                self.llm_requested_at.pop(segment.line_id, None)
                self._publish_llm_segment("llm_refinement_updated", segment)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            if (
                not self.active
                or self.llm_revisions.get(block_start_line_id) != revision
            ):
                return
            segment = self.segments.get(block_start_line_id)
            if segment is None:
                return
            segment.llm_status = "error"
            segment.llm_model = settings.model
            segment.llm_updated_at = utc_now_iso()
            segment.llm_error = str(exc)
            self.llm_pending_line_ids.discard(block_start_line_id)
            self.llm_requested_at.pop(block_start_line_id, None)
            self._publish_llm_segment("llm_refinement_error", segment)

    def _ordered_segments(self) -> list[TranscriptSegment]:
        return [
            self.segments[key] for key in sorted(self.segments, key=lambda item: item)
        ]

    @staticmethod
    def _segment_index(
        ordered_segments: list[TranscriptSegment],
        line_id: int,
    ) -> int | None:
        return next(
            (
                index
                for index, segment in enumerate(ordered_segments)
                if segment.line_id == line_id
            ),
            None,
        )

    def _build_refinement_context(
        self,
        block_start_line_id: int,
        context_before_lines: int,
        context_after_lines: int,
    ) -> str:
        ordered_segments = self._ordered_segments()
        current_index = self._segment_index(ordered_segments, block_start_line_id)
        if current_index is None:
            return "Refine only TARGET lines.\nTARGET: "

        end_index = min(len(ordered_segments), current_index + context_after_lines + 1)
        target_segments = ordered_segments[current_index:end_index]
        target_line_ids = {
            segment.line_id
            for segment in target_segments
            if segment.text.strip()
        }
        lines = []
        previous_texts = self._previous_refined_texts(
            block_start_line_id,
            limit=context_before_lines,
        )
        for index, text in enumerate(previous_texts, start=1):
            lines.append(f"PREVIOUS_REFINED {index}: {text}")
        for segment in target_segments:
            if segment.line_id not in target_line_ids:
                continue
            status = "complete" if segment.is_complete else "draft"
            lines.append(
                f"TARGET line={segment.line_id} status={status} "
                f"speaker={segment.speaker_label}: {segment.text}"
            )
        return (
            "Refine all TARGET lines into one coherent Japanese paragraph. "
            "Use PREVIOUS_REFINED only as context. Do not repeat it. "
            "Return exactly one paragraph containing only new TARGET content.\n"
            + "\n".join(lines)
        )

    def _previous_refined_texts(
        self,
        block_start_line_id: int,
        limit: int | None = None,
    ) -> list[str]:
        seen_block_ids: set[str] = set()
        texts: list[str] = []
        for segment in reversed(self._ordered_segments()):
            if segment.line_id >= block_start_line_id:
                continue
            text = (segment.llm_text or "").strip()
            if not text:
                continue
            block_id = segment.llm_block_id or f"line-{segment.line_id}"
            if block_id in seen_block_ids:
                continue
            seen_block_ids.add(block_id)
            texts.append(text)
            if limit is not None and len(texts) >= limit:
                break
        return list(reversed(texts))

    @staticmethod
    def _normalize_for_similarity(text: str) -> str:
        return re.sub(r"\s+", "", text).strip().lower()

    @classmethod
    def _too_similar(cls, left: str, right: str) -> bool:
        normalized_left = cls._normalize_for_similarity(left)
        normalized_right = cls._normalize_for_similarity(right)
        if not normalized_left or not normalized_right:
            return False
        if normalized_left in normalized_right or normalized_right in normalized_left:
            return True
        return SequenceMatcher(None, normalized_left, normalized_right).ratio() >= 0.9

    @classmethod
    def _dedupe_refined_text(cls, text: str, previous_texts: list[str]) -> str:
        candidate = text.strip()
        if not candidate:
            return candidate
        previous_sentences = [
            sentence
            for previous in previous_texts
            for sentence in re.split(r"(?<=[。！？!?])\s*|\n+", previous)
            if sentence.strip()
        ]
        next_sentences = [
            sentence.strip()
            for sentence in re.split(r"(?<=[。！？!?])\s*|\n+", candidate)
            if sentence.strip()
        ]
        filtered = [
            sentence
            for sentence in next_sentences
            if not any(cls._too_similar(sentence, previous) for previous in previous_sentences)
        ]
        if not filtered:
            return candidate
        return "".join(filtered)

    def _target_block_segments(
        self,
        block_start_line_id: int,
        settings: LlmSettings,
    ) -> list[TranscriptSegment]:
        ordered_segments = self._ordered_segments()
        current_index = self._segment_index(ordered_segments, block_start_line_id)
        if current_index is None:
            return []
        end_index = min(
            len(ordered_segments),
            current_index + settings.context_after_lines + 1,
        )
        return [
            segment
            for segment in ordered_segments[current_index:end_index]
            if segment.text.strip()
        ]

    def _publish_llm_segment(self, event_type: str, segment: TranscriptSegment) -> None:
        self._put_nowait(
            {
                "type": event_type,
                "payload": segment.model_dump(by_alias=True),
            }
        )
