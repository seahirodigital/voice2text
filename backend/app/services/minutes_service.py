from __future__ import annotations

import asyncio
import re
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from moonshine_voice import Transcriber

from app.models.schemas import LlmSettings, TranscriptionSettings, TranscriptSegment, utc_now_iso
from app.services.live_session import _resolve_model
from app.services.ollama_client import OllamaClient
from app.services.session_store import TARGET_RECORDING_SAMPLE_RATE, SessionStore

TIMELINE_BLOCK_SIZE = 6
MINUTES_SUMMARY_MODEL = "gemma4:e4b"
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
    model_path, model_arch, _ = _resolve_model(language, model_preset, models_root)
    transcript = _transcribe_audio(model_path, model_arch, audio)
    return _transcript_to_segments(transcript)


def _transcribe_batch_segments(
    *,
    models_root: Path,
    faster_whisper_models_root: Path,
    transcription_settings: TranscriptionSettings,
    audio: np.ndarray,
) -> list[TranscriptSegment]:
    if transcription_settings.batch_transcription_engine == "moonshine":
        return _transcribe_moonshine_segments(
            models_root=models_root,
            language=transcription_settings.language,
            model_preset=transcription_settings.batch_moonshine_model_preset,
            audio=audio,
        )

    return _transcribe_faster_whisper_audio(
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


def _minutes_summary_settings(llm_settings: LlmSettings) -> LlmSettings:
    return llm_settings.model_copy(update={"model": MINUTES_SUMMARY_MODEL})


async def create_minutes_for_session(
    *,
    store: SessionStore,
    models_root: Path,
    faster_whisper_models_root: Path,
    session_id: str,
    transcription_settings: TranscriptionSettings,
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
    segments = await asyncio.to_thread(
        _transcribe_batch_segments,
        models_root=models_root,
        faster_whisper_models_root=faster_whisper_models_root,
        transcription_settings=transcription_settings,
        audio=audio,
    )

    existing_segments = detail.segments
    refined_blocks = await _refine_timeline_blocks(llm_settings, segments)
    segments = _apply_refined_blocks_to_transcript_segments(segments, refined_blocks)
    segments = _preserve_realtime_llm_columns(segments, existing_segments)
    refined_timeline = _segments_to_timeline_text(segments)
    refined_body = "\n".join(segment.text for segment in segments if segment.text.strip())
    fallback_markdown = _append_timestamped_clean_transcript(
        _fallback_minutes_body(title=detail.title, body=refined_body),
        refined_timeline,
    )

    if not llm_settings.enabled or llm_settings.provider != "ollama":
        return fallback_markdown, segments, None

    summary_settings = _minutes_summary_settings(llm_settings)
    result = await OllamaClient(summary_settings).refine_minutes(
        title=detail.title,
        transcript=refined_timeline,
    )
    markdown = _append_timestamped_clean_transcript(
        result.text.strip()
        or _fallback_minutes_body(title=detail.title, body=refined_body),
        refined_timeline,
    )
    return markdown, segments, summary_settings.model
