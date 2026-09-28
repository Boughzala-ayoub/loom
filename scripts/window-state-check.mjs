// Build first: cargo build --locked --features tauri/custom-protocol
// Runs only empty, temporary profiles. No agents or project files are touched.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'loom-window-check-'));
const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
for (const mode of ['normal', 'maximized', 'fullscreen']) {
  const profile = join(dir, mode + '.json');
  const windowFile = join(dir, mode + '.window.json');
  writeFileSync(profile, JSON.stringify({ ui: { sideOpen: false } }));
  writeFileSync(windowFile, JSON.stringify({ main: {
    width: 820, height: 640, x: 80, y: 80, prev_x: 80, prev_y: 80,
    maximized: mode === 'maximized', fullscreen: mode === 'fullscreen', visible: true, decorated: true,
  } }));
  for (let run = 0; run < 2; run++) {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const child = spawn(exe, [profile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
      ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    } });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    let exited = false;
    const exit = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
    let browser;
    try {
      const endpoint = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let n = 0; n < 200 && !exited; n++) {
        ready = await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false);
        if (ready) break;
        await pause(100);
      }
      assert.ok(ready, 'Native webview did not start: ' + stderr);
      browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? await context.waitForEvent('page');
      await page.waitForFunction(() => window.__TAURI__?.window && document.querySelector('#side-toggle'));
      await page.waitForFunction(() => document.querySelector('#side').classList.contains('hidden'));
      const actual = await page.evaluate(async () => {
        const w = window.__TAURI__.window.getCurrentWindow();
        return { fullscreen: await w.isFullscreen(), maximized: await w.isMaximized(),
          size: await w.innerSize(), position: await w.outerPosition() };
      });
      assert.equal(actual.fullscreen, mode === 'fullscreen');
      if (mode !== 'fullscreen') assert.equal(actual.maximized, mode === 'maximized');
      if (mode === 'normal') {
        assert.equal(actual.size.width, 820);
        assert.equal(actual.size.height, 640);
        assert.equal(actual.position.x, 80);
        assert.equal(actual.position.y, 80);
      }
      if (mode === 'normal' && run === 0) {
        // Moved while running: saved once the window has been still for 500 ms, not only on close.
        const move = (x, y) => spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'; [void][U.W]::SetWindowPos((Get-Process -Id ${child.pid}).MainWindowHandle, [System.IntPtr]::Zero, ${x}, ${y}, 0, 0, 0x15)`], { windowsHide: true });
        move(200, 120);
        await pause(1500);
        const moved = await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().outerPosition());
        assert.notEqual(moved.x, 80, 'The test must have moved the window');
        assert.deepEqual([read(windowFile).main.x, read(windowFile).main.y], [moved.x, moved.y], 'A move must be saved while Loom keeps running');
        move(80, 80); // the reopen run expects the original position
        await pause(1000);
      }
      // Exercise real save_state repeatedly, including replacement of an existing file.
      await page.click('#side-toggle');
      await page.click('#side-toggle');
      await page.evaluate(() => window.__TAURI__.event.emitTo('main', 'tauri://close-requested'));
      assert.equal(await Promise.race([exit, pause(15000).then(() => 'timeout')]), 0, 'Close must flush state and exit');
      assert.equal(read(profile).ui.sideOpen, false);
      assert.equal(read(windowFile).main.fullscreen, mode === 'fullscreen');
      console.log(`PASS native ${mode}, ${run ? 'reopen' : 'initial restore'}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (!exited) { child.kill(); await exit; }
    }
  }
}
console.log('Native window-state fixtures: ' + dir);
