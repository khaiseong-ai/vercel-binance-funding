$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $env:LOCALAPPDATA "ks-funding"
$logPath = Join-Path $stateRoot "local-button-server.log"
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
try {
  $env:FUNDING_LOCAL_ENV = Join-Path $projectRoot ".env.local"
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  Set-Location -LiteralPath $projectRoot
  & $nodePath (Join-Path $PSScriptRoot "local-button-server.mjs") $env:FUNDING_LOCAL_ENV *>> $logPath
} catch {
  $line = "{0} STARTUP_ERROR {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $_.Exception.Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  exit 1
}
