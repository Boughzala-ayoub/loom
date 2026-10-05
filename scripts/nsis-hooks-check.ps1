# Run: powershell -NoProfile -File scripts/nsis-hooks-check.ps1
# src-tauri/nsis-hooks.nsi in a small installer of its own, around the steps
# Tauri's template takes between its hooks, installing into a scratch folder.
# The template's kill and the PATH edit are left out: nothing here touches an
# installed Loom or the user's PATH.
$ErrorActionPreference = 'Stop'
$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path -LiteralPath $makensis)) { throw "makensis isn't at $makensis (tauri build downloads it)" }
$hooks = Join-Path $PSScriptRoot '..\src-tauri\nsis-hooks.nsi' | Resolve-Path
$fixture = Join-Path $env:TEMP ("loom nsis hooks " + [guid]::NewGuid().ToString('N'))
$src = Join-Path $fixture 'build'
New-Item -ItemType Directory -Path $src | Out-Null
Set-Content -LiteralPath (Join-Path $src 'loom.exe') -Value 'new loom' -NoNewline
Set-Content -LiteralPath (Join-Path $src 'loomctl.exe') -Value 'new loomctl' -NoNewline

# $ignored: the template's loom.exe write failed and Ignore was chosen at its
# prompt, so nothing was written and the error flag is set.
function Build($name, $ignored) {
    $inst = Join-Path $fixture "$name\install"
    $nsi = Join-Path $fixture "$name.nsi"
    @"
Unicode true
!define MAINBINARYNAME "loom"
!define PRODUCTNAME "Loom"
!define MAINBINARYSRCPATH "$src\loom.exe"
!macro CheckIfAppIsRunning exe product
!macroend
Name "Loom hooks check"
OutFile "$fixture\$name.exe"
RequestExecutionLevel user
SilentInstall silent
InstallDir "$inst"
!include "$hooks"
!macroundef LoomUserPath
!macro LoomUserPath script
!macroend
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  SetOutPath `$`INSTDIR
  $(if ($ignored) { 'SetErrors' } else { "SetOverwrite try`r`n  File `"/oname=loom.exe`" `"`${MAINBINARYSRCPATH}`"`r`n  SetOverwrite on" })
  File "/oname=loomctl.exe" "$src\loomctl.exe"
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
"@ | Set-Content -LiteralPath $nsi -Encoding UTF8
    $out = & $makensis -V2 $nsi 2>&1
    if ($LASTEXITCODE -ne 0) { throw "makensis failed for ${name}:`n$($out -join "`n")" }
    New-Item -ItemType Directory -Path $inst | Out-Null
    Set-Content -LiteralPath (Join-Path $inst 'loom.exe') -Value 'old loom' -NoNewline
    Set-Content -LiteralPath (Join-Path $inst 'loomctl.exe') -Value 'old loomctl' -NoNewline
    return $inst
}
function Run($name, $inst) {
    $p = Start-Process -FilePath (Join-Path $fixture "$name.exe") -ArgumentList '/S' -Wait -PassThru
    $pair = @('loom.exe', 'loomctl.exe') | ForEach-Object { Get-Content -LiteralPath (Join-Path $inst $_) -Raw }
    $left = @(Get-ChildItem -LiteralPath $inst -Filter '*.old').Count
    return @{ code = $p.ExitCode; pair = ($pair -join ', '); left = $left }
}

try {
    $inst = Build 'plain' $false
    $r = Run 'plain' $inst
    if ($r.code -ne 0 -or $r.pair -ne 'new loom, new loomctl' -or $r.left) { throw "An ordinary install: exit $($r.code), $($r.pair), $($r.left) old images left" }

    # Review R14-5: the template's loom.exe write was ignored. The install goes
    # on to loomctl.exe; the pair is in only if loom.exe is the new one too.
    $inst = Build 'ignored' $true
    $r = Run 'ignored' $inst
    if ($r.code -eq 0 -and $r.pair -ne 'new loom, new loomctl') { throw "An ignored loom.exe write still reported a pair installed: $($r.pair)" }
    if ($r.code -ne 0 -and $r.pair -ne 'old loom, old loomctl') { throw "A failed install left $($r.pair)" }

    # loom.exe can't be moved aside (a handle that shares neither delete nor
    # write): no backup, so no install over it in place. Everything stays.
    $inst = Build 'locked' $false
    $lock = [IO.File]::Open((Join-Path $inst 'loom.exe'), 'Open', 'Read', 'Read')
    try { $r = Run 'locked' $inst } finally { $lock.Dispose() }
    if ($r.code -eq 0) { throw "loom.exe couldn't be moved aside, and the install still reported success: $($r.pair)" }
    if ($r.pair -ne 'old loom, old loomctl' -or $r.left) { throw "A refused install left $($r.pair), $($r.left) old images" }
    Write-Output 'ok   The installer hooks put in both new executables or keep both old ones'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
