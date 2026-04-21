@echo off
setlocal

set "ROOT=%~dp0"
set "LOCAL_BASE=%LOCALAPPDATA%\Voice2Text"
set "BACKEND_VENV=%LOCAL_BASE%\backend-venv"

if not exist "%LOCAL_BASE%" mkdir "%LOCAL_BASE%"

if not exist "%BACKEND_VENV%\Scripts\python.exe" (
  py -m venv "%BACKEND_VENV%"
)

call "%BACKEND_VENV%\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r "%ROOT%backend\requirements.txt"

pushd "%ROOT%frontend"
call npm.cmd install
popd

set "VOICE2TEXT_MODELS_ROOT=%LOCAL_BASE%\models"
python "%ROOT%backend\scripts\bootstrap_models.py"

set "VOICE2TEXT_FASTER_WHISPER_ROOT=%LOCAL_BASE%\faster_whisper_models"
for %%M in (tiny base small medium large-v3) do (
  set "VOICE2TEXT_FASTER_WHISPER_MODEL=%%M"
  python "%ROOT%backend\scripts\bootstrap_faster_whisper.py"
)

echo.
echo Voice2Text setup complete.
echo Backend venv: %BACKEND_VENV%
echo Models root: %VOICE2TEXT_MODELS_ROOT%
echo Faster Whisper models: %VOICE2TEXT_FASTER_WHISPER_ROOT%
echo.
echo Next step:
echo   start.bat

endlocal
