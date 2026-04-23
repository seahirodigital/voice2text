from __future__ import annotations

from pathlib import Path

from app.config import _deep_merge, _expand_path
from app.models.schemas import TranscriptionSettings
from app.services.groq_client import GroqClient
from app.services.settings_service import BATCH_TRANSCRIPTION_ENGINES


def test_deep_merge_keeps_nested_defaults():
    merged = _deep_merge(
        {"outer": {"a": 1, "b": 2}, "other": 3},
        {"outer": {"b": 9}},
    )
    assert merged == {"outer": {"a": 1, "b": 9}, "other": 3}


def test_expand_path_resolves_repo_relative_path():
    resolved = _expand_path("frontend/dist")
    assert isinstance(resolved, Path)
    assert str(resolved).endswith(str(Path("frontend") / "dist"))


def test_batch_transcription_accepts_groq_engine():
    settings = TranscriptionSettings.model_validate(
        {
            "batchTranscriptionEngine": "groq",
            "batchGroqTranscriptionModel": "whisper-large-v3",
        }
    )

    assert "groq" in BATCH_TRANSCRIPTION_ENGINES
    assert settings.batch_transcription_engine == "groq"
    assert settings.batch_groq_transcription_model == "whisper-large-v3"


def test_groq_verbose_transcription_segments_are_parsed():
    segments = GroqClient._extract_transcription_segments(
        {
            "text": "hello world",
            "segments": [
                {"text": " hello", "start": 1.25, "end": 2.5},
                {"text": "", "start": 3.0, "end": 4.0},
            ],
        }
    )

    assert len(segments) == 1
    assert segments[0].text == "hello"
    assert segments[0].start == 1.25
    assert segments[0].end == 2.5
