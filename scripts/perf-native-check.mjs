// Native cost probe for docs/performance-plan.md. Needs src-tauri/target/release/loom.exe built with
// --features tauri/custom-protocol (or LOOM_TEST_EXE). Temporary profile and test PTYs only.
// Usage: node scripts/perf-native-check.mjs [ipc] [keys] [opencode] [ack] [shutdown] [agents] | app | restore
// (default: all but agents, app and restore)
//   ipc       CPU per output message: 1 quiet pane, then 12 and 24 panes redrawing at 10 Hz
//   keys      keystroke round trip idle and with 8 and 18 slow Git calls in flight
//   opencode  keystroke round trip with 5 stalled OpenCode 2 reads, alone and with a Git burst
//             that fills the rest of Tauri's async pool; also how long the reads take and their errors
//   ack       CPU of pty_ack alone at 310 calls a second, no output
//   shutdown  pty_shutdown time with 24 quiet panes (kills every pane, so it runs last)
//   agents    a real claude pane and a real opencode2 pane, no prompts sent: their process trees,
//             then what is still alive after pty_shutdown. Opt-in, since it starts your installed
//             CLIs. claude runs in CLAUDE_DIR (default: this checkout), which Claude Code must
//             already trust.
//   app       alone: 24 app panes (8 threads of 3) whose children redraw at 10 Hz, so output goes
//             through the real frontend. Invokes a second and CPU, then the window minimized for
//             60 s: each child logs its longest wait between redraws, which grows when its output
//             pipe fills because Loom stopped reading.
//   restore   alone: a workspace of 8 claude panes in CLAUDE_DIR, restored as Loom starts. Loom starts
//             claude two at a time and frees a slot when a pane's SessionStart marker lands, so this
//             times each marker from launch. Opt-in: starts your installed claude, no prompts sent.
// Numbers only, no pass/fail. Restores the shared files a test Loom rewrites. Kills only its own tree.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir, availableParallelism } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ALL = ['ipc', 'keys', 'opencode', 'ack', 'shutdown', 'agents', 'app', 'restore'];
const modes = process.argv.length > 2 ? process.argv.slice(2) : ALL.filter(m => !['agents', 'app', 'restore'].includes(m));
for (const m of modes) if (!ALL.includes(m)) throw new Error(`Unknown mode ${m}. Modes: ${ALL.join(', ')}`);
const run = m => modes.includes(m);
if (run('shutdown') && run('agents')) throw new Error('shutdown and agents each end every pane; run them separately');
for (const m of ['app', 'restore']) if (run(m) && modes.length > 1) throw new Error(`${m} starts its own workspace; run it alone`);
const out = resolve('node_modules/.cache/perf-native-check');
mkdirSync(out, { recursive: true });
const procJson = fileURLToPath(new URL('proc-json.ps1', import.meta.url));
// A test Loom rewrites these for the installed app too: on every pane spawn, and the plugin on an
// OpenCode spawn.
const data = join(process.env.APPDATA, 'dev.ayoub.loom');
const plugin = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins/loom.js');
const shared = [join(data, 'claude-hooks.json'), join(data, 'shell-init.ps1'), plugin]
  .map((file, i) => ({ file, backup: join(out, `${i}-${basename(file)}.backup`), had: existsSync(file) }));
