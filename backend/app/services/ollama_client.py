from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from app.models.schemas import LlmSettings


DEFAULT_REFINEMENT_PROMPT = (
    "You are an editor for Japanese speech recognition output. "
    "Rewrite the line marked CURRENT into natural Japanese without changing the meaning. "
    "Use PREVIOUS and NEXT lines only as context. Add punctuation and normalize kanji/kana. "
    "Do not add facts that are not present. Return only the refined CURRENT line."
)


@dataclass(slots=True)
class RefinementResult:
    text: str
    latency_ms: int


class OllamaClient:
    def __init__(self, settings: LlmSettings) -> None:
        self.settings = settings

    async def refine(self, context: str) -> RefinementResult:
        started = time.perf_counter()
        payload = {
            "model": self.settings.model,
            "stream": False,
            "think": False,
            "messages": [
                {"role": "system", "content": DEFAULT_REFINEMENT_PROMPT},
                {"role": "user", "content": context},
            ],
            "options": {
                "temperature": 0.1,
                "num_predict": 160,
            },
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self.settings.base_url.rstrip('/')}/api/chat",
                json=payload,
            )
            response.raise_for_status()

        data = response.json()
        message = data.get("message") if isinstance(data, dict) else None
        content = message.get("content") if isinstance(message, dict) else ""
        text = str(content or "").strip()
        return RefinementResult(
            text=text,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
