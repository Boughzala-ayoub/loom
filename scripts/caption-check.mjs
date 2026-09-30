// Real-app check of the frameless window's caption (caption.rs, index.html #caption). Launches the
// release build on a temporary empty profile and checks, without moving the mouse, that:
// - no native title bar is left above Loom's own bar,
// - the snap layouts window sits exactly over the page's maximize button, is the window Windows
//   finds there among Loom's own windows (above WebView2), and answers HTMAXBUTTON, which is what opens the flyout,
// - a click through it maximizes and restores, the button's glyph follows, and the window follows
//   the button to its new place,
// - hover reaches the page, whose button no longer sees the mouse itself.
// Needs src-tauri/target/release/loom.exe built with --features tauri/custom-protocol (or LOOM_TEST_EXE).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const out = resolve('node_modules/.cache/caption-check');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'loom-caption-check-'));
const profile = join(dir, 'workspace.json');
writeFileSync(profile, '{}');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [profile], {
  stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));

// One PowerShell call per question, answered as JSON.
const API = `
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }`;
const win32 = script => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -Name W -Namespace L -MemberDefinition @'\n${API}\n'@\n$main = (Get-Process -Id ${child.pid}).MainWindowHandle\n$snap = [L.W]::FindWindowEx($main, [IntPtr]::Zero, 'LoomSnapLayouts', $null)\n${script}`], { encoding: 'utf8' });
  if (r.status) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim());
};
const layout = () => win32(`
$r = New-Object L.W+RECT; [void][L.W]::GetWindowRect($snap, [ref]$r)
$w = New-Object L.W+RECT; [void][L.W]::GetWindowRect($main, [ref]$w)
$o = New-Object L.W+POINT; [void][L.W]::ClientToScreen($main, [ref]$o)
$c = New-Object L.W+POINT; $c.X = [int](($r.Left + $r.Right) / 2); $c.Y = [int](($r.Top + $r.Bottom) / 2)
$lp = [IntPtr](($c.Y -shl 16) -bor ($c.X -band 0xffff))
@{ snap = [int64]$snap; visible = [L.W]::IsWindowVisible($snap); zoomed = [L.W]::IsZoomed($main)
   rect = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)); window = @($w.Left, $w.Top); client = @($o.X, $o.Y)
   under = $(if ([L.W]::ScreenToClient($main, [ref]$c)) { [int64][L.W]::ChildWindowFromPointEx($main, $c, 1) }); hit = [int64][L.W]::SendMessage($snap, 0x84, [IntPtr]::Zero, $lp) } | ConvertTo-Json -Compress`);
// The page's maximize button in device pixels, the way main.ts reports it.
const button = page => page.evaluate(() => {
  const r = document.querySelector('#cap-max').getBoundingClientRect();
  return { rect: [r.left, r.top, r.width, r.height].map(v => Math.round(v * devicePixelRatio)), glyph: document.querySelector('#cap-max').textContent, title: document.querySelector('#cap-max').title };
});
const aligned = (l, b) => l.rect.every((v, i) => Math.abs(v - (i < 2 ? b.rect[i] + l.client[i] : b.rect[i])) <= 1);

let browser;
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { ready = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false); if (!ready) await pause(100); }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const bundle = readFileSync('dist/index.html', 'utf8').match(/src="([^"]*\/main-[^"]+\.js)"/)[1];
  assert.equal(await page.locator('script[type="module"][src]').first().getAttribute('src'), bundle, 'The native app must embed the current frontend bundle');
  await page.evaluate(() => { window.capEvents = []; return window.__TAURI__.event.listen('caption-max', e => window.capEvents.push(e.payload)); });
  await pause(1500);

  let l = layout(), b = await button(page);
  console.log('normal', JSON.stringify({ ...l, button: b.rect }));
  assert.ok(l.client[1] - l.window[1] <= 1, `No native title bar above Loom's bar: client area starts ${l.client[1] - l.window[1]} px below the window top`);
  assert.ok(l.snap && l.visible, 'The snap layouts window exists and shows');
  assert.ok(aligned(l, b), `The snap layouts window covers the maximize button: ${JSON.stringify({ window: l.rect, client: l.client, button: b.rect })}`);
  assert.equal(l.under, l.snap, 'Windows finds the snap layouts window over the button, above WebView2');
  assert.equal(l.hit, 9, 'It answers HTMAXBUTTON, which opens the snap layouts flyout');

  win32(`[void][L.W]::PostMessage($snap, 0xA0, [IntPtr]9, [IntPtr]0); '1'`); // WM_NCMOUSEMOVE
  await page.waitForFunction(() => window.capEvents.includes('enter'));
  console.log('PASS the snap layouts window covers the maximize button, is on top there and answers HTMAXBUTTON; hover reaches the page');

  const click = () => win32(`[void][L.W]::PostMessage($snap, 0xA1, [IntPtr]9, [IntPtr]0); [void][L.W]::PostMessage($snap, 0xA2, [IntPtr]9, [IntPtr]0); '1'`);
  click();
  await page.waitForFunction(() => document.querySelector('#cap-max').textContent === '', null, { timeout: 5000 });
  await pause(800);
  l = layout(); b = await button(page);
  console.log('maximized', JSON.stringify({ ...l, button: b.rect }));
  assert.ok(l.zoomed, 'A click through the snap layouts window maximizes');
  assert.equal(b.title, 'Restore down');
  assert.ok(aligned(l, b) && l.under === l.snap, 'The snap layouts window follows the button when maximized');
  click();
  await page.waitForFunction(() => document.querySelector('#cap-max').textContent === '', null, { timeout: 5000 });
  await pause(800);
  l = layout(); b = await button(page);
  assert.ok(!l.zoomed, 'A second click restores');
  assert.ok(aligned(l, b) && l.under === l.snap, 'The snap layouts window follows the button back');
  console.log('PASS maximize and restore through the snap layouts window, with the glyph, label and window following');
  await page.screenshot({ path: join(out, 'bar.png'), clip: { x: 0, y: 0, width: await page.evaluate(() => innerWidth), height: 60 } });
} finally {
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  await pause(1000);
  rmSync(dir, { recursive: true, force: true });
}
