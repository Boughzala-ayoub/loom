# Loom shell integration.
# Emits OSC 133 marks so the UI can slice the stream into command blocks:
#   A = prompt start (block top)   B = prompt end / input start
#   E;<cmd> = command line         C = output start
#   D;<exit> = command finished
# Modelled on the FinalTerm/VS Code semantic-prompt protocol.

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$Global:OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { Import-Module PSReadLine -ErrorAction Stop } catch {}

# Re-dot-sourcing must not capture our own wrappers (infinite recursion).
if (-not $Global:__bsPrompt) { $Global:__bsPrompt = $function:Prompt }
if (-not $Global:__bsReadLine) { $Global:__bsReadLine = $function:PSConsoleHostReadLine }
$Global:__bsLastId = -1

function Global:__bsOsc([string]$body) { "$([char]27)]133;$body$([char]7)" }

function Global:__bsEsc([string]$v) {
  if ([string]::IsNullOrEmpty($v)) { return '' }
  $v = $v.Replace('\', '\\')
  $v = $v.Replace([string][char]27, '\x1b')
  $v = $v.Replace([string][char]7, '\x07')
  $v = $v.Replace("`n", '\x0a')
  $v = $v.Replace("`r", '\x0d')
  $v = $v.Replace(';', '\x3b')
  $v
}

function Global:Prompt() {
  $__ok = $?
  $__exit = $global:LASTEXITCODE
  $out = ''
  $h = Get-History -Count 1
  if ($h -and $h.Id -ne $Global:__bsLastId) {
    $Global:__bsLastId = $h.Id
    # $? decides pass/fail; LASTEXITCODE only supplies the number, and only if it
    # actually moved -- PowerShell leaves it stale after a failing cmdlet. When it
    # didn't move, the command failed with a code we can't know: a cmdlet, or a
    # native command exiting the same as the last one. The mark says so
    # (D;1;exact=0) rather than guess, since loomctl shows the code to scripts.
    # ponytail: exact repeats would need a native-command hook.
    $mark = if ($__ok) { 'D;0' }
            elseif ($null -ne $__exit -and $__exit -ne 0 -and $__exit -ne $Global:__bsPrevExit) { "D;$__exit" }
            else { 'D;1;exact=0' }
    $out += (__bsOsc $mark)
  }
  $out += (__bsOsc 'A')
  $out += (& $Global:__bsPrompt)
  $out += (__bsOsc 'B')
  $Global:__bsPrevExit = $__exit
  $global:LASTEXITCODE = $__exit
  $out
}

if ($Global:__bsReadLine) {
  function Global:PSConsoleHostReadLine {
    $line = $Global:__bsReadLine.Invoke()
    [Console]::Write((__bsOsc ('E;' + (__bsEsc ([string]$line)))) + (__bsOsc 'C'))
    $line
  }
}
