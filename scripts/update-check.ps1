# Run: powershell -NoProfile -File scripts/update-check.ps1
$ErrorActionPreference = 'Stop'
$update = Join-Path $PSScriptRoot 'update.ps1'
$fixture = Join-Path $env:TEMP ("loom update's test " + [guid]::NewGuid().ToString('N'))
$install = Join-Path $fixture 'install'
$build = Join-Path $fixture 'build'
New-Item -ItemType Directory -Path $install, $build | Out-Null
$installed = Join-Path $install 'loom.exe'
$source = Join-Path $build 'loom.exe'
Copy-Item -LiteralPath "$env:SystemRoot/System32/cmd.exe" -Destination $installed
Copy-Item -LiteralPath $installed -Destination $source
# Appending bytes produces a different PE while leaving the original executable valid.
$stream = [IO.File]::OpenWrite($source)
$stream.Position = $stream.Length
$stream.WriteByte(0)
$stream.Dispose()
# loomctl.exe, built and installed beside it: the pair changes together.
Copy-Item -LiteralPath $installed -Destination (Join-Path $install 'loomctl.exe')
Copy-Item -LiteralPath $source -Destination (Join-Path $build 'loomctl.exe')
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
    # A loom.exe with no loomctl.exe beside it installs neither (review RF11).
    $alone = Join-Path $fixture 'alone'
    New-Item -ItemType Directory -Path $alone | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $alone 'loom.exe')
    $failed = $false
    try { & $update -InstallDir $install -Source (Join-Path $alone 'loom.exe') } catch { $failed = $_.Exception.Message -match 'loomctl' }
    if (-not $failed) { throw 'A loom.exe without its loomctl.exe must not install' }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $oldHash) { throw 'An update without loomctl.exe changed loom.exe' }
    & $update -InstallDir $install -Source $source
    if ($process.HasExited) { throw 'Replacement interrupted the running process' }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $newHash) { throw 'Replacement failed' }
    if ((Get-FileHash -LiteralPath (Join-Path $install 'loomctl.exe')).Hash -ne $newHash) { throw 'loomctl.exe was not replaced with loom.exe' }
    $backups = @(Get-ChildItem -LiteralPath $install -Filter 'loom-before-update-*.exe')
    if ($backups.Count -ne 1 -or (Get-FileHash -LiteralPath $backups[0].FullName).Hash -ne $oldHash) { throw 'Backup did not preserve the old executable' }
    & $update -InstallDir $install -Source $source
    if (@(Get-ChildItem -LiteralPath $install -Filter 'loom-before-update-*.exe').Count -ne 1) { throw 'Repeated update should do nothing' }
    $failed = $false
    try { & $update -InstallDir $install -Source (Join-Path $build 'missing.exe') } catch { $failed = $true }
    if (-not $failed) { throw 'Missing source must fail' }
    $originalPath = $env:PATH
    Set-Content -LiteralPath (Join-Path $fixture 'npm.cmd') -Value '@exit /b 7' -Encoding Ascii
    try {
        $env:PATH = $fixture + ';' + $originalPath
        $failed = $false
        try { & $update -InstallDir $install } catch { $failed = $_.Exception.Message -match 'Build failed' }
        if (-not $failed) { throw 'Build failure must stop the update' }
    } finally { $env:PATH = $originalPath }
    # Deny delete/rename to exercise a failed replacement without touching the installation.
    $held = [IO.File]::Open($installed, 'Open', 'Read', 'Read')
    try {
        $failed = $false
        try { & $update -InstallDir $install -Source $backups[0].FullName } catch { $failed = $true }
        if (-not $failed) { throw 'Locked destination must fail' }
    } finally { $held.Dispose() }
    if ((Get-FileHash -LiteralPath $installed).Hash -ne $newHash) { throw 'Failed update changed the installation' }
    if (@(Get-ChildItem -LiteralPath $install -Filter '*-update-*.exe' | Where-Object { $_.Name -notlike '*-before-update-*' }).Count) { throw 'Staged files leaked after failure' }
    if ($process.HasExited) { throw 'Failed update interrupted the process' }
    # Prove the original process still accepts input after replacement and failure.
    $process.StandardInput.WriteLine('echo LOOM_UPDATE_ALIVE')
    $process.StandardInput.WriteLine('exit')
    $output = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    if ($output -notmatch 'LOOM_UPDATE_ALIVE') { throw 'Running process stopped responding' }
    Write-Output 'PASS: no pair without loomctl, running executables updated together, backup verified, repeat skipped, build and replacement failures leave installation intact.'
} finally {
    if (-not $process.HasExited) { $process.StandardInput.WriteLine('exit'); $process.WaitForExit() }
    $process.Dispose()
    # Only what this check created, in its own temporary folder.
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