for (const s of shared) if (s.had) copyFileSync(s.file, s.backup);
const dir = mkdtempSync(join(tmpdir(), 'loom-perf-native-'));
const profile = join(dir, 'workspace.json');
writeFileSync(profile, '{}');
// app: the redraw child logs, once a second, its time, redraw count and longest wait between redraws.
const APP_PANES = 24;
const appLogs = [...Array(APP_PANES).keys()].map(i => join(dir, 'stats', `${i}.log`));
if (run('app')) {
  mkdirSync(join(dir, 'stats'));
  writeFileSync(join(dir, 'app-child.js'), `const log = process.argv[2]; let n = 0, last = Date.now(), worst = 0;
setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; process.stdout.write('\\x1b[?25l\\x1b[3;1H\\x1b[2K\\x1b[38;5;208m*\\x1b[0m Working (' + (n++) + ' esc to interrupt) ' + '-'.repeat(60) + '\\x1b[?25h'); }, 100);
setInterval(() => { require('fs').appendFileSync(log, Date.now() + ' ' + n + ' ' + worst + '\\n'); worst = 0; }, 1000);`);
  // A restored thread needs a Git folder.
  spawnSync('git', ['init', '-q', dir]);
  writeFileSync(profile, JSON.stringify({ ui: { thread: 0 }, threads: Array.from({ length: APP_PANES / 3 }, (_, t) => ({
    repo: dir, dir, name: `perf-${t}`, panes: [0, 1, 2].map(j => ({ cmd: `node ${join(dir, 'app-child.js')} ${appLogs[t * 3 + j]}` })),
  })) }));
}
const claudeDir = process.env.CLAUDE_DIR || process.cwd();
if (run('restore')) writeFileSync(profile, JSON.stringify({ ui: { thread: 0 }, threads: [
  { repo: claudeDir, dir: claudeDir, name: 'perf-restore', panes: Array.from({ length: 8 }, () => ({ cmd: 'claude' })) },
] }));
// A TUI-like child: redraws a status line at a fixed rate, echoes input back.
writeFileSync(join(dir, 'tui.js'), `let n = 0; const hz = +process.argv[2];
process.stdin.setRawMode?.(true); process.stdin.on('data', d => process.stdout.write('\\x1b[5;1H\\x1b[2Kin:' + d.toString('hex')));
if (hz) setInterval(() => process.stdout.write('\\x1b[?25l\\x1b[3;1H\\x1b[2K\\x1b[38;5;208m*\\x1b[0m Working (' + (n++) + ' esc to interrupt) ' + '-'.repeat(60) + '\\x1b[?25h'), 1000 / hz);
else setInterval(() => {}, 1000);`);
// An OpenCode 2 that answers --version and then hangs, the way opencode.rs's routing test fakes the CLI.
// It goes first on Loom's Path too: with NoDefaultCurrentDirectoryInExePath set (Claude Code sets it),
// cmd.exe skips the read's working folder and would run the real opencode.
const ocDir = join(dir, 'opencode');
mkdirSync(ocDir);
writeFileSync(join(ocDir, 'opencode.cmd'), `@echo off\r\nif "%~1"=="--version" (echo opencode v2.0.18 & exit /b 0)\r\n"${process.execPath}" -e "setInterval(()=>{},1000)"\r\n`);
// PATH from Git Bash, Path from PowerShell. Node keeps only one of two spellings.
const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const launched = Date.now();
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [profile], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, [pathKey]: ocDir + ';' + process.env[pathKey], WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
const sampleCpu = secs => JSON.parse(spawnSync('powershell', ['-NoProfile', '-File', procJson, '-Root', String(child.pid), '-Seconds', String(secs)], { encoding: 'utf8' }).stdout.trim());
// Everything under Loom but WebView2, with start times so a reused PID doesn't count as alive.
const powershell = command => JSON.parse(spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).stdout.trim() || '[]');
const paneTree = () => [].concat(powershell(`
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
  $queue = @(${child.pid}); $found = @()
  while ($queue.Count) {
    $id = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
    $parent = ($all | Where-Object ProcessId -eq $id).Name
    foreach ($p in $all | Where-Object ParentProcessId -eq $id) { if ($p.Name -ne 'msedgewebview2.exe') { $found += $p | Add-Member parent $parent -PassThru; $queue += $p.ProcessId } }
  }
  @($found | ForEach-Object { @{ pid = $_.ProcessId; name = $_.parent + ' > ' + $_.Name; start = $_.CreationDate.ToString('o') } }) | ConvertTo-Json -Compress`));
