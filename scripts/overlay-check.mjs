// Build first: npm run build, then cargo build --features tauri/custom-protocol
// The agent overlay in the real app, on an empty temporary profile: it shows
// without taking focus, a drag moves it and the spot survives a restart, a
// click brings Loom back previewing the agent, and off closes it cleanly.
// Needs a desktop session: it minimizes its own Loom window and moves the real
// mouse for about a second.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
const pause = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'loom-overlay-check-'));
const work = join(dir, 'work');
mkdirSync(work);
execFileSync('git', ['init', '-q', work]); // Restoring a thread asks git about it.
const profile = join(dir, 'p.json');
const windowFile = join(dir, 'p.window.json');
writeFileSync(profile, JSON.stringify({ overlay: true, repos: [work], threads: [{ repo: work, dir: work, name: 'overlay-test', branch: '', panes: [{ cmd: '' }] }], ui: { sideOpen: false, thread: 0 } }));
writeFileSync(windowFile, JSON.stringify({ main: { width: 820, height: 640, x: 80, y: 80, prev_x: 80, prev_y: 80, maximized: false, fullscreen: false, visible: true, decorated: true } }));

// Win32 for what CDP can't see or do: window state, the foreground window, a real drag and click.
const ps = join(dir, 'win.ps1');
writeFileSync(ps, String.raw`param([string]$op, [int]$procId = 0, [int]$x1 = 0, [int]$y1 = 0, [int]$x2 = 0, [int]$y2 = 0)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
}
"@
[W]::SetProcessDPIAware() | Out-Null
function Windows($p) {
  $list = New-Object System.Collections.ArrayList
  [W]::EnumWindows({ param($h, $l) $o = 0; [W]::GetWindowThreadProcessId($h, [ref]$o) | Out-Null
    if ($o -eq $p -and [W]::Title($h)) { $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
      $c = New-Object W+POINT; [W]::ClientToScreen($h, [ref]$c) | Out-Null
      [void]$list.Add([pscustomobject]@{ hwnd = [int64]$h; title = [W]::Title($h); visible = [W]::IsWindowVisible($h); iconic = [W]::IsIconic($h); x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T; cx = $c.X; cy = $c.Y }) }
    $true }, [IntPtr]::Zero) | Out-Null
  return $list
}
switch ($op) {
  'info' { @{ windows = @(Windows $procId); foreground = [W]::Title([W]::GetForegroundWindow()) } | ConvertTo-Json -Depth 3 -Compress }
  'minimize' { $m = Windows $procId | Where-Object title -eq 'Loom'; [W]::ShowWindow([IntPtr]$m.hwnd, 6) | Out-Null }
  'drag' {
    [W]::SetCursorPos($x1, $y1) | Out-Null; Start-Sleep -Milliseconds 80
    [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 300 # the page asks for the window drag over IPC
    for ($i = 1; $i -le 10; $i++) { [W]::SetCursorPos($x1 + ($x2 - $x1) * $i / 10, $y1 + ($y2 - $y1) * $i / 10) | Out-Null; Start-Sleep -Milliseconds 30 }
    [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  'click' { [W]::SetCursorPos($x1, $y1) | Out-Null; Start-Sleep -Milliseconds 80; [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
}
`);
const win = (op, ...a) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, op, ...a.map(String)], { encoding: 'utf8' });
const info = pid => JSON.parse(win('info', pid).replace(/[\x00-\x1f]/g, '')); // Other apps' titles carry control characters.
const overlayWin = pid => info(pid).windows.find(w => w.title === 'Loom agents');
async function until(what, fn, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(150)) { const v = await fn(); if (v) return v; }
  throw new Error('Timed out: ' + what);
}

async function launch() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  const child = spawn(exe, [profile], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
  const exit = new Promise(r => child.once('exit', r));
  const endpoint = `http://127.0.0.1:${port}`;
  await until('webview', () => fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false), 30000);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const main = await until('main page', () => context.pages().find(p => !p.url().includes('overlay')), 15000);
  return { child, exit, browser, context, main };
}
// Wait until the restore finished, so the close handler is registered.
const close = async ({ main, exit }) => {
  await main.waitForFunction(() => document.querySelector('.pane'), null, { timeout: 20000 });
  await pause(1000);
  await main.evaluate(() => window.__TAURI__.event.emitTo('main', 'tauri://close-requested')).catch(() => {}); // The page goes away mid-call.
  return Promise.race([exit, pause(15000).then(() => 'timeout')]);
};

