from __future__ import annotations

import io
import os
import re
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.models.schemas import LlmSettings
from app.services.ollama_client import (
    DEFAULT_MINUTES_PROMPT,
    DEFAULT_REFINEMENT_PROMPT,
    TIMELINE_BLOCK_GUARD_PROMPT,
    TIMELINE_BLOCK_PROMPT,
    RefinementResult,
)

GROQ_API_KEY_ENV = "GROQ_API_KEY"
DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
REPO_ROOT = Path(__file__).resolve().parents[3]
GROQ_ENV_FILE_CANDIDATES = (
    REPO_ROOT / "LLM" / ".env" / ".env",
    REPO_ROOT / "LLM" / ".env",
    REPO_ROOT / ".env",
)
GROQ_API_KEY_RE = re.compile(r"gsk_[A-Za-z0-9_-]+")


@dataclass(slots=True)
class GroqTranscriptionSegment:
    text: str
    start: float
    end: float


@dataclass(slots=True)
class GroqTranscriptionResult:
    text: str
    latency_ms: int
    segments: list[GroqTranscriptionSegment]


def _parse_env_value(raw_value: str) -> str:
    value = raw_value.strip()
    if (
        len(value) >= 2
        and value[0] == value[-1]
        and value[0] in ("'", '"')
    ):
        return value[1:-1]
    return value


def normalize_groq_api_key(raw_value: str | None) -> str:
    value = (raw_value or "").strip()
    if not value:
        return ""

    if "=" in value:
        maybe_name, maybe_value = value.split("=", 1)
        if maybe_name.strip() in {GROQ_API_KEY_ENV, "GROQ_API_KEY"}:
            value = maybe_value.strip()

    value = _parse_env_value(value)
    if value.lower().startswith("bearer "):
        value = value[7:].strip()

    embedded_key = GROQ_API_KEY_RE.search(value)
    if embedded_key is not None:
        return embedded_key.group(0)
    return value


def _load_env_file_value(path: Path, name: str) -> str | None:
    if not path.is_file():
        return None
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == name:
            return _parse_env_value(value)
    return None


def _load_config_groq_api_key() -> str | None:
    try:
        from app.config import load_settings

        return load_settings().api_settings.providers.groq.api_key
    except Exception:
        return None


def load_groq_api_key() -> str:
    api_key = normalize_groq_api_key(os.environ.get(GROQ_API_KEY_ENV, ""))
    if api_key:
        if GROQ_API_KEY_RE.fullmatch(api_key):
            return api_key
        raise ValueError(
            "Groq API key format looks invalid. Paste only the key beginning with "
            "gsk_ in Settings > AI Providers > Groq API Key."
        )

    api_key = normalize_groq_api_key(_load_config_groq_api_key())
    if api_key:
        if GROQ_API_KEY_RE.fullmatch(api_key):
            return api_key
        raise ValueError(
            "Groq API key format looks invalid. Paste only the key beginning with "
            "gsk_ in Settings > AI Providers > Groq API Key."
        )

    for env_file in GROQ_ENV_FILE_CANDIDATES:
        api_key = normalize_groq_api_key(
            _load_env_file_value(env_file, GROQ_API_KEY_ENV)
        )
        if api_key:
            if GROQ_API_KEY_RE.fullmatch(api_key):
                return api_key
            raise ValueError(
                "Groq API key format looks invalid. Paste only the key beginning with "
                "gsk_ in Settings > AI Providers > Groq API Key."
            )

    raise ValueError(
        "Groq API key is not set. Add it in Settings > AI Providers > Groq API Key, "
        "or set the GROQ_API_KEY environment variable."
    )


def pcm16_wav_bytes(
    frame_bytes: bytes,
    *,
    sample_rate: int,
    channels: int,
) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frame_bytes)
    return buffer.getvalue()


def _model_supports_reasoning_effort(model: str) -> bool:
    return model.startswith("openai/gpt-oss-") or model.startswith("qwen")


