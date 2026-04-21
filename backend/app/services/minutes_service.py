from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from moonshine_voice import Transcriber

from app.models.schemas import LlmSettings, TranscriptSegment, utc_now_iso
from app.services.live_session import _resolve_model
from app.services.ollama_client import OllamaClient
from app.services.session_store import TARGET_RECORDING_SAMPLE_RATE, SessionStore

TIMELINE_BLOCK_SIZE = 6


def _load_recording_audio(audio_path: Path) -> np.ndarray:
    audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
    if audio.size == 0:
        return np.zeros(1, dtype=np.float32)

    mono = audio.mean(axis=1)
    if sample_rate != TARGET_RECORDING_SAMPLE_RATE:
        mono = resample_poly(mono, TARGET_RECORDING_SAMPLE_RATE, sample_rate)
    return np.clip(mono.astype(np.float32), -1.0, 1.0)


def _transcript_to_segments(transcript) -> list[TranscriptSegment]:
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
    return (
        f"# {title}\n\n"
        "## Refined Transcript\n\n"
        f"{body.strip() or 'No transcript was produced.'}\n\n"
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


def _plain_refined_body(refined_blocks: list[str]) -> str:
    lines = []
    for block in refined_blocks:
        for line in block.splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            cleaned = cleaned.split("]", 1)[-1].strip() if "]" in cleaned else cleaned
            if cleaned:
                lines.append(cleaned)
    return "\n".join(lines)


def _apply_refined_blocks_to_segments(
    segments: list[TranscriptSegment],
    refined_blocks: list[str],
    model: str | None,
) -> list[TranscriptSegment]:
    chunks = _blocks(segments, TIMELINE_BLOCK_SIZE)
    now = utc_now_iso()
    for chunk, refined_text in zip(chunks, refined_blocks):
        if not chunk:
            continue
        start_line_id = chunk[0].line_id
        end_line_id = chunk[-1].line_id
        block_id = f"minutes-block-{start_line_id}-{end_line_id}"
        for segment in chunk:
            segment.llm_status = "complete"
            segment.llm_text = refined_text if segment.line_id == start_line_id else ""
            segment.llm_model = model
            segment.llm_latency_ms = None
            segment.llm_updated_at = now
            segment.llm_error = None
            segment.llm_block_id = block_id
            segment.llm_block_start_line_id = start_line_id
            segment.llm_block_end_line_id = end_line_id
    return segments


async def _refine_timeline_blocks(
    llm_settings: LlmSettings,
    segments: list[TranscriptSegment],
) -> list[str]:
    if not llm_settings.enabled or llm_settings.provider != "ollama":
        return [_block_to_timeline_text(block) for block in _blocks(segments, TIMELINE_BLOCK_SIZE)]

    client = OllamaClient(llm_settings)
    refined_blocks: list[str] = []
    for block in _blocks(segments, TIMELINE_BLOCK_SIZE):
        target = _block_to_timeline_text(block)
        previous = "\n\n".join(refined_blocks[-2:])
        result = await client.refine_timeline_block(previous=previous, target=target)
        refined_blocks.append(result.text.strip() or target)
    return refined_blocks


async def create_minutes_for_session(
    *,
    store: SessionStore,
    models_root: Path,
    session_id: str,
    language: str,
    model_preset: str,
    llm_settings: LlmSettings,
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
    model_path, model_arch, _ = _resolve_model(language, model_preset, models_root)
    transcript = await asyncio.to_thread(_transcribe_audio, model_path, model_arch, audio)

    segments = _transcript_to_segments(transcript)
    refined_blocks = await _refine_timeline_blocks(llm_settings, segments)
    model = llm_settings.model if llm_settings.enabled else None
    segments = _apply_refined_blocks_to_segments(segments, refined_blocks, model)
    refined_timeline = "\n\n".join(refined_blocks)
    refined_body = _plain_refined_body(refined_blocks)
    fallback_markdown = (
        f"# {detail.title}\n\n"
        "## Refined Transcript\n\n"
        f"{refined_body.strip() or 'No transcript was produced.'}\n\n"
        "## Timestamped Clean Transcript\n\n"
        f"{refined_timeline.strip() or '- No data.'}\n"
    )

    if not llm_settings.enabled or llm_settings.provider != "ollama":
        return fallback_markdown, segments, None

    result = await OllamaClient(llm_settings).refine_minutes(
        title=detail.title,
        transcript=refined_timeline,
    )
    markdown = result.text.strip() or fallback_markdown
    return markdown, segments, model
