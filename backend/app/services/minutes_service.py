from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from moonshine_voice import Transcriber

from app.models.schemas import (
    LlmSettings,
    TranscriptionSettings,
    TranscriptSegment,
    utc_now_iso,
)
from app.services.groq_client import (
    GroqClient,
    GroqTranscriptionResult,
    pcm16_wav_bytes,
)
from app.services.live_session import _resolve_model
from app.services.refinement_client import create_refinement_client, refinement_enabled
from app.services.session_store import TARGET_RECORDING_SAMPLE_RATE, SessionStore

TIMELINE_BLOCK_SIZE = 6
OLLAMA_MINUTES_SUMMARY_MODEL = "gemma4:e4b"
TIMESTAMPED_LINE_RE = re.compile(
    r"^\s*(?:\[(?P<bracket>\d{2}:\d{2}:\d{2})\]|"
    r"(?P<plain>\d{2}:\d{2}:\d{2}))\s*(?P<text>.+?)\s*$"
)
TIMESTAMPED_ARTIFACT_RE = re.compile(r"(?m)^\s*\[\d{2}:\d{2}:\d{2}\]")


def _load_recording_audio(audio_path: Path) -> np.ndarray:
    audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
    if audio.size == 0:
        return np.zeros(1, dtype=np.float32)

    mono = audio.mean(axis=1)
    if sample_rate != TARGET_RECORDING_SAMPLE_RATE:
        mono = resample_poly(mono, TARGET_RECORDING_SAMPLE_RATE, sample_rate)
    return np.clip(mono.astype(np.float32), -1.0, 1.0)


def _transcript_to_segments(
    transcript,
    *,
    transcription_model: str | None = None,
) -> list[TranscriptSegment]:
    segments: list[TranscriptSegment] = []
    now = utc_now_iso()
    for index, line in enumerate(getattr(transcript, "lines", [])):
        text = str(getattr(line, "text", "") or "").strip()
        if not text:
            continue
        line_id = int(getattr(line, "line_id", index))
        segments.append(
            TranscriptSegment(
                id=f"minutes-line-{line_id}",
                lineId=line_id,
                text=text,
                speakerLabel="Audio",
                speakerIndex=0,
                speakerSource="moonshine",
                startedAt=round(float(getattr(line, "start_time", 0.0)), 3),
                duration=round(float(getattr(line, "duration", 0.0)), 3),
                isComplete=True,
                latencyMs=int(getattr(line, "last_transcription_latency_ms", 0)),
                updatedAt=now,
                transcriptionModel=transcription_model,
            )
        )
    return segments


def _transcribe_audio(model_path: str, model_arch, audio: np.ndarray):
    transcriber = Transcriber(model_path=model_path, model_arch=model_arch)
    try:
        return transcriber.transcribe_without_streaming(
            audio.tolist(),
            sample_rate=TARGET_RECORDING_SAMPLE_RATE,
        )
    finally:
        transcriber.close()


def _transcribe_faster_whisper_audio(
    *,
    model_name: str,
    models_root: Path,
    language: str,
    audio: np.ndarray,
) -> list[TranscriptSegment]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ValueError(
            "faster-whisper is not installed. Run setup.bat to install it locally."
        ) from exc

    models_root.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(models_root),
    )
    transcribed_segments, _info = model.transcribe(
        audio,
        language=language,
        vad_filter=False,
        word_timestamps=False,
    )

    now = utc_now_iso()
    segments: list[TranscriptSegment] = []
    for index, segment in enumerate(transcribed_segments):
        text = str(getattr(segment, "text", "") or "").strip()
        if not text:
            continue
        start = float(getattr(segment, "start", 0.0) or 0.0)
        end = float(getattr(segment, "end", start) or start)
        segments.append(
            TranscriptSegment(
                id=f"faster-whisper-line-{index}",
                lineId=index,
                text=text,
                speakerLabel="Audio",
                speakerIndex=0,
                speakerSource="faster-whisper",
                startedAt=round(start, 3),
                duration=round(max(0.0, end - start), 3),
                isComplete=True,
                latencyMs=0,
                updatedAt=now,
                transcriptionModel=f"Faster Whisper {model_name}",
            )
        )
    return segments


