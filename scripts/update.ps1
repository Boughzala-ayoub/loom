param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Loom'),
    [string]$Source
)

$ErrorActionPreference = 'Stop'
$install = (Resolve-Path -LiteralPath $InstallDir).Path
$destination = Join-Path $install 'loom.exe'
if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    throw "Loom is not installed at $install. Run the installer first, or pass -InstallDir."
}
# Serialize updates to this installation. Keep the lock file to avoid a delete/open race.
$lock = [IO.File]::Open((Join-Path $install '.update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$hash = { param($path) (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
$plan = @() # the executables this update changes
try {
    if (-not $Source) {
        $root = Split-Path $PSScriptRoot -Parent
        Push-Location -LiteralPath $root
        try {
            & npm.cmd run tauri build -- --no-bundle
            if ($LASTEXITCODE -ne 0) { throw 'Build failed. Installed Loom was not changed.' }
        } finally { Pop-Location }
        $Source = Join-Path $root 'src-tauri/target/release/loom.exe'
    }
    # loom.exe and loomctl.exe (control a running Loom from a terminal), built
    # side by side, go in together: both or neither, so a protocol change never
    # leaves a mismatched pair. Either may be running (a `loomctl watch --follow`
    # outlives Loom), so each is replaced the same way: ReplaceFile renames the
    # mapped file aside, and running processes keep using it.
    $ctlSource = Join-Path (Split-Path -LiteralPath $Source) 'loomctl.exe'
    $files = @(@{ Name = 'loom'; Source = $Source; Destination = $destination })
    if (Test-Path -LiteralPath $ctlSource -PathType Leaf) {
        $files += @{ Name = 'loomctl'; Source = $ctlSource; Destination = (Join-Path $install 'loomctl.exe') }
    } else {
        Write-Warning "No loomctl.exe beside $Source. The installed loomctl was not changed."
    }
    foreach ($f in $files) {
        $f.Expected = & $hash $f.Source
        $f.Previous = if (Test-Path -LiteralPath $f.Destination) { & $hash $f.Destination }
        if ($f.Expected -ne $f.Previous) { $plan += $f }
    }
    if (-not $plan) {
        Write-Output 'Installed Loom already matches this build. Running sessions were not changed.'
        return
    }
    # Stage every file first: nothing installed changes until all of them check out.
    foreach ($f in $plan) {
        $id = [guid]::NewGuid().ToString('N')
        $f.Staged = Join-Path $install "$($f.Name)-update-$id.exe"
        $f.Backup = Join-Path $install "$($f.Name)-before-update-$id.exe"
        Copy-Item -LiteralPath $f.Source -Destination $f.Staged
        if ((& $hash $f.Staged) -ne $f.Expected) { throw "Staged $($f.Name).exe checksum mismatch. Installed Loom was not changed." }
    }
    $done = @()
    try {
        foreach ($f in $plan) {
            try {
                # A backup also lets us recover if Windows fails after renaming the old file.
                if ($f.Previous) { [IO.File]::Replace($f.Staged, $f.Destination, $f.Backup) } else { [IO.File]::Move($f.Staged, $f.Destination) }
            } catch {
                if (-not (Test-Path -LiteralPath $f.Destination) -and (Test-Path -LiteralPath $f.Backup)) { [IO.File]::Move($f.Backup, $f.Destination) }
                throw
            }
            $done += $f
            if ((& $hash $f.Destination) -ne $f.Expected) { throw "Installed $($f.Name).exe checksum mismatch." }
            if ($f.Previous -and (& $hash $f.Backup) -ne $f.Previous) { throw "Backup checksum mismatch: $($f.Backup)" }
        }
    } catch {
        # The previous pair goes back, never half of a new one.
        foreach ($f in $done) {
            # [NullString]: PowerShell passes $null to a string as "", which Replace refuses.
            if ($f.Previous) { [IO.File]::Replace($f.Backup, $f.Destination, [NullString]::Value) } else { Remove-Item -LiteralPath $f.Destination }
        }
        throw "$_ Restored the previous executables."
    }
    foreach ($f in $plan) {
        # Earlier runs' backups. One a running process still maps stays until a later run.
        Get-ChildItem -LiteralPath $install -Filter "$($f.Name)-before-update-*.exe" | Where-Object { $_.FullName -ne $f.Backup } |
            Remove-Item -ErrorAction SilentlyContinue
        Write-Output "Updated: $($f.Destination)"
        if ($f.Previous) { Write-Output "Backup: $($f.Backup)" }
    }
    Write-Output 'Running Loom and its terminals stay open. The update takes effect on the next normal launch.'
} finally {
    try {
        foreach ($f in $plan) { if ($f.Staged -and (Test-Path -LiteralPath $f.Staged)) { Remove-Item -LiteralPath $f.Staged } }
    } finally { $lock.Dispose() }
}
