#!/bin/zsh
set -e

APP_DIR="/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Voice2Text/Aqua_Voice"
VENV_DIR="$APP_DIR/.venv"
export PYTHONDONTWRITEBYTECODE=1

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check -r "$APP_DIR/requirements.txt"
"$VENV_DIR/bin/python" "$APP_DIR/aqua_voice_app.py"