def _transcribe_moonshine_segments(
    *,
    models_root: Path,
    language: str,
    model_preset: str,
    audio: np.ndarray,
) -> list[TranscriptSegment]:
    model_path, model_arch, resolved_preset = _resolve_model(
        language,
        model_preset,
        models_root,
    )
    transcript = _transcribe_audio(model_path, model_arch, audio)
    return _transcript_to_segments(
        transcript,
        transcription_model=f"Moonshine {resolved_preset}",
    )


def _audio_to_wav_bytes(audio: np.ndarray) -> bytes:
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    return pcm16_wav_bytes(
        pcm16.tobytes(),
        sample_rate=TARGET_RECORDING_SAMPLE_RATE,
        channels=1,
    )


def _groq_transcription_to_segments(
    result: GroqTranscriptionResult,
    *,
    model_name: str,
    audio_duration_seconds: float,
) -> list[TranscriptSegment]:
    now = utc_now_iso()
    segments: list[TranscriptSegment] = []
    source_segments = result.segments
    if source_segments:
        for index, segment in enumerate(source_segments):
            duration = max(0.0, segment.end - segment.start)
            segments.append(
                TranscriptSegment(
                    id=f"groq-line-{index}",
                    lineId=index,
                    text=segment.text,
                    speakerLabel="Audio",
                    speakerIndex=0,
                    speakerSource="groq",
                    startedAt=round(segment.start, 3),
                    duration=round(duration, 3),
                    isComplete=True,
                    latencyMs=result.latency_ms,
                    updatedAt=now,
                    transcriptionModel=f"Groq {model_name}",
                )
            )
        return segments

    text = result.text.strip()
    if not text:
        return []
    return [
        TranscriptSegment(
            id="groq-line-0",
            lineId=0,
            text=text,
            speakerLabel="Audio",
            speakerIndex=0,
            speakerSource="groq",
            startedAt=0.0,
            duration=round(max(0.0, audio_duration_seconds), 3),
            isComplete=True,
            latencyMs=result.latency_ms,
            updatedAt=now,
            transcriptionModel=f"Groq {model_name}",
        )
    ]


async def _transcribe_groq_segments(
    *,
    transcription_settings: TranscriptionSettings,
    audio: np.ndarray,
) -> list[TranscriptSegment]:
    model_name = transcription_settings.batch_groq_transcription_model
    result = await GroqClient().transcribe_wav(
        wav_bytes=_audio_to_wav_bytes(audio),
        filename="batch-transcription.wav",
        model=model_name,
        language=transcription_settings.language,
        response_format="verbose_json",
        timestamp_granularities=["segment"],
        audio_seconds=len(audio) / TARGET_RECORDING_SAMPLE_RATE,
        timeout_seconds=300.0,
    )
    return _groq_transcription_to_segments(
        result,
        model_name=model_name,
        audio_duration_seconds=len(audio) / TARGET_RECORDING_SAMPLE_RATE,
    )


async def _transcribe_batch_segments(
    *,
    models_root: Path,
    faster_whisper_models_root: Path,
    transcription_settings: TranscriptionSettings,
    audio: np.ndarray,
) -> list[TranscriptSegment]:
    if transcription_settings.batch_transcription_engine == "moonshine":
        return await asyncio.to_thread(
            _transcribe_moonshine_segments,
            models_root=models_root,
            language=transcription_settings.language,
            model_preset=transcription_settings.batch_moonshine_model_preset,
            audio=audio,
        )

    if transcription_settings.batch_transcription_engine == "groq":
        return await _transcribe_groq_segments(
            transcription_settings=transcription_settings,
            audio=audio,
        )

    return await asyncio.to_thread(
        _transcribe_faster_whisper_audio,
        model_name=transcription_settings.faster_whisper_model,
        models_root=faster_whisper_models_root,
        language=transcription_settings.language,
        audio=audio,
    )


