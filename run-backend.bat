@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_VENV=%LOCALAPPDATA%\Voice2Text\backend-venv"

powershell -NoProfile -Command "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*uvicorn app.main:app --host 127.0.0.1 --port 8000*' }; foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
powershell -NoProfile -Command "$listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if ($listener) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $($listener.OwningProcess)\"; Write-Host '[Voice2Text] Port 8000 is already in use.'; if ($process) { Write-Host ('  PID {0}: {1}' -f $process.ProcessId, $process.CommandLine) }; exit 1 }; exit 0"
if errorlevel 1 exit /b 1

cd /d "%ROOT%backend"
"%BACKEND_VENV%\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000

endlocal
