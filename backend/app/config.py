from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.models.schemas import AppSettings, ResolvedPaths

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "paths": {
        "modelsRoot": r"%LOCALAPPDATA%\Voice2Text\models",
        "dataRoot": r"%LOCALAPPDATA%\Voice2Text\data",
        "tempRecordingsRoot": r"%LOCALAPPDATA%\Voice2Text\temp_recordings",
        "frontendDist": "frontend/dist",
    },
    "transcription": {
        "language": "ja",
        "modelPreset": "base",
        "maxSpeakers": 3,
        "updateIntervalMs": 5000,
        "enableWordTimestamps": False,
    },
    "apiSettings": {
        "systemPrompt": "",
        "providers": {
            "openai": {"apiKey": "", "model": ""},
            "anthropic": {"apiKey": "", "model": ""},
        },
    },
    "llm": {
        "enabled": True,
        "provider": "ollama",
        "baseUrl": "http://localhost:11434",
        "model": "gemma4:e2b",
        "contextLines": 3,
        "contextBeforeLines": 3,
        "contextAfterLines": 3,
        "debounceMs": 5000,
        "maxWaitMs": 5000,
        "completeOnly": True,
    },
}


def _deep_merge(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merged[key] = _deep_merge(base[key], value)
        else:
            merged[key] = value
    return merged


def _expand_path(raw_path: str) -> Path:
    expanded = os.path.expandvars(raw_path)
    candidate = Path(expanded).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (REPO_ROOT / candidate).resolve()


def ensure_config_file() -> None:
    if CONFIG_PATH.exists():
        return
    CONFIG_PATH.write_text(
        json.dumps(DEFAULT_CONFIG, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_settings() -> AppSettings:
    ensure_config_file()
    loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    merged = _deep_merge(DEFAULT_CONFIG, loaded)
    return AppSettings.model_validate(merged)


def save_settings(settings: AppSettings) -> None:
    payload = settings.model_dump(by_alias=True)
    CONFIG_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def resolve_paths(settings: AppSettings) -> ResolvedPaths:
    models_root = _expand_path(settings.paths.models_root)
    data_root = _expand_path(settings.paths.data_root)
    temp_recordings_root = _expand_path(settings.paths.temp_recordings_root)
    frontend_dist = _expand_path(settings.paths.frontend_dist)
    sessions_root = data_root / "sessions"

    for path in (models_root, data_root, sessions_root, temp_recordings_root):
        path.mkdir(parents=True, exist_ok=True)

    return ResolvedPaths(
        configPath=str(CONFIG_PATH),
        repoRoot=str(REPO_ROOT),
        modelsRoot=str(models_root),
        dataRoot=str(data_root),
        sessionsRoot=str(sessions_root),
        tempRecordingsRoot=str(temp_recordings_root),
        frontendDist=str(frontend_dist),
    )