const alive = procs => {
  const now = new Set([].concat(powershell(`@(Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString('o'))" }) | ConvertTo-Json -Compress`)));
  return procs.filter(p => now.has(`${p.pid}|${p.start}`));
};
let browser;
const report = {};
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { ready = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false); if (!ready) await pause(100); }
  if (!ready) throw new Error('webview did not start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  await pause(3000);
  const spawnPanes = (n, hz) => page.evaluate(async ({ n, hz, node, dir }) => {
    const { invoke, Channel } = window.__TAURI__.core;
    window.perf ??= { msgs: 0, bytes: 0, ids: [], channels: [] };
    for (let i = 0; i < n; i++) {
      const id = `perf-${hz}-${i}-${Date.now()}`;
      const out = new Channel();
      out.onmessage = d => { window.perf.msgs++; window.perf.bytes += d.length; void invoke('pty_ack', { channel: out.id }); if (d.includes('\x1b[6n')) void invoke('pty_write', { id, data: '\x1b[1;1R' }).catch(() => {}); if (window.perf.echo && d.includes('in:')) window.perf.echo(); };
      await invoke('pty_spawn', { id, cwd: dir, argv: [node, dir + '\\tui.js', String(hz)], cols: 120, rows: 30, onOut: out });
      window.perf.ids.push(id);
      window.perf.channels.push(out.id);
    }
  }, { n, hz, node: process.execPath, dir });
  // Rates use the page's clock: the CPU sample also spans PowerShell's startup, and CDP events queued
  // while spawnSync blocks delay the next reply by a second or more.
  const count = () => page.evaluate(() => ({ msgs: window.perf?.msgs || 0, bytes: window.perf?.bytes || 0, t: performance.now() }));
  const measure = async (name, secs = 8) => {
    const a = await count();
    const cpu = sampleCpu(secs);
    const b = await count();
    const r = { msgsPerSec: +((b.msgs - a.msgs) / ((b.t - a.t) / 1000)).toFixed(1), avgBytes: b.msgs > a.msgs ? Math.round((b.bytes - a.bytes) / (b.msgs - a.msgs)) : 0, cpu };
    console.log(name.padEnd(34), JSON.stringify(r));
    report[name] = r;
  };
  if (run('ipc')) await measure('baseline, no panes', 6);
  // Pane 0 stays quiet: the keystroke target and the ack channel.
  await spawnPanes(1, 0);
  await pause(1500);
  if (run('ipc')) {
    await measure('1 quiet pane', 6);
    await spawnPanes(12, 10);
    await pause(2000);
    await measure('+12 panes at 10 Hz', 8);
    await spawnPanes(12, 10);
    await pause(2000);
    await measure('+24 panes at 10 Hz', 8);
    // Stop the chatty panes before the latency tests.
    await page.evaluate(async () => { const { invoke } = window.__TAURI__.core; for (const id of window.perf.ids.splice(1)) await invoke('pty_kill', { id }).catch(() => {}); window.perf.channels.splice(1); });
    await pause(2000);
  }
  // Keystroke round trip: pty_write resolve time, and echo arrival time, while `git` slow Git calls
  // and `opencode` stalled OpenCode reads are in flight.
  const keyLatency = async (label, git, opencode = 0) => {
    const r = await page.evaluate(async ({ git, opencode, dir, ocDir }) => {
      const { invoke } = window.__TAURI__.core;
      const id = window.perf.ids[0];
      const blockers = Array.from({ length: git }, () => invoke('git_run', { dir, args: ['-c', 'alias.zz=!sleep 2', 'zz'] }).catch(e => String(e)));
      const reads = Array.from({ length: opencode }, (_, i) => {
        const t0 = performance.now();
        return invoke('last_messages', { panes: [[`perf-oc-${i}`, 'opencode', ocDir, 'ses_perf']] })
          .then(() => 'resolved', e => String(e)).then(result => ({ ms: Math.round(performance.now() - t0), result }));
      });
      await new Promise(r => setTimeout(r, 100));
      const writes = [], echoes = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const echoed = new Promise(r => (window.perf.echo = r));
        await invoke('pty_write', { id, data: 'k' });
        writes.push(Math.round(performance.now() - t0));
        await Promise.race([echoed, new Promise(r => setTimeout(r, 5000))]);
        echoes.push(Math.round(performance.now() - t0));
        await new Promise(r => setTimeout(r, 50));
      }
      const gitResults = await Promise.all(blockers);
      const r = { writeMs: writes, echoMs: echoes, gitErrors: gitResults.filter(x => typeof x === 'string' && x.startsWith('git')).length };
      if (opencode) {
        const done = await Promise.all(reads);
        r.opencodeReadMs = done.map(d => d.ms);
        r.opencodeResults = [...new Set(done.map(d => d.result))];
      }
      return r;
    }, { git, opencode, dir, ocDir });
    console.log('keystroke', label.padEnd(44), JSON.stringify(r));
    report['keystroke ' + label] = r;
    await pause(2500);
  };
  if (run('keys')) {
    await keyLatency('idle', 0);
    await keyLatency('during 8 slow git calls', 8);
    await keyLatency('during 18 slow git calls', 18);
  }
  if (run('opencode')) {
    // Tauri runs `async` commands on a Tokio pool of one worker per logical CPU.
    const burst = availableParallelism() - 5;
    await keyLatency(`during ${burst} slow git calls`, burst);
    await keyLatency('during 5 stalled OpenCode reads', 0, 5);
    await keyLatency(`during 5 stalled OpenCode reads + ${burst} slow git calls`, burst, 5);
  }
  if (run('ack')) {
    // Acks without output at the plan's 310 a second, spread over 10 ms ticks. (24 panes at 10 Hz send
    // about 240: the review's 311 msg/s divided by the CPU window, not the counting window.)
    await page.evaluate(() => {
      const { invoke } = window.__TAURI__.core;
      const channel = window.perf.channels[0];
      const start = performance.now();
      let sent = 0;
      window.perf.acks = setInterval(() => {
        const due = Math.floor((performance.now() - start) * 0.31);
        for (; sent < due; sent++) void invoke('pty_ack', { channel });
      }, 10);
      window.perf.ackCount = () => ({ sent, t: performance.now() });
    });
    await pause(1000);
    const a = await page.evaluate(() => window.perf.ackCount());
    const cpu = sampleCpu(8);
    const b = await page.evaluate(() => window.perf.ackCount());
    await page.evaluate(() => clearInterval(window.perf.acks));
    const r = { acksPerSec: +((b.sent - a.sent) / ((b.t - a.t) / 1000)).toFixed(1), cpu };
    console.log('pty_ack only'.padEnd(34), JSON.stringify(r));
    report['pty_ack only, 310/s'] = r;
    await pause(1000);
  }
  if (run('shutdown')) {
    await spawnPanes(23, 0);
    await pause(3000);
    const r = await page.evaluate(async () => {
      const panes = window.perf.ids.length;
      const t0 = performance.now();
      await window.__TAURI__.core.invoke('pty_shutdown');
      return { panes, ms: Math.round(performance.now() - t0) };
    });
    console.log('pty_shutdown'.padEnd(34), JSON.stringify(r));
    report['pty_shutdown, quiet panes'] = r;
  }
  if (run('agents')) {
    // claude where Claude Code already trusts the folder, so startup isn't parked on the trust
    // prompt and its children come up. An idle stdio MCP server gives it a node child, the way
    // npx-launched servers do. opencode2 the way agent.ts launches it, through cmd.exe.
    const mcp = join(dir, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { 'perf-probe': { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } } }));
    await page.evaluate(async ({ repo, dir, mcp }) => {
      const { invoke, Channel } = window.__TAURI__.core;
      for (const [id, cwd, argv] of [['perf-claude', repo, ['claude', '--mcp-config', mcp]], ['perf-opencode2', dir, ['cmd.exe', '/d', '/s', '/c', 'opencode2']]]) {
        const out = new Channel();
        out.onmessage = d => { void invoke('pty_ack', { channel: out.id }); if (d.includes('\x1b[6n')) void invoke('pty_write', { id, data: '\x1b[1;1R' }).catch(() => {}); };
        await invoke('pty_spawn', { id, cwd, argv, cols: 120, rows: 30, onOut: out });
      }
    }, { repo: process.env.CLAUDE_DIR || process.cwd(), dir, mcp });
    await pause(15000);
    const before = paneTree();
    const ms = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.__TAURI__.core.invoke('pty_shutdown');
      return Math.round(performance.now() - t0);
    });
    await pause(1000);
    const count = procs => procs.reduce((n, p) => ({ ...n, [p.name]: (n[p.name] || 0) + 1 }), {});
    const r = { ms, before: count(before), left: count(alive(before)) };
    console.log('pty_shutdown, real agents'.padEnd(34), JSON.stringify(r));
    report['pty_shutdown, real claude and opencode2'] = r;
  }
  if (run('restore')) {
    // This workspace's markers name a transcript under its folder's Claude project (usage.rs slug).
    const marks = join(tmpdir(), 'loom-tx');
    const project = join('projects', claudeDir.replace(/[^a-zA-Z0-9]/g, '-'), '');
    let landed = [];
    for (let i = 0; i < 1800 && landed.length < 8; i++) {
      await pause(100);
      landed = (existsSync(marks) ? readdirSync(marks) : []).map(name => ({ name, at: statSync(join(marks, name)).birthtimeMs }))
        .filter(m => m.at >= launched - 1000 && readFileSync(join(marks, m.name), 'utf8').includes(project));
    }
    const r = { panes: landed.length, markersMs: landed.map(m => Math.round(m.at - launched)).sort((a, b) => a - b) };
    for (const m of landed) rmSync(join(marks, m.name), { force: true });
    console.log('restore 8 claude panes'.padEnd(34), JSON.stringify(r));
    report['restore 8 claude panes'] = r;
  }
  if (run('app')) {
    for (let i = 0; i < 600 && !appLogs.every(f => existsSync(f)); i++) await pause(100);
    if (!appLogs.every(f => existsSync(f))) throw new Error('app panes did not start');
    await pause(3000);
    // Invokes are fetches to ipc.localhost. The page round trip in calls() first delivers the
    // request events queued while spawnSync blocked.
    const counts = {};
    page.on('request', req => { const u = new URL(req.url()); if (u.hostname === 'ipc.localhost') counts[u.pathname.slice(1)] = (counts[u.pathname.slice(1)] || 0) + 1; });
    const calls = async () => { const t = await page.evaluate(() => performance.now()); return { calls: { ...counts }, t }; };
    const a = await calls();
    const cpu = sampleCpu(8);
    const b = await calls();
    const perSec = Object.fromEntries(Object.entries(b.calls).map(([k, v]) => [k, +((v - (a.calls[k] || 0)) / ((b.t - a.t) / 1000)).toFixed(1)]));
    const r = { invokesPerSec: perSec, cpu };
    console.log('24 app panes at 10 Hz'.padEnd(34), JSON.stringify(r));
    report['24 app panes at 10 Hz'] = r;
    // Minimized for 60 s. A child that waited more than its 100 ms interval was blocked writing.
    // The app may not minimize itself (capabilities), so this goes through Win32.
    const show = how => spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'
      $h = (Get-Process -Id ${child.pid}).MainWindowHandle; [void][U.W]::ShowWindowAsync($h, ${how}); Start-Sleep -Milliseconds 500; [U.W]::IsIconic($h)`], { encoding: 'utf8' }).stdout.trim() === 'True';
    const t0 = Date.now();
    const minimized = show(6); // SW_MINIMIZE
    await pause(5000);
    const visibility = await page.evaluate(() => document.visibilityState);
    await pause(55000);
    const t1 = Date.now();
    show(9); // SW_RESTORE
    const lines = appLogs.map(f => readFileSync(f, 'utf8').trim().split('\n').map(l => l.split(' ').map(Number)).filter(([t]) => t > t0 + 1000 && t <= t1));
    const m = {
      minimized, visibility,
      longestStallMs: Math.max(...lines.flatMap(l => l.map(([, , worst]) => worst - 100))),
      fewestRedraws: Math.min(...lines.map(l => l.at(-1)[1] - l[0][1])),
      seconds: Math.round((t1 - t0 - 1000) / 1000),
    };
    console.log('minimized 60 s'.padEnd(34), JSON.stringify(m));
    report['24 app panes, minimized 60 s'] = m;
  }
} finally {
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  for (const s of shared) {
    if (s.had) copyFileSync(s.backup, s.file);
    else rmSync(s.file, { force: true });
  }
  console.log('restored shared files:', shared.every(s => !s.had || readFileSync(s.file, 'utf8') === readFileSync(s.backup, 'utf8')));
  writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log('Wrote', join(out, 'results.json'));
  // Killed panes' shells can hold it as their working folder for a few seconds.
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
      if (i === 10) { console.log('Could not remove', dir, e.code); break; }
      await pause(1000);
    }
  }
}
