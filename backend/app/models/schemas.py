from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.prompt_defaults import (
    DEFAULT_PROMPT_CONTENT,
    DEFAULT_PROMPT_ID,
    DEFAULT_PROMPT_NAME,
)


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


class LlmSettings(BaseModel):
    enabled: bool = True
    provider: Literal["ollama"] = "ollama"
    base_url: str = Field(default="http://localhost:11434", alias="baseUrl")
    model: str = "gemma4:e2b"
    context_lines: int = Field(default=3, alias="contextLines", ge=1, le=20)
    context_before_lines: int = Field(
        default=3, alias="contextBeforeLines", ge=0, le=20
    )
    context_after_lines: int = Field(default=3, alias="contextAfterLines", ge=0, le=10)
    debounce_ms: int = Field(default=5000, alias="debounceMs", ge=0, le=10000)
    max_wait_ms: int = Field(default=5000, alias="maxWaitMs", ge=0, le=30000)
    complete_only: bool = Field(default=True, alias="completeOnly")
    system_prompt: str = Field(default="", alias="systemPrompt")

    model_config = ConfigDict(populate_by_name=True)


class PromptPreset(BaseModel):
    id: str = DEFAULT_PROMPT_ID
    name: str = DEFAULT_PROMPT_NAME
    content: str = DEFAULT_PROMPT_CONTENT


class PromptSettings(BaseModel):
    active_prompt_id: str = Field(default=DEFAULT_PROMPT_ID, alias="activePromptId")
    prompts: list[PromptPreset] = Field(default_factory=lambda: [PromptPreset()])

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def ensure_active_prompt(self) -> "PromptSettings":
        if not self.prompts:
            self.prompts = [PromptPreset()]
        prompt_ids = {prompt.id for prompt in self.prompts}
        if self.active_prompt_id not in prompt_ids:
            self.active_prompt_id = self.prompts[0].id
        return self


class PathSettings(BaseModel):
    models_root: str = Field(alias="modelsRoot")
    faster_whisper_models_root: str = Field(
        default=r"%LOCALAPPDATA%\Voice2Text\faster_whisper_models",
        alias="fasterWhisperModelsRoot",
    )
    data_root: str = Field(alias="dataRoot")
    temp_recordings_root: str = Field(alias="tempRecordingsRoot")
    frontend_dist: str = Field(alias="frontendDist")

    model_config = ConfigDict(populate_by_name=True)


class TranscriptionSettings(BaseModel):
    language: str = "ja"
    model_preset: str = Field(default="base", alias="modelPreset")
    batch_transcription_engine: Literal["faster-whisper", "moonshine"] = Field(
        default="faster-whisper", alias="batchTranscriptionEngine"
    )
    batch_moonshine_model_preset: str = Field(
        default="base", alias="batchMoonshineModelPreset"
    )
    faster_whisper_model: str = Field(default="small", alias="fasterWhisperModel")
    max_speakers: int = Field(default=3, alias="maxSpeakers", ge=1, le=3)
    update_interval_ms: int = Field(
        default=5000, alias="updateIntervalMs", ge=100, le=5000
    )
    enable_word_timestamps: bool = Field(
        default=False, alias="enableWordTimestamps"
    )

    model_config = ConfigDict(populate_by_name=True)


class AppSettings(BaseModel):
    paths: PathSettings
    transcription: TranscriptionSettings
    api_settings: ApiSettings = Field(alias="apiSettings")
    llm: LlmSettings = LlmSettings()
    prompt_settings: PromptSettings = Field(
        default_factory=PromptSettings,
        alias="promptSettings",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResolvedPaths(BaseModel):
    config_path: str = Field(alias="configPath")
    repo_root: str = Field(alias="repoRoot")
    models_root: str = Field(alias="modelsRoot")
    faster_whisper_models_root: str = Field(alias="fasterWhisperModelsRoot")
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
    speaker_source: Literal[
        "moonshine", "faster-whisper", "feature-fallback", "carry-forward"
    ] = Field(alias="speakerSource")
    started_at: float = Field(alias="startedAt")
    duration: float
    is_complete: bool = Field(alias="isComplete")
    latency_ms: int = Field(alias="latencyMs")
    updated_at: str = Field(alias="updatedAt")
    llm_text: str | None = Field(default=None, alias="llmText")
    llm_status: Literal["idle", "pending", "complete", "error"] = Field(
        default="idle", alias="llmStatus"
    )
    llm_model: str | None = Field(default=None, alias="llmModel")
    llm_latency_ms: int | None = Field(default=None, alias="llmLatencyMs")
    llm_updated_at: str | None = Field(default=None, alias="llmUpdatedAt")
    llm_error: str | None = Field(default=None, alias="llmError")
    llm_block_id: str | None = Field(default=None, alias="llmBlockId")
    llm_block_start_line_id: int | None = Field(
        default=None, alias="llmBlockStartLineId"
    )
    llm_block_end_line_id: int | None = Field(default=None, alias="llmBlockEndLineId")

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
    title_locked: bool = Field(default=False, alias="titleLocked")
    audio_url: str | None = Field(default=None, alias="audioUrl")
    minutes_status: Literal["idle", "processing", "complete", "error"] = Field(
        default="idle", alias="minutesStatus"
    )
    minutes_progress: int = Field(default=0, alias="minutesProgress", ge=0, le=100)
    minutes_updated_at: str | None = Field(default=None, alias="minutesUpdatedAt")
    minutes_model: str | None = Field(default=None, alias="minutesModel")
    minutes_error: str | None = Field(default=None, alias="minutesError")

    model_config = ConfigDict(populate_by_name=True)


class SessionDetail(SessionSummary):
    segments: list[TranscriptSegment]
    minutes_markdown: str | None = Field(default=None, alias="minutesMarkdown")
    minutes_segments: list[TranscriptSegment] = Field(
        default_factory=list, alias="minutesSegments"
    )


class TranscriptUpdatePayload(BaseModel):
    segments: list[TranscriptSegment]
    title: str | None = Field(default=None, min_length=1, max_length=120)


class MinutesUpdatePayload(BaseModel):
    minutes_markdown: str = Field(default="", alias="minutesMarkdown")

    model_config = ConfigDict(populate_by_name=True)


class SessionTitleUpdatePayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class MetaResponse(BaseModel):
    supported_languages: list[str] = Field(alias="supportedLanguages")
    available_models_by_language: dict[str, list[str]] = Field(
        alias="availableModelsByLanguage"
    )
    batch_transcription_engines: list[str] = Field(alias="batchTranscriptionEngines")
    faster_whisper_models: list[str] = Field(alias="fasterWhisperModels")
    default_language: str = Field(alias="defaultLanguage")
    default_model_preset: str = Field(alias="defaultModelPreset")

    model_config = ConfigDict(populate_by_name=True)


class StartSessionPayload(BaseModel):
    language: str = "ja"
    model_preset: str = Field(default="base", alias="modelPreset")
    browser_sample_rate: int = Field(alias="browserSampleRate", ge=8000, le=96000)
    channels: int = Field(default=1, ge=1, le=2)
    device_label: str = Field(default="Default Microphone", alias="deviceLabel")
    max_speakers: int = Field(default=3, alias="maxSpeakers", ge=1, le=3)
    llm_settings: LlmSettings | None = Field(default=None, alias="llm")

    model_config = ConfigDict(populate_by_name=True)


class WebSocketEnvelope(BaseModel):
    type: str
    payload: dict = Field(default_factory=dict)


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
