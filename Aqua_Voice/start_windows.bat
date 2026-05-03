@echo off
setlocal
set "APP_DIR=C:\Users\HCY\OneDrive\開発\Voice2Text\Aqua_Voice"
set "VENV_DIR=%APP_DIR%\.venv"

if not exist "%VENV_DIR%" (
  py -3 -m venv "%VENV_DIR%"
)

"%VENV_DIR%\Scripts\python.exe" -m pip install --disable-pip-version-check -r "%APP_DIR%\requirements.txt"
"%VENV_DIR%\Scripts\python.exe" "%APP_DIR%\aqua_voice_app.py"
