from __future__ import annotations

from typing import Protocol

from app.models.schemas import LlmSettings
from app.services.groq_client import GroqClient
from app.services.ollama_client import OllamaClient, RefinementResult


class RefinementClient(Protocol):
    async def refine(self, context: str) -> RefinementResult:
        ...

    async def refine_minutes(self, *, title: str, transcript: str) -> RefinementResult:
        ...

    async def refine_timeline_block(
        self,
        *,
        previous: str,
        target: str,
    ) -> RefinementResult:
        ...


def refinement_enabled(settings: LlmSettings) -> bool:
    return settings.enabled and settings.provider in {"ollama", "groq"}


def create_refinement_client(settings: LlmSettings) -> RefinementClient:
    if settings.provider == "groq":
        return GroqClient(settings)
    return OllamaClient(settings)
