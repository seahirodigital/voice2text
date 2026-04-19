from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil

from moonshine_voice import ModelArch, supported_languages
from moonshine_voice.download import find_model_info

from app.config import load_settings, resolve_paths, save_settings
from app.models.schemas import AppSettings, MetaResponse, SettingsResponse


MODEL_PRESET_CANDIDATES: dict[str, list[ModelArch]] = {
    "tiny": [ModelArch.TINY_STREAMING, ModelArch.TINY],
    "base": [ModelArch.BASE_STREAMING, ModelArch.BASE],
    "small-streaming": [ModelArch.SMALL_STREAMING],
    "medium-streaming": [ModelArch.MEDIUM_STREAMING],
}


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
    def get_settings_response(self) -> SettingsResponse:
        settings = load_settings()
        return SettingsResponse(
            settings=settings,
            resolvedPaths=resolve_paths(settings),
        )

    def get_settings(self) -> AppSettings:
        return load_settings()

    def update_settings(self, settings: AppSettings) -> SettingsResponse:
        current_settings = load_settings()
        current_paths = resolve_paths(current_settings)
        next_paths = resolve_paths(settings)
        self._migrate_recordings_root(
            Path(current_paths.temp_recordings_root),
            Path(next_paths.temp_recordings_root),
        )
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
