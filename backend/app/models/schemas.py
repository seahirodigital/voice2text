from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProviderConfig(BaseModel):
    api_key: str = Field(default="", alias="apiKey")
    model: str = ""

    model_config = ConfigDict(populate_by_name=True)


class ProvidersConfig(BaseModel):
    openai: ProviderConfig = ProviderConfig()
    anthropic: ProviderConfig = ProviderConfig()


class ApiSettings(BaseModel):
    system_prompt: str = Field(default="", alias="systemPrompt")
    providers: ProvidersConfig = ProvidersConfig()

    model_config = ConfigDict(populate_by_name=True)


class PathSettings(BaseModel):
    models_root: str = Field(alias="modelsRoot")
    data_root: str = Field(alias="dataRoot")
    temp_recordings_root: str = Field(alias="tempRecordingsRoot")
    frontend_dist: str = Field(alias="frontendDist")

    model_config = ConfigDict(populate_by_name=True)


class TranscriptionSettings(BaseModel):
    language: str = "ja"
    model_preset: str = Field(default="tiny", alias="modelPreset")
    max_speakers: int = Field(default=3, alias="maxSpeakers", ge=1, le=3)
    update_interval_ms: int = Field(
        default=400, alias="updateIntervalMs", ge=100, le=5000
    )
    enable_word_timestamps: bool = Field(
        default=False, alias="enableWordTimestamps"
    )

    model_config = ConfigDict(populate_by_name=True)


class AppSettings(BaseModel):
    paths: PathSettings
    transcription: TranscriptionSettings
    api_settings: ApiSettings = Field(alias="apiSettings")

    model_config = ConfigDict(populate_by_name=True)


class ResolvedPaths(BaseModel):
    config_path: str = Field(alias="configPath")
    repo_root: str = Field(alias="repoRoot")
    models_root: str = Field(alias="modelsRoot")
    data_root: str = Field(alias="dataRoot")
    sessions_root: str = Field(alias="sessionsRoot")
    temp_recordings_root: str = Field(alias="tempRecordingsRoot")
    frontend_dist: str = Field(alias="frontendDist")

    model_config = ConfigDict(populate_by_name=True)


class SettingsResponse(BaseModel):
    settings: AppSettings
    resolved_paths: ResolvedPaths = Field(alias="resolvedPaths")

    model_config = ConfigDict(populate_by_name=True)


class TranscriptSegment(BaseModel):
    id: str
    line_id: int = Field(alias="lineId")
    text: str
    speaker_label: str = Field(alias="speakerLabel")
    speaker_index: int = Field(alias="speakerIndex")
    speaker_source: Literal["moonshine", "feature-fallback", "carry-forward"] = Field(
        alias="speakerSource"
    )
    started_at: float = Field(alias="startedAt")
    duration: float
    is_complete: bool = Field(alias="isComplete")
    latency_ms: int = Field(alias="latencyMs")
    updated_at: str = Field(alias="updatedAt")

    model_config = ConfigDict(populate_by_name=True)


class SessionSummary(BaseModel):
    id: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    language: str
    device_label: str = Field(alias="deviceLabel")
    duration_seconds: float = Field(alias="durationSeconds")
    line_count: int = Field(alias="lineCount")
    title: str
    audio_url: str | None = Field(default=None, alias="audioUrl")

    model_config = ConfigDict(populate_by_name=True)


class SessionDetail(SessionSummary):
    segments: list[TranscriptSegment]


class TranscriptUpdatePayload(BaseModel):
    segments: list[TranscriptSegment]


class MetaResponse(BaseModel):
    supported_languages: list[str] = Field(alias="supportedLanguages")
    available_models_by_language: dict[str, list[str]] = Field(
        alias="availableModelsByLanguage"
    )
    default_language: str = Field(alias="defaultLanguage")
    default_model_preset: str = Field(alias="defaultModelPreset")

    model_config = ConfigDict(populate_by_name=True)


class StartSessionPayload(BaseModel):
    language: str = "ja"
    model_preset: str = Field(default="tiny", alias="modelPreset")
    browser_sample_rate: int = Field(alias="browserSampleRate", ge=8000, le=96000)
    channels: int = Field(default=1, ge=1, le=2)
    device_label: str = Field(default="Default Microphone", alias="deviceLabel")
    max_speakers: int = Field(default=3, alias="maxSpeakers", ge=1, le=3)

    model_config = ConfigDict(populate_by_name=True)


class WebSocketEnvelope(BaseModel):
    type: str
    payload: dict = Field(default_factory=dict)


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
