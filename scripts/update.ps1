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
$staged = Join-Path $install ('loom-update-' + [guid]::NewGuid().ToString('N') + '.exe')
$backup = Join-Path $install ('loom-before-update-' + [guid]::NewGuid().ToString('N') + '.exe')
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
    # loomctl.exe (control a running Loom from a terminal) is built beside loom.exe.
    # Nothing keeps it open for long, so a copy replaces it.
    $ctlSource = Join-Path (Split-Path -LiteralPath $Source) 'loomctl.exe'
    $ctlDestination = Join-Path $install 'loomctl.exe'
    if (Test-Path -LiteralPath $ctlSource -PathType Leaf) {
        $ctlHash = (Get-FileHash -LiteralPath $ctlSource -Algorithm SHA256).Hash
        if (-not (Test-Path -LiteralPath $ctlDestination) -or (Get-FileHash -LiteralPath $ctlDestination -Algorithm SHA256).Hash -ne $ctlHash) {
            Copy-Item -LiteralPath $ctlSource -Destination $ctlDestination -Force
            Write-Output "Updated: $ctlDestination"
        }
    } else {
        Write-Warning "No loomctl.exe beside $Source. The installed loomctl was not changed."
    }
    $expected = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $previous = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($expected -eq $previous) {
        Write-Output 'Installed Loom already matches this build. Running sessions were not changed.'
        return
    }
    Copy-Item -LiteralPath $Source -Destination $staged
    if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne $expected) {
        throw 'Staged checksum mismatch. Installed Loom was not changed.'
    }
    try {
        # ReplaceFile preserves the mapped executable for running processes.
        # A backup also lets us recover if Windows fails after renaming the old file.
        [IO.File]::Replace($staged, $destination, $backup)
    } catch {
        if (-not (Test-Path -LiteralPath $destination) -and (Test-Path -LiteralPath $backup)) {
            [IO.File]::Move($backup, $destination)
        }
        throw
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
        [IO.File]::Replace($backup, $destination, $null)
        throw 'Installed checksum mismatch. Restored the previous executable.'
    }
    if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $previous) {
        throw "Backup checksum mismatch: $backup"
    }
    # Earlier runs' backups. One a running Loom still maps stays until a later run.
    Get-ChildItem -LiteralPath $install -Filter 'loom-before-update-*.exe' | Where-Object { $_.FullName -ne $backup } |
        Remove-Item -ErrorAction SilentlyContinue
    Write-Output "Updated: $destination"
    Write-Output "Backup: $backup"
    Write-Output 'Running Loom and its terminals stay open. The update takes effect on the next normal launch.'
} finally {
    try {
        if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
    } finally { $lock.Dispose() }
}
