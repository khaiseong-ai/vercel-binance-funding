$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $env:LOCALAPPDATA "ks-funding"
$logPath = Join-Path $stateRoot "funding-sheet.log"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
Set-Location -LiteralPath $projectRoot

try {
  $output = & $nodePath (Join-Path $PSScriptRoot "funding-sheet.mjs") 2>&1
  $line = "{0} OK {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), ($output -join " ")
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  exit 0
} catch {
  $line = "{0} ERROR {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $_.Exception.Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  exit 1
}
