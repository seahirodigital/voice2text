from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from app.config import REPO_ROOT, load_settings, resolve_paths

USAGE_FILENAME = "groq_usage.json"
RATE_LIMIT_HEADER_PREFIX = "x-ratelimit-"

_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _today_key() -> str:
    return datetime.now().astimezone().date().isoformat()


def _usage_path() -> Path:
    try:
        settings = load_settings()
        data_root = Path(resolve_paths(settings).data_root)
    except Exception:
        data_root = REPO_ROOT / "data"
    data_root.mkdir(parents=True, exist_ok=True)
    return data_root / USAGE_FILENAME


def _empty_totals() -> dict[str, Any]:
    return {
        "requests": 0,
        "successes": 0,
        "errors": 0,
        "rateLimitHits": 0,
        "audioSeconds": 0.0,
        "promptTokens": 0,
        "completionTokens": 0,
        "totalTokens": 0,
    }


def _empty_payload() -> dict[str, Any]:
    return {
        "updatedAt": None,
        "todayKey": _today_key(),
        "today": _empty_totals(),
        "models": {},
        "latest": None,
        "rateLimits": {},
    }


def _load_payload() -> dict[str, Any]:
    path = _usage_path()
    if not path.is_file():
        return _empty_payload()
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return _empty_payload()
    if not isinstance(payload, dict):
        return _empty_payload()
    payload.setdefault("todayKey", _today_key())
    payload.setdefault("today", _empty_totals())
    payload.setdefault("models", {})
    payload.setdefault("latest", None)
    payload.setdefault("rateLimits", {})
    return payload


def _save_payload(payload: dict[str, Any]) -> None:
    path = _usage_path()
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _reset_if_new_day(payload: dict[str, Any]) -> None:
    today = _today_key()
    if payload.get("todayKey") == today:
        payload.setdefault("today", _empty_totals())
        return
    payload["todayKey"] = today
    payload["today"] = _empty_totals()
    payload["models"] = {}


def _rate_limits_from_headers(headers: Mapping[str, str]) -> dict[str, str]:
    limits: dict[str, str] = {}
    for key, value in headers.items():
        normalized_key = key.lower()
        if not normalized_key.startswith(RATE_LIMIT_HEADER_PREFIX):
            continue
        short_key = normalized_key.removeprefix(RATE_LIMIT_HEADER_PREFIX)
        limits[short_key] = str(value)
    return limits


def _token_usage(raw_usage: Any) -> dict[str, int]:
    if not isinstance(raw_usage, dict):
        return {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0}
    return {
        "promptTokens": int(raw_usage.get("prompt_tokens") or 0),
        "completionTokens": int(raw_usage.get("completion_tokens") or 0),
        "totalTokens": int(raw_usage.get("total_tokens") or 0),
    }


def _add_totals(
    totals: dict[str, Any],
    *,
    status_code: int,
    audio_seconds: float,
    token_usage: dict[str, int],
) -> None:
    totals["requests"] = int(totals.get("requests") or 0) + 1
    if 200 <= status_code < 400:
        totals["successes"] = int(totals.get("successes") or 0) + 1
    else:
        totals["errors"] = int(totals.get("errors") or 0) + 1
    if status_code == 429:
        totals["rateLimitHits"] = int(totals.get("rateLimitHits") or 0) + 1
    totals["audioSeconds"] = round(
        float(totals.get("audioSeconds") or 0.0) + max(0.0, audio_seconds),
        3,
    )
    totals["promptTokens"] = int(totals.get("promptTokens") or 0) + token_usage[
        "promptTokens"
    ]
    totals["completionTokens"] = int(
        totals.get("completionTokens") or 0
    ) + token_usage["completionTokens"]
    totals["totalTokens"] = int(totals.get("totalTokens") or 0) + token_usage[
        "totalTokens"
    ]


def record_groq_api_call(
    *,
    endpoint: str,
    model: str,
    status_code: int,
    latency_ms: int,
    headers: Mapping[str, str],
    audio_seconds: float = 0.0,
    usage: Any = None,
) -> None:
    rate_limits = _rate_limits_from_headers(headers)
    token_usage = _token_usage(usage)
    now = _now_iso()

    try:
        with _LOCK:
            payload = _load_payload()
            _reset_if_new_day(payload)

            today = payload.setdefault("today", _empty_totals())
            _add_totals(
                today,
                status_code=status_code,
                audio_seconds=audio_seconds,
                token_usage=token_usage,
            )

            models = payload.setdefault("models", {})
            model_totals = models.setdefault(model or "unknown", _empty_totals())
            _add_totals(
                model_totals,
                status_code=status_code,
                audio_seconds=audio_seconds,
                token_usage=token_usage,
            )

            payload["updatedAt"] = now
            payload["latest"] = {
                "at": now,
                "endpoint": endpoint,
                "model": model,
                "statusCode": status_code,
                "latencyMs": latency_ms,
                "audioSeconds": round(max(0.0, audio_seconds), 3),
                "tokens": token_usage,
            }
            if rate_limits:
                payload["rateLimits"] = rate_limits

            _save_payload(payload)
    except Exception:
        return


def get_groq_usage_snapshot() -> dict[str, Any]:
    with _LOCK:
        payload = _load_payload()
        _reset_if_new_day(payload)
        _save_payload(payload)
        return payload
