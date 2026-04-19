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

echo.
echo Voice2Text setup complete.
echo Backend venv: %BACKEND_VENV%
echo Models root: %VOICE2TEXT_MODELS_ROOT%
echo.
echo Next step:
echo   run-dev.bat

endlocal

