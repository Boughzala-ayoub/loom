# Self-check for loom-status.ps1: marker written, user's statusline chained.
# Run: powershell -NoProfile -File this
$dir = Join-Path $env:TEMP 'loom-status-ps1-test'
Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$dir\home\.claude" | Out-Null

$fails = 0
function check($label, $ok, $detail = '') {
  if ($ok) { Write-Host "ok   $label" }
  else { Write-Host "FAIL $label $detail"; $script:fails++ }
}

# The child sees a fake HOME (its settings.json names the chained statusline),
# a pane id, and the effort env var; cwd has no .claude to shadow it.
$env:USERPROFILE = "$dir\home"
$env:LOOM_PANE = 'test-pane'
$env:CLAUDE_EFFORT = 'max'
'{"statusLine":{"command":"findstr display_name"}}' |
  Set-Content "$dir\home\.claude\settings.json" -Encoding ascii
$payload = '{"model":{"id":"claude-fable-5","display_name":"Fable 5"}}'
Set-Location $dir
$out = $payload | powershell -NoProfile -File "$PSScriptRoot\loom-status.ps1"

$marker = "$env:TEMP\loom-status\test-pane"
check 'marker written' (Test-Path $marker)
$lines = (Get-Content $marker) -replace [char]0xFEFF, ''
check 'effort env on line 1' ($lines[0] -eq 'max') "got '$($lines[0])'"
check 'payload follows' ($lines[1] -match 'claude-fable-5')
check "user's statusline chained, output through" ("$out" -match 'Fable 5') "got '$out'"

# No configured statusline: marker still written, nothing printed, no error.
Remove-Item "$dir\home\.claude\settings.json"
Remove-Item $marker
$out2 = $payload | powershell -NoProfile -File "$PSScriptRoot\loom-status.ps1"
check 'marker written without a user statusline' (Test-Path $marker)
check 'and nothing printed' (-not "$out2") "got '$out2'"

Remove-Item -Recurse -Force $dir, $marker -ErrorAction SilentlyContinue
if ($fails) { Write-Host "$fails failed"; exit 1 }
Write-Host 'all ok'
