from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil

from moonshine_voice import ModelArch, supported_languages
from moonshine_voice.download import find_model_info

from app.config import REPO_ROOT, load_settings, resolve_paths, save_settings
from app.models.schemas import AppSettings, LlmSettings, MetaResponse, SettingsResponse
from app.services.prompt_template_service import PromptTemplateService


MODEL_PRESET_CANDIDATES: dict[str, list[ModelArch]] = {
    "tiny": [ModelArch.TINY_STREAMING, ModelArch.TINY],
    "base": [ModelArch.BASE_STREAMING, ModelArch.BASE],
    "small-streaming": [ModelArch.SMALL_STREAMING],
    "medium-streaming": [ModelArch.MEDIUM_STREAMING],
}
FASTER_WHISPER_MODELS = ["small", "tiny", "base", "medium", "large-v3"]
BATCH_TRANSCRIPTION_ENGINES = ["faster-whisper", "moonshine", "groq"]
REALTIME_TRANSCRIPTION_ENGINES = ["moonshine", "groq"]
GROQ_TRANSCRIPTION_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"]
LLM_PROVIDERS = ["ollama", "groq"]
OLLAMA_LLM_MODELS = ["gemma4:e2b", "gemma4:e4b"]
GROQ_LLM_MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
]
GROQ_REASONING_EFFORTS = ["default", "low", "medium", "high"]
GROQ_SERVICE_TIERS = ["on_demand", "auto", "flex"]


@dataclass(slots=True)
class ResolvedModel:
    model_path: str
    model_arch: ModelArch
    model_preset: str


def available_model_presets(language: str) -> list[str]:
    available: list[str] = []
    for preset, candidates in MODEL_PRESET_CANDIDATES.items():
        for candidate in candidates:
            try:
                find_model_info(language, candidate)
            except ValueError:
                continue
            available.append(preset)
            break
    return available or ["tiny"]


class SettingsService:
    def __init__(self) -> None:
        self.prompt_templates = PromptTemplateService(REPO_ROOT / "prompt")

    def _with_file_prompt_settings(self, settings: AppSettings) -> AppSettings:
        prompt_settings = self.prompt_templates.load_prompt_settings(
            settings.prompt_settings.active_prompt_id,
            [prompt.id for prompt in settings.prompt_settings.prompts],
        )
        return settings.model_copy(update={"prompt_settings": prompt_settings})

    def get_settings_response(self) -> SettingsResponse:
        settings = self.get_settings()
        return SettingsResponse(
            settings=settings,
            resolvedPaths=resolve_paths(settings),
        )

    def get_settings(self) -> AppSettings:
        return self._with_file_prompt_settings(load_settings())

    def get_runtime_llm_settings(self, settings: AppSettings | None = None) -> LlmSettings:
        resolved_settings = self._with_file_prompt_settings(settings or load_settings())
        active_prompt = next(
            (
                prompt
                for prompt in resolved_settings.prompt_settings.prompts
                if prompt.id == resolved_settings.prompt_settings.active_prompt_id
            ),
            resolved_settings.prompt_settings.prompts[0],
        )
        return resolved_settings.llm.model_copy(
            update={"system_prompt": active_prompt.content}
        )

    def update_settings(self, settings: AppSettings) -> SettingsResponse:
        current_settings = self.get_settings()
        current_paths = resolve_paths(current_settings)
        next_paths = resolve_paths(settings)
        self._migrate_recordings_root(
            Path(current_paths.temp_recordings_root),
            Path(next_paths.temp_recordings_root),
        )
        prompt_settings = self.prompt_templates.save_prompt_settings(
            settings.prompt_settings
        )
        settings = settings.model_copy(update={"prompt_settings": prompt_settings})
        save_settings(settings)
        return self.get_settings_response()

    def get_meta(self) -> MetaResponse:
        settings = load_settings()
        languages = supported_languages()
        return MetaResponse(
            supportedLanguages=languages,
            availableModelsByLanguage={
                language: available_model_presets(language) for language in languages
            },
            realtimeTranscriptionEngines=REALTIME_TRANSCRIPTION_ENGINES,
            groqTranscriptionModels=GROQ_TRANSCRIPTION_MODELS,
            batchTranscriptionEngines=BATCH_TRANSCRIPTION_ENGINES,
            fasterWhisperModels=FASTER_WHISPER_MODELS,
            llmProviders=LLM_PROVIDERS,
            ollamaLlmModels=OLLAMA_LLM_MODELS,
            groqLlmModels=GROQ_LLM_MODELS,
            groqReasoningEfforts=GROQ_REASONING_EFFORTS,
            groqServiceTiers=GROQ_SERVICE_TIERS,
            defaultLanguage=settings.transcription.language,
            defaultModelPreset=settings.transcription.model_preset,
        )

    @staticmethod
    def _migrate_recordings_root(current_root: Path, next_root: Path) -> None:
        if current_root == next_root or not current_root.exists():
            return

        next_root.mkdir(parents=True, exist_ok=True)

        for item in current_root.iterdir():
            target = next_root / item.name
            if target.exists():
                raise ValueError(
                    f"Cannot move recordings because {target} already exists."
                )
            shutil.move(str(item), str(target))
