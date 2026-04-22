from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from app.models.schemas import LlmSettings


DEFAULT_REFINEMENT_PROMPT = (
    "You are an editor for Japanese speech recognition output. "
    "Rewrite the lines marked TARGET into one natural Japanese paragraph. "
    "Use PREVIOUS lines only as context. Add punctuation and normalize kanji/kana. "
    "Do not repeat PREVIOUS content. Output only information newly present in TARGET. "
    "If TARGET overlaps with PREVIOUS, omit the duplicated part. "
    "Do not add facts that are not present. Return only the refined paragraph."
)

DEFAULT_MINUTES_PROMPT = (
    "You are an editor creating Japanese meeting minutes from speech recognition output. "
    "Use the cleaned timestamped transcript as the source of truth. "
    "Create concise but useful Markdown minutes in Japanese. Preserve the meaning, "
    "do not invent facts, remove duplicated phrases, and make the text readable. "
    "Use this structure exactly: # title, ## Summary, ## Key Points, ## Details, "
    "## Action Items. If there are no action items, write '- None'. "
    "Do not include a timestamped transcript section. Return only Markdown."
)

TIMELINE_BLOCK_PROMPT = (
    "You are correcting Japanese speech recognition output. "
    "Rewrite TARGET timestamped transcript lines into natural Japanese while preserving "
    "each timestamp. Do not summarize. Do not merge away timestamps. Do not invent facts. "
    "Use PREVIOUS only as context and do not repeat it. Return only cleaned timestamped lines."
)

TIMELINE_BLOCK_GUARD_PROMPT = (
    "For this request, preserve every TARGET timestamp and return only cleaned "
    "timestamped transcript lines. Do not summarize or add facts."
)


@dataclass(slots=True)
class RefinementResult:
    text: str
    latency_ms: int


class OllamaClient:
    def __init__(self, settings: LlmSettings) -> None:
        self.settings = settings

    def _system_prompt(self, default_prompt: str, guard_prompt: str = "") -> str:
        custom_prompt = self.settings.system_prompt.strip()
        if not custom_prompt:
            return default_prompt
        if not guard_prompt:
            return custom_prompt
        return f"{custom_prompt}\n\n{guard_prompt}"

    async def _chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        num_predict: int,
        timeout_seconds: float,
    ) -> RefinementResult:
        started = time.perf_counter()
        payload = {
            "model": self.settings.model,
            "stream": False,
            "think": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "options": {
                "temperature": 0.1,
                "num_predict": num_predict,
            },
        }
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
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

    async def refine(self, context: str) -> RefinementResult:
        return await self._chat(
            system_prompt=self._system_prompt(DEFAULT_REFINEMENT_PROMPT),
            user_prompt=context,
            num_predict=160,
            timeout_seconds=120.0,
        )

    async def refine_minutes(self, *, title: str, transcript: str) -> RefinementResult:
        return await self._chat(
            system_prompt=self._system_prompt(DEFAULT_MINUTES_PROMPT),
            user_prompt=f"# {title}\n\nTranscript:\n{transcript}",
            num_predict=2048,
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
            num_predict=512,
            timeout_seconds=180.0,
        )
