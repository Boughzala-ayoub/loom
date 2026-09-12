# Codex `notify` script (agent.ts: CODEX_NOTIFY). Codex runs it after every
# completed turn with the event as one JSON argument; the thread id in it is
# what `codex resume` takes, so it is recorded for this pane. No output.
try {
    if (!$env:LOOM_SESSION_FILE) { exit 0 }
    $id = ($args[0] | ConvertFrom-Json).'thread-id'
    if ($id -notmatch '^[a-zA-Z0-9_-]{1,128}$') { exit 0 }
    # Internal/ephemeral agents inherit notify too. Only persist a real root
    # rollout; an internal thread id may have no saved conversation at all.
    $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $rollout = Get-ChildItem -LiteralPath (Join-Path $codexDir 'sessions') -Filter "rollout-*-$id.jsonl" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$rollout) { exit 0 }
    $meta = Get-Content -LiteralPath $rollout.FullName -TotalCount 1 | ConvertFrom-Json
    if ($meta.type -ne 'session_meta' -or $meta.payload.id -ne $id -or $meta.payload.source.subagent) { exit 0 }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:LOOM_SESSION_FILE)) | Out-Null
    [IO.File]::WriteAllText($env:LOOM_SESSION_FILE, $id)
} catch {
    # Session tracking must never get in the agent's way.
}
