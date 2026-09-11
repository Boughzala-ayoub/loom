// Run against `npm run preview`; PLAYWRIGHT_MODULE can point to an existing install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const cmd of ['claude', 'codex', 'opencode', 'powershell']) {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 } });
    await context.addInitScript({ content: mocks + `\n(${((cmd) => {
      window.qa = { writes: [], spawn: null, size: null };
      mockWindows('main');
      mockIPC((call, args = {}) => {
        if (call === 'load_state') return JSON.stringify({ threads: [{ repo: 'C:\\test', dir: 'C:\\test', name: 'Copy check', panes: [{ cmd }] }] });
        if (call === 'pty_spawn') window.qa.spawn = args;
        if (call === 'pty_spawn' || call === 'pty_resize') window.qa.size = args;
        if (call === 'pty_write') window.qa.writes.push(args.data);
        if (call === 'git_run') return '';
        if (['take_wakes', 'take_sessions', 'model_options'].includes(call)) return [];
        if (call === 'session_usage') return {};
      }, { shouldMockEvents: true });
    }).toString()})(${JSON.stringify(cmd)});` });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.qa.spawn && window.qa.size.cols > 0).catch(async e => {
      console.error(await page.evaluate(() => ({ qa: window.qa, text: document.body.innerText.slice(-1000) })), errors);
      throw e;
    });
    await page.waitForTimeout(200);
    const sample = 'copy this text';
    for (const tracking of [false, true]) {
      // Tracking = any-motion + SGR, as opentui asks for: every mouse move is pty input then.
      await page.evaluate(({ tracking, sample }) => window.qa.spawn.onOut.onmessage('\x1b[2J\x1b[H' + sample + (tracking ? '\x1b[?1003h\x1b[?1006h' : '\x1b[?1003l')), { tracking, sample });
      await page.waitForTimeout(100);
      const bounds = await page.locator('.xterm-screen').boundingBox();
      const size = await page.evaluate(() => window.qa.size);
      const x = bounds.x + 1, y = bounds.y + bounds.height / size.rows / 2;
      async function select() {
        if (tracking) await page.keyboard.down('Shift');
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + bounds.width / size.cols * sample.length, y, { steps: 10 });
        await page.mouse.up();
        if (tracking) await page.keyboard.up('Shift');
        await page.mouse.move(x + 30, y + 2); // the hand always moves before the copy gesture
        await page.evaluate(async () => { window.qa.writes = []; await navigator.clipboard.writeText('sentinel'); });
      }
      for (const gesture of ['Control+c', 'Control+Shift+c', 'right-click']) {
        await select();
        if (gesture === 'right-click') await page.mouse.click(x + 20, y, { button: 'right' });
        else await page.keyboard.press(gesture);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sample, `${cmd}: ${gesture}, tracking=${tracking}`);
        assert.deepEqual(await page.evaluate(() => window.qa.writes), [], 'Copy must not send input or mouse clicks to the agent');
      }
      await select();
      await page.evaluate(() => {
        window.qa.writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
      });
      await page.mouse.click(x + 20, y, { button: 'right' });
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Could not copy'));
      await page.evaluate(() => { navigator.clipboard.writeText = window.qa.writeText; });
      await page.keyboard.press('Control+c');
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sample, 'A failed copy must preserve the selection for retry');
      // Clear any selection, then ordinary Ctrl+C must still interrupt.
      await page.keyboard.press('ArrowRight');
      await page.evaluate(() => { window.qa.writes = []; });
      await page.keyboard.press('Control+c');
      assert.deepEqual(await page.evaluate(() => window.qa.writes), ['\x03']);
      await page.evaluate(async () => { window.qa.writes = []; await navigator.clipboard.writeText('paste check'); });
      await page.mouse.click(x + 20, y, { button: 'right' });
      await page.waitForTimeout(100);
      const writes = await page.evaluate(() => window.qa.writes);
      assert.equal(writes.filter(data => data === 'paste check').length, 1, 'Right-click pastes exactly once in every pane');
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${cmd}: keyboard/right-click copy, mouse tracking, clipboard failure/retry, Ctrl+C interrupt and paste`);
    await context.close();
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const context of browser.contexts()) await context.close();
  await browser.close();
}