def _segments_to_timeline_text(segments: list[TranscriptSegment]) -> str:
    lines = []
    for segment in sorted(segments, key=lambda item: item.started_at):
        lines.append(f"[{_format_timestamp(segment.started_at)}] {segment.text}")
    return "\n".join(lines)


def _format_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _fallback_minutes_markdown(title: str, segments: list[TranscriptSegment]) -> str:
    body = "\n".join(segment.text for segment in segments if segment.text.strip())
    timeline = _segments_to_timeline_text(segments)
    return _append_timestamped_clean_transcript(
        _fallback_minutes_body(title=title, body=body),
        timeline,
    )


def _fallback_minutes_body(*, title: str, body: str) -> str:
    content = body.strip() or "No transcript was produced."
    return (
        f"# {title}\n\n"
        "## Summary\n\n"
        f"{content}\n\n"
        "## Key Points\n\n"
        "- Not generated.\n\n"
        "## Details\n\n"
        f"{content}\n\n"
        "## Action Items\n\n"
        "- None"
    )


def _append_timestamped_clean_transcript(markdown: str, timeline: str) -> str:
    body = re.split(
        r"(?im)^##\s+Timestamped Clean Transcript\s*$",
        markdown.strip(),
        maxsplit=1,
    )[0].strip()
    return (
        f"{body}\n\n"
        "## Timestamped Clean Transcript\n\n"
        f"{timeline.strip() or '- No data.'}\n"
    )


def _blocks(segments: list[TranscriptSegment], size: int) -> list[list[TranscriptSegment]]:
    return [segments[index : index + size] for index in range(0, len(segments), size)]


def _block_to_timeline_text(segments: list[TranscriptSegment]) -> str:
    return "\n".join(
        f"[{_format_timestamp(segment.started_at)}] {segment.text}"
        for segment in segments
        if segment.text.strip()
    )


def _extract_refined_timeline_texts(refined_text: str) -> list[str]:
    texts: list[str] = []
    for line in refined_text.splitlines():
        cleaned = line.strip()
        if not cleaned:
            continue
        match = TIMESTAMPED_LINE_RE.match(cleaned)
        texts.append((match.group("text") if match else cleaned).strip())
    return [text for text in texts if text]


def _apply_refined_blocks_to_transcript_segments(
    segments: list[TranscriptSegment],
    refined_blocks: list[str],
) -> list[TranscriptSegment]:
    chunks = _blocks(segments, TIMELINE_BLOCK_SIZE)
    now = utc_now_iso()
    for chunk, refined_text in zip(chunks, refined_blocks):
        refined_lines = _extract_refined_timeline_texts(refined_text)
        for index, segment in enumerate(chunk):
            if index < len(refined_lines):
                segment.text = refined_lines[index]
            segment.updated_at = now
    return segments


def _is_batch_llm_artifact(segment: TranscriptSegment) -> bool:
    block_id = segment.llm_block_id or ""
    if block_id.startswith("minutes-block-"):
        return True
    return bool(segment.llm_text and TIMESTAMPED_ARTIFACT_RE.search(segment.llm_text))


