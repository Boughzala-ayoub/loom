# Loom's statusline tee. Claude Code re-runs the statusline command with a
# fresh JSON payload every time session state changes — model, effort, cost —
# which makes it the one push-based signal that follows /model and /effort the
# moment they run, hand-typed or panel-applied. Capture the payload for Loom
# (usage.rs reads the marker), then hand it to the statusline the user actually
# configured, so their bar keeps drawing exactly what it always did.
$in = [Console]::In.ReadToEnd()
if ($env:LOOM_PANE) {
  try {
    $d = "$env:TEMP\loom-status"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    # Line 1: the effort env var — payloads have not always carried effort —
    # then the payload itself. usage.rs prefers the payload's effort.level.
    Set-Content -LiteralPath "$d\$env:LOOM_PANE" -Value "$env:CLAUDE_EFFORT`n$in" -Encoding utf8 -NoNewline
  } catch {}
}
# Chain to the user's own statusline — theirs, not ours, is what the bar shows.
# Project settings beat user settings, matching Claude Code's own precedence.
foreach ($p in @("$pwd\.claude\settings.json", "$env:USERPROFILE\.claude\settings.json")) {
  try {
    $cmd = (Get-Content -Raw -LiteralPath $p -ErrorAction Stop | ConvertFrom-Json).statusLine.command
    if ($cmd) { $in | cmd /c $cmd; break }
  } catch {}
}
