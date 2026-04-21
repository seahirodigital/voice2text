from __future__ import annotations

import os
from pathlib import Path


def main() -> None:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit(
            "faster-whisper is not installed. Run setup.bat to install backend requirements."
        ) from exc

    models_root = Path(
        os.getenv(
            "VOICE2TEXT_FASTER_WHISPER_ROOT",
            r"%LOCALAPPDATA%\Voice2Text\faster_whisper_models",
        )
    )
    models_root = Path(os.path.expandvars(str(models_root))).expanduser().resolve()
    models_root.mkdir(parents=True, exist_ok=True)

    model_name = os.getenv("VOICE2TEXT_FASTER_WHISPER_MODEL", "small")
    print(f"[Voice2Text] Ensuring Faster Whisper model '{model_name}' under: {models_root}")
    WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(models_root),
    )
    print("[Voice2Text] Faster Whisper model bootstrap complete.")


if __name__ == "__main__":
    main()
