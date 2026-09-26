# Run: powershell -NoProfile -File scripts/update-check.ps1
$ErrorActionPreference = 'Stop'
$update = Join-Path $PSScriptRoot 'update.ps1'
$fixture = Join-Path $env:TEMP ("loom update's test " + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$installed = Join-Path $fixture 'loom.exe'
$source = Join-Path $fixture 'new.exe'
Copy-Item -LiteralPath "$env:SystemRoot/System32/cmd.exe" -Destination $installed
Copy-Item -LiteralPath $installed -Destination $source
# Appending bytes produces a different PE while leaving the original executable valid.
$stream = [IO.File]::OpenWrite($source)
$stream.Position = $stream.Length
$stream.WriteByte(0)
$stream.Dispose()
$oldHash = (Get-FileHash -LiteralPath $installed).Hash
$newHash = (Get-FileHash -LiteralPath $source).Hash
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $installed
$start.Arguments = '/d /q'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$process = [Diagnostics.Process]::Start($start)
try {
    & $update -InstallDir $fixture -Source $source
    if ($process.HasExited) { throw 'Replacement interrupted the running process' }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $newHash) { throw 'Replacement failed' }
    $backups = @(Get-ChildItem -LiteralPath $fixture -Filter 'loom-before-update-*.exe')
    if ($backups.Count -ne 1 -or (Get-FileHash -LiteralPath $backups[0].FullName).Hash -ne $oldHash) { throw 'Backup did not preserve the old executable' }
    & $update -InstallDir $fixture -Source $source
    if (@(Get-ChildItem -LiteralPath $fixture -Filter 'loom-before-update-*.exe').Count -ne 1) { throw 'Repeated update should do nothing' }
    $failed = $false
    try { & $update -InstallDir $fixture -Source (Join-Path $fixture 'missing.exe') } catch { $failed = $true }
    if (-not $failed) { throw 'Missing source must fail' }
    $originalPath = $env:PATH
    Set-Content -LiteralPath (Join-Path $fixture 'npm.cmd') -Value '@exit /b 7' -Encoding Ascii
    try {
        $env:PATH = $fixture + ';' + $originalPath
        $failed = $false
        try { & $update -InstallDir $fixture } catch { $failed = $_.Exception.Message -match 'Build failed' }
        if (-not $failed) { throw 'Build failure must stop the update' }
    } finally { $env:PATH = $originalPath }
    # Deny delete/rename to exercise a failed replacement without touching the installation.
    $held = [IO.File]::Open($installed, 'Open', 'Read', 'Read')
    try {
        $failed = $false
        try { & $update -InstallDir $fixture -Source $backups[0].FullName } catch { $failed = $true }
        if (-not $failed) { throw 'Locked destination must fail' }
    } finally { $held.Dispose() }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $newHash) { throw 'Failed update changed the installation' }
    if (@(Get-ChildItem -LiteralPath $fixture -Filter 'loom-update-*.exe').Count) { throw 'Staged files leaked after failure' }
    if ($process.HasExited) { throw 'Failed update interrupted the process' }
    # Prove the original process still accepts input after replacement and failure.
    $process.StandardInput.WriteLine('echo LOOM_UPDATE_ALIVE')
    $process.StandardInput.WriteLine('exit')
    $output = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    if ($output -notmatch 'LOOM_UPDATE_ALIVE') { throw 'Running process stopped responding' }
    Write-Output 'PASS: running executable updated, backup verified, repeat skipped, build and replacement failures leave installation intact.'
} finally {
    if (-not $process.HasExited) { $process.StandardInput.WriteLine('exit'); $process.WaitForExit() }
    $process.Dispose()
    # Only the files this check created in its unique temporary directory.
    Get-ChildItem -LiteralPath $fixture -File | Remove-Item -Force
    Remove-Item -LiteralPath $fixture
}