class GroqClient:
    def __init__(self, settings: LlmSettings | None = None) -> None:
        self.settings = settings

    @property
    def base_url(self) -> str:
        if self.settings is None:
            return DEFAULT_GROQ_BASE_URL
        return (self.settings.groq_base_url or DEFAULT_GROQ_BASE_URL).rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {load_groq_api_key()}"}

    def _system_prompt(self, default_prompt: str, guard_prompt: str = "") -> str:
        application_template = ""
        if self.settings is not None:
            application_template = self.settings.system_prompt.strip()

        parts = [default_prompt]
        if application_template:
            parts.append(
                "選択中の用途テンプレートです。固定ルールと矛盾しない範囲で、"
                "出力形式、トーン、優先して拾う情報の指針として使ってください。\n"
                f"{application_template}"
            )
        if guard_prompt:
            parts.append(f"このリクエストで必ず守る追加ルール:\n{guard_prompt}")
        return "\n\n".join(parts)

    async def transcribe_wav(
        self,
        *,
        wav_bytes: bytes,
        filename: str,
        model: str,
        language: str,
        response_format: str = "json",
        timestamp_granularities: list[str] | None = None,
        timeout_seconds: float = 120.0,
    ) -> GroqTranscriptionResult:
        started = time.perf_counter()
        data: list[tuple[str, str]] = [
            ("model", model),
            ("response_format", response_format),
            ("temperature", "0"),
        ]
        if language:
            data.append(("language", language))
        for granularity in timestamp_granularities or []:
            data.append(("timestamp_granularities[]", granularity))

        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f"{self.base_url}/audio/transcriptions",
                headers=self._headers(),
                data=data,
                files={"file": (filename, wav_bytes, "audio/wav")},
            )
            response.raise_for_status()

        if response_format == "text":
            text = response.text
            segments: list[GroqTranscriptionSegment] = []
        else:
            payload = response.json()
            text = payload.get("text") if isinstance(payload, dict) else ""
            segments = self._extract_transcription_segments(payload)
        return GroqTranscriptionResult(
            text=str(text or "").strip(),
            latency_ms=int((time.perf_counter() - started) * 1000),
            segments=segments,
        )

    @staticmethod
    def _extract_transcription_segments(payload: Any) -> list[GroqTranscriptionSegment]:
        if not isinstance(payload, dict):
            return []
        raw_segments = payload.get("segments")
        if not isinstance(raw_segments, list):
            return []

        segments: list[GroqTranscriptionSegment] = []
        for raw_segment in raw_segments:
            if not isinstance(raw_segment, dict):
                continue
            text = str(raw_segment.get("text") or "").strip()
            if not text:
                continue
            start = float(raw_segment.get("start") or 0.0)
            end = float(raw_segment.get("end") or start)
            segments.append(
                GroqTranscriptionSegment(
                    text=text,
                    start=max(0.0, start),
                    end=max(start, end),
                )
            )
        return segments

    async def _chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_completion_tokens: int,
        timeout_seconds: float,
    ) -> RefinementResult:
        if self.settings is None:
            raise ValueError("Groq LLM settings are required for chat completion.")

        started = time.perf_counter()
        base_payload: dict[str, object] = {
            "model": self.settings.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.1,
            "max_completion_tokens": max_completion_tokens,
        }
        if self.settings.groq_service_tier != "on_demand":
            base_payload["service_tier"] = self.settings.groq_service_tier
        if (
            self.settings.groq_reasoning_effort != "default"
            and _model_supports_reasoning_effort(self.settings.model)
        ):
            base_payload["reasoning_effort"] = self.settings.groq_reasoning_effort

        data = await self._post_chat_payload(
            base_payload,
            timeout_seconds=timeout_seconds,
        )
        text, finish_reason = self._extract_chat_text(data)
        if not text and finish_reason == "length":
            retry_payload = {
                **base_payload,
                "max_completion_tokens": max(1024, max_completion_tokens * 4),
            }
            if _model_supports_reasoning_effort(self.settings.model):
                retry_payload["reasoning_effort"] = "low"
            data = await self._post_chat_payload(
                retry_payload,
                timeout_seconds=timeout_seconds,
            )
            text, finish_reason = self._extract_chat_text(data)

        if not text:
            raise ValueError(
                "Groq returned an empty LLM completion"
                + (f" (finish_reason={finish_reason})." if finish_reason else ".")
            )

        return RefinementResult(
            text=text,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _post_chat_payload(
        self,
        payload: dict[str, object],
        *,
        timeout_seconds: float,
    ) -> dict:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    **self._headers(),
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _extract_chat_text(data: dict) -> tuple[str, str | None]:
        choices = data.get("choices") if isinstance(data, dict) else None
        choice = choices[0] if choices else {}
        message = choice.get("message") if isinstance(choice, dict) else None
        content = message.get("content") if isinstance(message, dict) else ""
        finish_reason = choice.get("finish_reason") if isinstance(choice, dict) else None
        return str(content or "").strip(), (
            str(finish_reason) if finish_reason is not None else None
        )

    async def refine(self, context: str) -> RefinementResult:
        return await self._chat(
            system_prompt=self._system_prompt(DEFAULT_REFINEMENT_PROMPT),
            user_prompt=context,
            max_completion_tokens=768,
            timeout_seconds=120.0,
        )

    async def refine_minutes(self, *, title: str, transcript: str) -> RefinementResult:
        return await self._chat(
            system_prompt=self._system_prompt(DEFAULT_MINUTES_PROMPT),
            user_prompt=f"# {title}\n\nTranscript:\n{transcript}",
            max_completion_tokens=4096,
            timeout_seconds=300.0,
        )

    async def refine_timeline_block(
        self,
        *,
        previous: str,
        target: str,
    ) -> RefinementResult:
        return await self._chat(
            system_prompt=self._system_prompt(
                TIMELINE_BLOCK_PROMPT,
                TIMELINE_BLOCK_GUARD_PROMPT,
            ),
            user_prompt=f"PREVIOUS:\n{previous}\n\nTARGET:\n{target}",
            max_completion_tokens=1536,
            timeout_seconds=180.0,
        )
