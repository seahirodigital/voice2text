param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path $RepoRoot).Path
$llmRoot = Join-Path $RepoRoot "LLM"
$modelsRoot = Join-Path $llmRoot "models"
$logsRoot = Join-Path $llmRoot "logs"
$stdoutLog = Join-Path $logsRoot "ollama.log"
$stderrLog = Join-Path $logsRoot "ollama.err.log"
$ollamaHost = "127.0.0.1:11434"
$ollamaBaseUrl = "http://$ollamaHost"

New-Item -ItemType Directory -Force -Path $modelsRoot, $logsRoot | Out-Null

[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $modelsRoot, "Process")
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $ollamaHost, "Process")
[Environment]::SetEnvironmentVariable("OLLAMA_LLM_LIBRARY", "cpu", "Process")

function Test-OllamaApi {
  try {
    $response = Invoke-WebRequest -UseBasicParsing "$ollamaBaseUrl/api/version" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Resolve-OllamaExe {
  $command = Get-Command ollama -ErrorAction SilentlyContinue
  $candidates = @()
  if ($command -and $command.Source) {
    $candidates += $command.Source
  }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
    (Join-Path $env:LOCALAPPDATA "Ollama\ollama.exe"),
    (Join-Path $env:ProgramFiles "Ollama\ollama.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Ollama\ollama.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }

  return $null
}

if (Test-OllamaApi) {
  Write-Host "[Voice2Text] Ollama is already running at $ollamaBaseUrl."
  exit 0
}

$ollamaExe = Resolve-OllamaExe
if (-not $ollamaExe) {
  Write-Host "[Voice2Text] Ollama executable was not found. Install Ollama, then run start.bat again."
  exit 2
}

Write-Host "[Voice2Text] Starting Ollama on $ollamaBaseUrl."
Write-Host "[Voice2Text] Ollama models: $modelsRoot"

$process = Start-Process `
  -WindowStyle Hidden `
  -FilePath $ollamaExe `
  -ArgumentList "serve" `
  -WorkingDirectory $llmRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) {
    Write-Host "[Voice2Text] Ollama exited during startup. See $stderrLog"
    exit 3
  }

  if (Test-OllamaApi) {
    Write-Host "[Voice2Text] Ollama is ready."
    exit 0
  }

  Start-Sleep -Milliseconds 500
}

Write-Host "[Voice2Text] Ollama startup timed out. See $stdoutLog and $stderrLog"
exit 4
