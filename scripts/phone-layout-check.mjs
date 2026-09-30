// Served-bundle checks for scaling, short monitors, secondary monitors and errors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [scale, x, height] of [[1, 0, 1040], [1.5, 0, 1040], [1.25, -1920, 1400]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript({ content: mocks + `\n(${((scale, x, height) => {
      mockWindows('main');
      const qa = window.qa = { size: { width: 1000, height: 700 }, position: { x: x + 60, y: 40 }, scale, x, height };
      mockIPC((call, args = {}) => {
        if (call === 'load_state') return JSON.stringify({ threads: [{ repo: 'C:\\test', dir: 'C:\\test', name: 'Phone test', panes: [{ cmd: 'powershell' }] }] });
        if (call === 'pty_spawn') {
          (qa.spawns ??= []).push(args.id);
          args.onOut.onmessage(Array.from({ length: 300 }, (_, i) => `History ${i}\r\n`).join(''));
        }
        if (call === 'git_run') return '';
        if (['take_sessions', 'model_options'].includes(call)) return [];
        if (call === 'session_usage') return {};
        if (call === 'plugin:window|current_monitor') return { name: 'Test monitor', scaleFactor: scale,
          size: { width: 1920, height }, position: { x, y: 0 }, workArea: { position: { x, y: 0 }, size: { width: 1920, height } } };
        if (call === 'plugin:window|is_maximized' || call === 'plugin:window|is_fullscreen') return false;
        if (call === 'plugin:window|inner_size') return { ...qa.size };
        if (call === 'plugin:window|outer_size') return { width: qa.size.width + 16 * scale, height: qa.size.height + 39 * scale };
        if (call === 'plugin:window|outer_position') return { ...qa.position };
        if (call === 'plugin:window|set_size') {
          if (qa.failSizeOnce) { qa.failSizeOnce = false; throw new Error('Test resize rejected'); }
          qa.size = JSON.parse(JSON.stringify(args.value)).Physical;
        }
        if (call === 'plugin:window|set_position') qa.position = JSON.parse(JSON.stringify(args.value)).Physical;
      }, { shouldMockEvents: true });
    }).toString()})(${scale}, ${x}, ${height});` });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForSelector('#phone-window');
    await page.waitForFunction(() => window.qa.spawns?.length === 1);
    const paneId = await page.locator('.pane').getAttribute('data-id');
    const original = await page.evaluate(() => ({ size: window.qa.size, position: window.qa.position }));
    await page.click('#phone-window');
    await page.waitForFunction(() => document.querySelector('#phone-window').getAttribute('aria-pressed') === 'true');
    const phone = await page.evaluate(() => ({ size: window.qa.size, position: window.qa.position }));
    const outer = { width: phone.size.width + 16 * scale, height: phone.size.height + 39 * scale };
    assert.ok(phone.size.width / scale >= 320);
    assert.ok(phone.position.x >= x && phone.position.x + outer.width <= x + 1920 + 1);
    assert.ok(phone.position.y >= 0 && phone.position.y + outer.height <= height + 1);
    await page.setViewportSize({ width: Math.floor(phone.size.width / scale), height: Math.floor(phone.size.height / scale) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.click('#phone-window');
    await page.waitForFunction(() => document.querySelector('#phone-window').getAttribute('aria-pressed') === 'false');
    assert.deepEqual(await page.evaluate(() => ({ size: window.qa.size, position: window.qa.position })), original);
    assert.deepEqual(await page.evaluate(() => window.qa.spawns), [paneId], 'Resizing must keep the original process');
    assert.equal(await page.locator('.pane').getAttribute('data-id'), paneId, 'Resizing must keep the original terminal');
    await page.evaluate(() => { window.qa.failSizeOnce = true; });
    await page.click('#phone-window');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Test resize rejected'));
    assert.equal(await page.locator('#phone-window').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await page.evaluate(() => ({ size: window.qa.size, position: window.qa.position })), original);
    console.log(`PASS scale ${scale}, monitor x=${x}, height=${height}: fit, restore and failure recovery`);
    await context.close();
  }
} finally { await browser.close(); }
