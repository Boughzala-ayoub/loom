param([int]$Root, [double]$Seconds = 8)
# Read-only: CPU% (of one core) over an interval for a process tree, its main thread, and WebView2 renderer/gpu/browser.
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$kids = @{}; foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = @() }; $kids[$k] += $p }
$tree = @(); $q = New-Object System.Collections.Queue; $q.Enqueue($Root); $seen = @{}
while ($q.Count) { $id = $q.Dequeue(); if ($seen[$id]) { continue }; $seen[$id] = 1; $tree += $id; foreach ($c in $kids[$id]) { $q.Enqueue([int]$c.ProcessId) } }
$kind = @{}; foreach ($id in $tree) { $c = ($all | Where-Object ProcessId -eq $id); $n = $c.Name; if ($n -eq 'msedgewebview2.exe') { if ($c.CommandLine -match '--type=([a-z-]+)') { $n = 'wv-' + $Matches[1] } else { $n = 'wv-browser' } }; $kind[$id] = $n }
$rootProc = Get-Process -Id $Root
$main = $rootProc.Threads | Sort-Object StartTime | Select-Object -First 1
$mainId = $main.Id; $mainBefore = $main.TotalProcessorTime.TotalMilliseconds
$before = @{}; foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $before[$id] = $p.TotalProcessorTime.TotalMilliseconds } }
$sw = [Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds ([int]($Seconds * 1000)); $el = $sw.Elapsed.TotalMilliseconds
$groups = @{}
foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $before.ContainsKey($id)) { $n = $kind[$id]; $groups[$n] = [math]::Round(($groups[$n] + ($p.TotalProcessorTime.TotalMilliseconds - $before[$id]) / $el * 100), 2) } }
$mainNow = ((Get-Process -Id $Root).Threads | Where-Object Id -eq $mainId).TotalProcessorTime.TotalMilliseconds
$groups['loom-main-thread'] = [math]::Round(($mainNow - $mainBefore) / $el * 100, 2)
$groups | ConvertTo-Json -Compress