def _preserve_realtime_llm_columns(
    segments: list[TranscriptSegment],
    existing_segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    for index, segment in enumerate(segments):
        if index >= len(existing_segments):
            continue
        existing = existing_segments[index]
        if _is_batch_llm_artifact(existing):
            continue
        segment.llm_text = existing.llm_text
        segment.llm_status = existing.llm_status
        segment.llm_model = existing.llm_model
        segment.llm_latency_ms = existing.llm_latency_ms
        segment.llm_updated_at = existing.llm_updated_at
        segment.llm_error = existing.llm_error
        segment.llm_block_id = existing.llm_block_id
        segment.llm_block_start_line_id = existing.llm_block_start_line_id
        segment.llm_block_end_line_id = existing.llm_block_end_line_id
    return segments


async def _refine_timeline_blocks(
    llm_settings: LlmSettings,
    segments: list[TranscriptSegment],
    *,
    progress_callback: Callable[[int], None] | None = None,
    progress_start: int = 45,
    progress_end: int = 80,
) -> list[str]:
    if not refinement_enabled(llm_settings):
        if progress_callback is not None:
            progress_callback(progress_end)
        return [
            _block_to_timeline_text(block)
            for block in _blocks(segments, TIMELINE_BLOCK_SIZE)
        ]

    client = create_refinement_client(llm_settings)
    refined_blocks: list[str] = []
    blocks = _blocks(segments, TIMELINE_BLOCK_SIZE)
    if not blocks:
        if progress_callback is not None:
            progress_callback(progress_end)
        return []

    for index, block in enumerate(blocks, start=1):
        target = _block_to_timeline_text(block)
        previous = "\n\n".join(refined_blocks[-2:])
        result = await client.refine_timeline_block(previous=previous, target=target)
        refined_blocks.append(result.text.strip() or target)
        if progress_callback is not None:
            span = max(0, progress_end - progress_start)
            progress_callback(progress_start + round((index / len(blocks)) * span))
    return refined_blocks


def _batch_summary_llm_settings(llm_settings: LlmSettings) -> LlmSettings:
    return llm_settings.model_copy(
        update={
            "provider": llm_settings.batch_summary_provider,
            "model": llm_settings.batch_summary_model,
        }
    )


def get_minutes_summary_model(llm_settings: LlmSettings) -> str | None:
    if not refinement_enabled(llm_settings):
        return None
    return _batch_summary_llm_settings(llm_settings).model


async def create_minutes_for_session(
    *,
    store: SessionStore,
    models_root: Path,
    faster_whisper_models_root: Path,
    session_id: str,
    transcription_settings: TranscriptionSettings,
    llm_settings: LlmSettings,
    progress_callback: Callable[[int], None] | None = None,
) -> tuple[str, list[TranscriptSegment], str | None]:
    detail = store.get_session(session_id)
    if detail is None:
        raise ValueError("Session not found.")
    if not detail.audio_url:
        raise ValueError("Recording audio is not available for this session.")

    audio_path = store.recordings_root / Path(detail.audio_url).name
    if not audio_path.exists():
        raise ValueError("Recording audio file was not found.")

    audio = _load_recording_audio(audio_path)
    if progress_callback is not None:
        progress_callback(10)
    segments = await _transcribe_batch_segments(
        models_root=models_root,
        faster_whisper_models_root=faster_whisper_models_root,
        transcription_settings=transcription_settings,
        audio=audio,
    )
    if progress_callback is not None:
        progress_callback(40)

    if progress_callback is not None:
        progress_callback(80)

    segments = _preserve_realtime_llm_columns(segments, detail.segments)
    refined_timeline = _segments_to_timeline_text(segments)
    refined_body = "\n".join(segment.text for segment in segments if segment.text.strip())
    fallback_markdown = _append_timestamped_clean_transcript(
        _fallback_minutes_body(title=detail.title, body=refined_body),
        refined_timeline,
    )

    if not refinement_enabled(llm_settings):
        if progress_callback is not None:
            progress_callback(100)
        return fallback_markdown, segments, None

    summary_settings = _batch_summary_llm_settings(llm_settings)
    if progress_callback is not None:
        progress_callback(88)
    result = await create_refinement_client(summary_settings).refine_minutes(
        title=detail.title,
        transcript=refined_timeline,
    )
    if progress_callback is not None:
        progress_callback(98)
    markdown = _append_timestamped_clean_transcript(
        result.text.strip()
        or _fallback_minutes_body(title=detail.title, body=refined_body),
        refined_timeline,
    )
    return markdown, segments, summary_settings.model
