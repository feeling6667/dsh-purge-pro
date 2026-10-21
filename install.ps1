# dsh-purge 0.2.1 install launcher.
#
# Deliberately has NO param() block: PowerShell would try to bind "--dry-run"
# as a parameter name and fail. With a bare $args scan both spellings work.
#
# Usage, from the folder that contains this file:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 web
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 both
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 desktop --dry-run
#
# All Chinese output comes from install.mjs under node, so this file stays
# ASCII-only and there is no .ps1 source-encoding trap.

$ErrorActionPreference = "Stop"

# make node's UTF-8 output render instead of mojibake
try { chcp 65001 > $null } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$rest = @($args)
$surface = "desktop"
foreach ($a in $rest) {
  if ($a -match '^(desktop|web|both)$') { $surface = $a; break }
}
$dry = $false
foreach ($a in $rest) {
  if ($a -match '^--?dry-?run$' -or $a -match '^--?dry$') { $dry = $true; break }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $here "install.mjs"
if (-not (Test-Path -LiteralPath $entry)) {
  Write-Host "[FAIL] install.mjs not found next to this script: $entry"
  exit 1
}

function Find-Node {
  $homes = @()
  if ($env:DSH_HOME) { $homes += $env:DSH_HOME }
  $homes += (Join-Path $env:USERPROFILE ".dsh")
  foreach ($h in $homes) {
    $rt = Join-Path $h "dsh-runtimes"
    if (-not (Test-Path -LiteralPath $rt)) { continue }
    $cand = Get-ChildItem -LiteralPath $rt -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "dependencies\node\bin\node.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($cand) { return $cand }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host "[FAIL] No node.exe found (neither DSH bundled runtime nor PATH)."
  Write-Host "       Expected something like: %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  exit 1
}

Write-Host "node  : $node"
Write-Host "entry : $entry"
Write-Host ""

$argList = @($entry, $surface)
if ($dry) { $argList += "--dry-run" }

& $node @argList
exit $LASTEXITCODE
