from __future__ import annotations

import os
from pathlib import Path

from moonshine_voice import ModelArch, get_embedding_model, get_model_for_language


def main() -> None:
    models_root = Path(
        os.getenv("VOICE2TEXT_MODELS_ROOT", r"%LOCALAPPDATA%\Voice2Text\models")
    )
    models_root = Path(os.path.expandvars(str(models_root))).expanduser().resolve()
    models_root.mkdir(parents=True, exist_ok=True)

    print(f"[Voice2Text] Ensuring Moonshine models under: {models_root}")
    get_model_for_language("ja", ModelArch.TINY, cache_root=models_root)
    get_embedding_model(cache_root=models_root)
    print("[Voice2Text] Moonshine model bootstrap complete.")


if __name__ == "__main__":
    main()

