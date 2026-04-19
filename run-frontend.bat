@echo off
setlocal

set "ROOT=%~dp0"

powershell -NoProfile -Command "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*Voice2Text\\frontend\\node_modules*vite*' }; foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
powershell -NoProfile -Command "$listener = $null; try { $listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { $listener = $null }; if ($listener) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $($listener.OwningProcess)\"; Write-Host '[Voice2Text] Port 5173 is already in use.'; if ($process) { Write-Host ('  PID {0}: {1}' -f $process.ProcessId, $process.CommandLine) }; exit 1 }; exit 0"
if errorlevel 1 exit /b 1

cd /d "%ROOT%frontend"
npm.cmd run dev

endlocal
