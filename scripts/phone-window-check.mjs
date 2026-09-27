// Exercise the real packaged window APIs and permissions using a temporary profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const dir = mkdtempSync(join(tmpdir(), 'loom-phone-check-'));
const profile = join(dir, 'workspace.json');
writeFileSync(profile, '{}');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(resolve('src-tauri/target/release/loom.exe'), [profile], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
let exited = false;
const exit = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
let browser;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 200; n++) {
    if (await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false)) break;
    await pause(100);
  }
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#phone-window');
  const bundle = readFileSync('dist/index.html', 'utf8').match(/src="([^"]*\/main-[^"]+\.js)"/)[1];
  assert.equal(await page.locator('script[type="module"][src]').first().getAttribute('src'), bundle);
  const geometry = () => page.evaluate(async () => {
    const api = window.__TAURI__.window, win = api.getCurrentWindow();
    return { inner: await win.innerSize(), outer: await win.outerSize(), position: await win.outerPosition(),
      maximized: await win.isMaximized(), fullscreen: await win.isFullscreen(), monitor: await api.currentMonitor() };
  });
  const toggle = async active => {
    await page.locator('#phone-window').click();
    await page.waitForFunction(active => document.querySelector('#phone-window').getAttribute('aria-pressed') === String(active)
      && !document.querySelector('#phone-window').disabled, active);
    await pause(200);
  };
  mkdirSync('node_modules/.cache/phone-window-check', { recursive: true });
  for (const mode of ['normal', 'maximized', 'fullscreen']) {
    await page.evaluate(async mode => {
      const api = window.__TAURI__.window, win = api.getCurrentWindow();
      await win.setFullscreen(false);
      await win.unmaximize();
      await win.setSize(new api.LogicalSize(900, 650));
      if (mode === 'maximized') await win.maximize();
      if (mode === 'fullscreen') await win.setFullscreen(true);
    }, mode);
    await pause(200);
    const before = await geometry();
    await toggle(true);
    const phone = await geometry(), work = phone.monitor.workArea;
    assert.equal(phone.maximized, false);
    assert.equal(phone.fullscreen, false);
    assert.ok(phone.outer.width < phone.outer.height, 'Phone window must be portrait');
    assert.ok(phone.position.x >= work.position.x - 2 && phone.position.y >= work.position.y - 2);
    assert.ok(phone.position.x + phone.outer.width <= work.position.x + work.size.width + 2);
    assert.ok(phone.position.y + phone.outer.height <= work.position.y + work.size.height + 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    assert.ok(await page.locator('#phone-window').isVisible(), 'Restore control stays available');
    assert.equal(await page.locator('#side').isVisible(), false, 'The desktop sidebar must not cover the phone view');
    await page.screenshot({ path: `node_modules/.cache/phone-window-check/${mode}.png` });
    await toggle(false);
    const after = await geometry();
    assert.equal(after.maximized, before.maximized);
    assert.equal(after.fullscreen, before.fullscreen);
    assert.ok(Math.abs(after.inner.width - before.inner.width) <= 2 && Math.abs(after.inner.height - before.inner.height) <= 2, 'Restore original window dimensions');
    assert.ok(Math.abs(after.position.x - before.position.x) <= 2 && Math.abs(after.position.y - before.position.y) <= 2, 'Restore original window position');
    assert.equal(await page.locator('#side').isVisible(), true, 'Restore the desktop sidebar');
    console.log(`PASS ${mode}: ${phone.outer.width}x${phone.outer.height} phone window and original bounds restored`);
  }
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().destroy()).catch(e => {
    if (!String(e).includes('closed')) throw e; // Destroy can close the renderer before the IPC reply.
  });
  assert.equal(await Promise.race([exit, pause(5000).then(() => 'timeout')]), 0);
} finally {
  if (!exited) spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  if (browser) await Promise.race([browser.close().catch(() => {}), pause(2000)]);
}
