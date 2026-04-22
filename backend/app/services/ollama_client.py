from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from app.models.schemas import LlmSettings


DEFAULT_REFINEMENT_PROMPT = (
    "あなたは日本語音声認識出力のエディターです。\n\n"
    "TARGETとマークされた行を、自然な日本語の段落に書き換えてください。\n"
    "PREVIOUS行は文脈情報としてのみ使用してください。\n"
    "句読点を追加し、漢字と仮名を正規化してください。\n"
    "PREVIOUSの内容は繰り返さないでください。\n"
    "TARGETに新しく追加された情報のみを出力してください。"
    "TARGETがPREVIOUSと重複する場合は、重複部分を省略してください。\n"
    "存在しない事実を追加しないでください。\n"
    "修正された段落のみを返してください。"
)

DEFAULT_MINUTES_PROMPT = (
    "あなたは日本語音声認識出力のエディターです。"
    "整形済みの文字起こしを唯一の根拠として、日本語のMarkdown文書にしてください。"
    "句読点を追加し、漢字と仮名を正規化し、重複や言い直しを整理してください。"
    "存在しない事実を追加しないでください。"
    "選択中の用途テンプレートがある場合は、その構成と観点を優先してください。"
    "用途テンプレートが不足している場合だけ、内容に合う簡潔な見出しを補ってください。"
    "Markdownのみを返してください。"
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
