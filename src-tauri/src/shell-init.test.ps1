# Self-check for shell-init.ps1's exit-code reporting. Run: powershell -NoProfile -File this
# Get-History is stubbed because a non-interactive host records no history.
. "$PSScriptRoot\shell-init.ps1"

$Global:hid = 0
function Global:Get-History { param([int]$Count) [pscustomobject]@{ Id = $Global:hid } }

$fails = 0
function check($label, $expected) {
  $d = if ((Prompt) -match ']133;(D[^\x07]*)') { $Matches[1] } else { '-' }
  if ($d -ne $expected) { Write-Host "FAIL $label : got $d want $expected"; $script:fails++ }
  else { Write-Host "ok   $label -> $d" }
}

$Global:hid = 1; cmd /c exit 0
check 'native success' 'D;0'
check 'no new command' '-'
$Global:hid = 2; cmd /c exit 3
check 'native exit 3' 'D;3'
$Global:hid = 3; Get-Item 'C:\nope-xyz' -ErrorAction SilentlyContinue
check 'cmdlet failure: a failure with no code, not the stale 3' 'D;1;exact=0'
$Global:hid = 4; Get-Date | Out-Null
check 'cmdlet success' 'D;0'
$Global:hid = 5; cmd /c exit 7
check 'native exit 7' 'D;7'
$Global:hid = 6; cmd /c exit 7
check 'native exit 7 again: failed, code unknown rather than a guessed 1' 'D;1;exact=0'
$Global:hid = 7; cmd /c exit 0
check 'then success' 'D;0'

if ($fails) { Write-Host "$fails failed"; exit 1 }
Write-Host 'all ok'
