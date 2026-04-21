@echo off
setlocal

set "ROOT=%~dp0"
set "ROOT_NO_SLASH=%ROOT:~0,-1%"
set "BACKEND_VENV=%LOCALAPPDATA%\Voice2Text\backend-venv"
set "FRONTEND_URL=http://127.0.0.1:5173"
set "LOG_DIR=%LOCALAPPDATA%\Voice2Text\logs"
set "BACKEND_LOG=%LOG_DIR%\backend.log"
set "BACKEND_ERR=%LOG_DIR%\backend.err.log"
set "FRONTEND_LOG=%LOG_DIR%\frontend.log"
set "FRONTEND_ERR=%LOG_DIR%\frontend.err.log"
set "OLLAMA_MODELS=%ROOT%LLM\models"
set "OLLAMA_HOST=127.0.0.1:11434"
set "OLLAMA_LLM_LIBRARY=cpu"
set "EXIT_CODE=0"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

powershell -NoProfile -Command "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*uvicorn app.main:app --host 127.0.0.1 --port 8000*' }; foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
powershell -NoProfile -Command "$frontendRoot = '%ROOT%frontend'; $targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $frontendRoot + '*vite*') }; foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }; for ($i = 0; $i -lt 20; $i++) { $listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if (-not $listener) { break }; Start-Sleep -Milliseconds 250 }" >nul 2>nul
powershell -NoProfile -Command "$listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if ($listener) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $($listener.OwningProcess)\"; Write-Host '[Voice2Text] Port 8000 is already in use.'; if ($process) { Write-Host ('  PID {0}: {1}' -f $process.ProcessId, $process.CommandLine) }; exit 1 }; exit 0"
if errorlevel 1 (
  call :fail "Port 8000 is already in use."
  goto end
)
powershell -NoProfile -Command "$frontendRoot = '%ROOT%frontend'; $listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if ($listener) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $($listener.OwningProcess)\"; if ($process -and $process.CommandLine -like ('*' + $frontendRoot + '*vite*')) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 20; $i++) { $listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if (-not $listener) { exit 0 }; Start-Sleep -Milliseconds 250 } }; Write-Host '[Voice2Text] Port 5173 is already in use.'; if ($process) { Write-Host ('  PID {0}: {1}' -f $process.ProcessId, $process.CommandLine) }; exit 1 }; exit 0"
if errorlevel 1 (
  call :fail "Port 5173 is already in use."
  goto end
)

echo [Voice2Text] Starting backend and frontend...

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%LLM\scripts\disable-ollama-startup.ps1" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%LLM\scripts\start-ollama.ps1" -RepoRoot "%ROOT_NO_SLASH%"
if errorlevel 1 (
  echo [Voice2Text] Ollama is not ready. Raw transcription can still run, but LLM refinement requires Ollama.
)

powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $process = Start-Process -PassThru -WindowStyle Hidden -FilePath '%BACKEND_VENV%\Scripts\python.exe' -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' -WorkingDirectory '%ROOT%backend' -RedirectStandardOutput '%BACKEND_LOG%' -RedirectStandardError '%BACKEND_ERR%'; try { $process.PriorityClass = 'AboveNormal' } catch {}; $process | Out-Null"

set "BACKEND_READY="
for /L %%I in (1,1,40) do (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/api/health' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 (
    set "BACKEND_READY=1"
    goto start_frontend
  )
  timeout /t 1 /nobreak >nul
)

:start_frontend
if not defined BACKEND_READY (
  call :fail "Backend health check timed out."
  goto end
)

powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Start-Process -WindowStyle Hidden -FilePath 'C:\Windows\System32\cmd.exe' -ArgumentList '/c','npm.cmd run dev' -WorkingDirectory '%ROOT%frontend' -RedirectStandardOutput '%FRONTEND_LOG%' -RedirectStandardError '%FRONTEND_ERR%' | Out-Null"

set "FRONTEND_READY="
for /L %%I in (1,1,40) do (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing '%FRONTEND_URL%' -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 (
    set "FRONTEND_READY=1"
    goto open_frontend
  )
  timeout /t 1 /nobreak >nul
)

:open_frontend
if defined FRONTEND_READY (
  powershell -NoProfile -Command "Start-Process '%FRONTEND_URL%'"
  echo [Voice2Text] Ready.
  echo   Frontend: %FRONTEND_URL%
  echo   Backend:  http://127.0.0.1:8000/api/health
  echo   Ollama:   http://127.0.0.1:11434/api/version
  echo   Logs:
    echo     %BACKEND_LOG%
  echo     %BACKEND_ERR%
  echo     %FRONTEND_LOG%
  echo     %FRONTEND_ERR%
  call :maybe_pause
) else (
  call :fail "Frontend did not become ready at %FRONTEND_URL%."
)

:end
endlocal
exit /b %EXIT_CODE%

:fail
echo [Voice2Text] %~1
echo   Logs:
echo     %BACKEND_LOG%
echo     %BACKEND_ERR%
echo     %FRONTEND_LOG%
echo     %FRONTEND_ERR%
set "EXIT_CODE=1"
call :maybe_pause
goto :eof

:maybe_pause
if not defined VOICE2TEXT_NO_PAUSE (
  echo.
  echo Press any key to close this launcher window.
  pause >nul
)
goto :eof
