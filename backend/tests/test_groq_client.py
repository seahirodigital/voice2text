from __future__ import annotations

import asyncio

import httpx

from app.services.groq_client import GroqClient


class _FakeResponse:
    status_code = 200
    headers: dict[str, str] = {}

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return {"text": "hello", "segments": []}


def test_groq_transcription_uses_async_safe_form_data(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_post(self, url: str, **kwargs):  # type: ignore[no-untyped-def]
        captured["url"] = url
        captured["data"] = kwargs.get("data")
        captured["files"] = kwargs.get("files")
        return _FakeResponse()

    monkeypatch.setattr("app.services.groq_client.load_groq_api_key", lambda: "gsk_test")
    monkeypatch.setattr("app.services.groq_client.record_groq_api_call", lambda **_: None)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post, raising=False)

    result = asyncio.run(
        GroqClient().transcribe_wav(
            wav_bytes=b"1234",
            filename="sample.wav",
            model="whisper-large-v3-turbo",
            language="ja",
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    )

    assert result.text == "hello"
    assert isinstance(captured["data"], dict)
    assert captured["data"] == {
        "model": "whisper-large-v3-turbo",
        "response_format": "verbose_json",
        "temperature": "0",
        "language": "ja",
        "timestamp_granularities[]": ["segment"],
    }
