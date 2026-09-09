# Codex `notify` script (agent.ts: CODEX_NOTIFY). Codex runs it after every
# completed turn with the event as one JSON argument; the thread id in it is
# what `codex resume` takes, so it is recorded for this pane. No output.
try {
    if (!$env:LOOM_SESSION_FILE) { exit 0 }
    $id = ($args[0] | ConvertFrom-Json).'thread-id'
    if ($id -notmatch '^[a-zA-Z0-9_-]{1,128}$') { exit 0 }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:LOOM_SESSION_FILE)) | Out-Null
    [IO.File]::WriteAllText($env:LOOM_SESSION_FILE, $id)
} catch {
    # Session tracking must never get in the agent's way.
}