let app = await launch();
try {
  const { child, context, main } = app;
  const pid = child.pid;
  await until('overlay built', () => overlayWin(pid));
  assert.equal(overlayWin(pid).visible, false, 'Built hidden at startup, with nothing working or waiting');
  // A shell pane that rings OSC 9 reads as waiting.
  await main.waitForSelector('.pane .xterm', { state: 'visible', timeout: 20000 });
  await main.click('.pane .xterm');
  await main.keyboard.type('Write-Host "$([char]27)]9;ready$([char]7)"');
  await main.keyboard.press('Enter');
  await main.waitForFunction(() => document.querySelector('#waiting')?.textContent === '1 waiting', null, { timeout: 15000 });
  win('minimize', pid);
  const shown = await until('overlay shown', () => overlayWin(pid)?.visible && overlayWin(pid));
  assert.notEqual(info(pid).foreground, 'Loom agents', 'Showing the overlay must not take focus');
  const overlay = await until('overlay page', () => context.pages().find(p => p.url().includes('overlay')));
  await overlay.waitForFunction(() => document.querySelector('.row.waiting')?.textContent.includes('overlay-test'));
  const scale = await overlay.evaluate(() => devicePixelRatio);
  // A point on the page, in screen pixels.
  const onScreen = (o, x, y) => [o.cx + Math.round(x * scale), o.cy + Math.round(y * scale)];
  // Drag it by its header.
  const from = onScreen(shown, 60, 16);
  win('drag', pid, from[0], from[1], from[0] + 250, from[1] + 150);
  const moved = await until('overlay moved', () => { const o = overlayWin(pid); return Math.abs(o.x - (shown.x + 250)) <= 4 && Math.abs(o.y - (shown.y + 150)) <= 4 && o; });
  assert.equal(moved.visible, true, 'Dragging must not hide it');
  assert.equal(await main.locator('#waiting').textContent(), '1 waiting', 'Dragging must not acknowledge the agent');
  await until('position saved', () => { try { const s = JSON.parse(readFileSync(windowFile, 'utf8')).overlay; return s?.x === moved.x && s?.y === moved.y; } catch { return false; } });
  // Its height fits the list. Dragging the corner keeps the new width; the height
  // goes back to the list's and becomes the most it grows to.
  const fitted = await overlay.evaluate(() => Math.max(110, Math.ceil(document.querySelector('header').getBoundingClientRect().height + document.querySelector('#rail').getBoundingClientRect().height + 2)));
  assert.ok(Math.abs(await overlay.evaluate(() => innerHeight) - fitted) <= 2, 'The window fits its list');
  win('drag', pid, moved.x + moved.w - 3, moved.y + moved.h - 3, moved.x + moved.w + 77, moved.y + moved.h + 57);
  const sized = await until('overlay resized', () => { const o = overlayWin(pid); return Math.abs(o.w - (moved.w + 80)) <= 6 && Math.abs(o.h - moved.h) <= 6 && o; });
  assert.equal(await overlay.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Resized, the list still fits');
  await until('size and cap saved', () => { try { return JSON.parse(readFileSync(windowFile, 'utf8')).overlay?.width > 300 && JSON.parse(readFileSync(profile, 'utf8')).overlayCap > fitted + 30; } catch { return false; } });
  // Clicking the agent brings Loom back on the overview, previewing it.
  const row = await overlay.locator('.row.waiting').boundingBox();
  win('click', pid, ...onScreen(sized, row.x + 60, row.y + row.height / 2));
  await main.waitForSelector('#dashboard-preview[open]', { timeout: 6000 });
  assert.equal(await main.locator('#dashboard-preview-title').textContent(), 'overlay-test / shell');
  const back = await until('Loom restored', () => { const i = info(pid); return !i.windows.find(w => w.title === 'Loom').iconic && i; });
  assert.equal(back.foreground, 'Loom', 'Loom takes the foreground');
  await until('overlay hidden', () => overlayWin(pid)?.visible === false);
  // Always keeps it up over Loom itself; off closes the window and leaves the terminal running.
  await main.click('#dashboard-preview-close');
  await main.click('#preferences-btn');
  await main.click('#overlay-pref');
  assert.equal(await main.locator('#overlay-pref').textContent(), 'always');
  const always = await until('overlay shown over Loom', () => overlayWin(pid)?.visible && info(pid));
  assert.equal(always.foreground, 'Loom', 'Showing it over Loom must not take focus from Loom');
  await main.click('#overlay-pref');
  await until('overlay closed', () => !overlayWin(pid));
  await main.keyboard.press('Escape');
  assert.equal(await main.locator('.dashboard-card').filter({ hasText: 'overlay-test' }).locator('.dashboard-status').textContent().then(t => t.startsWith('Exited')), false, 'Closing the overlay must not end the terminals');
  assert.equal(await close(app), 0, 'Loom exits');
  assert.equal(JSON.parse(readFileSync(profile, 'utf8')).overlay, 'off');
  // Next launch puts the overlay where it was dragged, at the size it was given, and still
  // exits with it open. true is how the setting was saved before "always" existed.
  writeFileSync(profile, JSON.stringify({ ...JSON.parse(readFileSync(profile, 'utf8')), overlay: true }));
  await app.browser.close().catch(() => {});
  app = await launch();
  await until('overlay restored where it was dragged', () => { const o = overlayWin(app.child.pid); return o?.x === moved.x && o?.y === moved.y && o.w === sized.w && o.h === sized.h; }, 8000);
  assert.equal(await close(app), 0, 'Loom exits with the overlay open');
  console.log('PASS native overlay');
} finally {
  await app.browser.close().catch(() => {});
  if (app.child.exitCode === null) app.child.kill();
}
