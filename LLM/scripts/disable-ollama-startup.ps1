$ErrorActionPreference = "Stop"

$removed = @()
$runKeys = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
)

foreach ($runKey in $runKeys) {
  if (-not (Test-Path $runKey)) {
    continue
  }

  $properties = Get-ItemProperty -Path $runKey
  foreach ($property in $properties.PSObject.Properties) {
    if ($property.Name -like "PS*") {
      continue
    }

    $nameMatches = $property.Name -match "Ollama|ollama"
    $valueMatches = [string]$property.Value -match "Ollama|ollama"
    if ($nameMatches -or $valueMatches) {
      Remove-ItemProperty -Path $runKey -Name $property.Name -ErrorAction Stop
      $removed += "$runKey\$($property.Name)"
    }
  }
}

$startupFolder = [Environment]::GetFolderPath("Startup")
if ($startupFolder -and (Test-Path $startupFolder)) {
  Get-ChildItem -Path $startupFolder -Force |
    Where-Object { $_.Name -match "Ollama|ollama" } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force
      $removed += $_.FullName
    }
}

if ($removed.Count -eq 0) {
  Write-Host "[Voice2Text] No per-user Ollama startup entry was found."
} else {
  Write-Host "[Voice2Text] Removed Ollama startup entries:"
  $removed | ForEach-Object { Write-Host "  $_" }
}
