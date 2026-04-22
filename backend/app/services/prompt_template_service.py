from __future__ import annotations

import re
from pathlib import Path

from app.models.schemas import PromptPreset, PromptSettings
from app.prompt_defaults import DEFAULT_PROMPT_ID, DEFAULT_USAGE_PROMPTS

PROMPT_FILE_EXTENSION = ".md"


def _safe_prompt_id(value: str) -> str:
    normalized = value.strip().lower()
    normalized = re.sub(r"[^a-z0-9_.-]+", "-", normalized)
    normalized = normalized.strip(".-")
    return normalized or "prompt"


def _prompt_filename(prompt_id: str) -> str:
    return f"{_safe_prompt_id(prompt_id)}{PROMPT_FILE_EXTENSION}"


def _split_markdown_prompt(prompt_id: str, markdown: str) -> PromptPreset:
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    name = Path(prompt_id).stem
    content_lines = lines

    if lines and lines[0].startswith("# "):
        heading = lines[0][2:].strip()
        if heading:
            name = heading
        content_lines = lines[1:]
        if content_lines and not content_lines[0].strip():
            content_lines = content_lines[1:]

    content = "\n".join(content_lines).strip()
    return PromptPreset(id=prompt_id, name=name, content=content)


def _render_markdown_prompt(prompt: PromptPreset) -> str:
    content = prompt.content.strip()
    return f"# {prompt.name.strip() or prompt.id}\n\n{content}\n"


class PromptTemplateService:
    def __init__(self, prompt_root: Path) -> None:
        self.prompt_root = prompt_root

    def ensure_defaults(self) -> None:
        self.prompt_root.mkdir(parents=True, exist_ok=True)
        if any(self.prompt_root.glob(f"*{PROMPT_FILE_EXTENSION}")):
            return
        for prompt in DEFAULT_USAGE_PROMPTS:
            path = self.prompt_root / _prompt_filename(prompt["id"])
            preset = PromptPreset.model_validate(prompt)
            path.write_text(_render_markdown_prompt(preset), encoding="utf-8")

    def load_prompt_settings(
        self,
        active_prompt_id: str | None = None,
        preferred_order: list[str] | None = None,
    ) -> PromptSettings:
        self.ensure_defaults()
        prompts: list[PromptPreset] = []
        for path in sorted(self.prompt_root.glob(f"*{PROMPT_FILE_EXTENSION}")):
            if not path.is_file():
                continue
            prompt_id = _safe_prompt_id(path.stem)
            prompts.append(
                _split_markdown_prompt(
                    prompt_id,
                    path.read_text(encoding="utf-8"),
                )
            )

        if not prompts:
            prompts = [PromptPreset.model_validate(DEFAULT_USAGE_PROMPTS[0])]

        preferred_order_map = {
            _safe_prompt_id(prompt_id): index
            for index, prompt_id in enumerate(preferred_order or [])
        }
        default_order_map = {
            _safe_prompt_id(prompt["id"]): index
            for index, prompt in enumerate(DEFAULT_USAGE_PROMPTS)
        }

        def prompt_sort_key(prompt: PromptPreset) -> tuple[int, int | str]:
            if prompt.id in preferred_order_map:
                return (0, preferred_order_map[prompt.id])
            if prompt.id in default_order_map:
                return (1, default_order_map[prompt.id])
            return (2, prompt.name)

        prompts = sorted(
            prompts,
            key=prompt_sort_key,
        )

        preferred_id = active_prompt_id or DEFAULT_PROMPT_ID
        if not any(prompt.id == preferred_id for prompt in prompts):
            preferred_id = DEFAULT_PROMPT_ID
        if not any(prompt.id == preferred_id for prompt in prompts):
            preferred_id = prompts[0].id

        return PromptSettings(activePromptId=preferred_id, prompts=prompts)

    def save_prompt_settings(self, prompt_settings: PromptSettings) -> PromptSettings:
        self.ensure_defaults()
        normalized = PromptSettings.model_validate(
            prompt_settings.model_dump(by_alias=True)
        )

        next_ids = {_safe_prompt_id(prompt.id) for prompt in normalized.prompts}
        for path in self.prompt_root.glob(f"*{PROMPT_FILE_EXTENSION}"):
            if path.is_file() and _safe_prompt_id(path.stem) not in next_ids:
                path.unlink()

        for prompt in normalized.prompts:
            safe_id = _safe_prompt_id(prompt.id)
            preset = prompt.model_copy(update={"id": safe_id})
            path = self.prompt_root / _prompt_filename(safe_id)
            path.write_text(_render_markdown_prompt(preset), encoding="utf-8")

        return self.load_prompt_settings(
            normalized.active_prompt_id,
            [prompt.id for prompt in normalized.prompts],
        )
