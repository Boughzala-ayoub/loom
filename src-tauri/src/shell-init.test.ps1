# Self-check for shell-init.ps1's exit-code reporting. Run: powershell -NoProfile -File this
# Get-History is stubbed because a non-interactive host records no history.
. "$PSScriptRoot\shell-init.ps1"

$Global:hid = 0
function Global:Get-History { param([int]$Count) [pscustomobject]@{ Id = $Global:hid } }

$fails = 0
function check($label, $expected) {
  $d = if ((Prompt) -match ']133;D;(\d+)') { $Matches[1] } else { '-' }
  if ($d -ne $expected) { Write-Host "FAIL $label : got $d want $expected"; $script:fails++ }
  else { Write-Host "ok   $label -> $d" }
}

$Global:hid = 1; cmd /c exit 0
check 'native success' '0'
check 'no new command' '-'
$Global:hid = 2; cmd /c exit 3
check 'native exit 3' '3'
$Global:hid = 3; Get-Item 'C:\nope-xyz' -ErrorAction SilentlyContinue
check 'cmdlet failure (not the stale 3)' '1'
$Global:hid = 4; Get-Date | Out-Null
check 'cmdlet success' '0'

if ($fails) { Write-Host "$fails failed"; exit 1 }
Write-Host 'all ok'
