// Build and serve with npm run preview before running node scripts/scroll-check.mjs.
// Mocked PTY output exercises the served terminal and its input routing.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const out = 'node_modules/.cache/scroll-check';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  for (const width of (process.env.SCROLL_WIDTHS || '320,375,768,1024,1280').split(',').map(Number)) for (const cmd of (process.env.SCROLL_AGENTS || 'codex,claude,opencode,powershell').split(',')) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript({ content: mocks + `\n(${(cmd => {
      window.qa = { writes: [], spawn: null, size: null };
      mockWindows('main');
      mockIPC((call, args = {}) => {
        if (call === 'load_state') return JSON.stringify({ threads: [{ repo: 'C:\\test', dir: 'C:\\test', name: 'Scroll check', panes: [{ cmd }] }] });
        if (call === 'pty_spawn') window.qa.spawn = args;
        if (call === 'pty_spawn' || call === 'pty_resize') window.qa.size = args;
        if (call === 'pty_write') window.qa.writes.push(args.data);
        if (call === 'git_run') return '';
        if (['take_sessions', 'model_options'].includes(call)) return [];
        if (call === 'session_usage') return {};
      }, { shouldMockEvents: true });
    }).toString()})(${JSON.stringify(cmd)});` });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.qa.spawn && window.qa.size.cols > 0);
    if (cmd === 'codex') assert.ok(await page.evaluate(() => window.qa.spawn.argv.join(' ').includes('tui.alternate_screen=never')), 'Codex must launch with terminal scrollback');
    await page.waitForTimeout(250);
    await page.evaluate(() => window.qa.spawn.onOut.onmessage(Array.from({ length: 300 }, (_, i) => `History line ${i}\r\n`).join('')));
    await page.waitForTimeout(150);
    const slider = page.locator('.xterm .scrollbar.vertical .slider');
    const top = () => slider.evaluate(el => parseFloat(el.style.top));
    const bottom = await top();
    let screen = await page.locator('.xterm-screen').boundingBox();
    await page.mouse.move(screen.x + 80, screen.y + 80);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(100);
    assert.ok(await top() < bottom, `${cmd}: wheel must reach history`);
    const thumb = await slider.boundingBox();
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(thumb.x + thumb.width / 2, screen.y + 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.ok(await top() < 3, `${cmd}: dragging must reach oldest history`);
    assert.deepEqual(await page.evaluate(() => window.qa.writes), [], 'Dragging normal history must not type into the process');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${cmd}@${width}: horizontal overflow`);
    await page.screenshot({ path: `${out}/${cmd}-history-${width}.png` });
    await page.mouse.move(screen.x + 80, screen.y + 80);
    await page.mouse.wheel(0, 100000);
    await page.waitForTimeout(100);
    await page.locator('.xterm-helper-textarea').focus();
    const checkPageKeys = async () => {
      // Start at the bottom so Page Up cannot clamp near the oldest line.
      for (let i = 0; i < 20; i++) await page.keyboard.press('PageDown');
      await page.waitForTimeout(100);
      const before = await top();
      await page.evaluate(() => { window.qa.writes = []; });
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(100);
      assert.ok(await top() < before, `${cmd}@${width}: Page Up must scroll Codex history; PTY received ${JSON.stringify(await page.evaluate(() => window.qa.writes))}`);
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(100);
      assert.ok(Math.abs(await top() - before) < 1, `${cmd}@${width}: Page Down must return to the original position (${before} -> ${await top()}); PTY received ${JSON.stringify(await page.evaluate(() => window.qa.writes))}`);
      assert.deepEqual(await page.evaluate(() => window.qa.writes), [], 'Codex history keys must not be sent as agent input');
    };
    if (cmd === 'codex') {
      await checkPageKeys();
    }
    await page.waitForTimeout(100);
    const beforeKeyboard = await top();
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await page.waitForTimeout(100);
    assert.ok(await top() < beforeKeyboard, `${cmd}: keyboard scroll must reach history (${beforeKeyboard} -> ${await top()})`);
    if (cmd === 'codex') {
      await page.keyboard.press('Control+PageUp');
      assert.ok(await page.evaluate(() => window.qa.writes.includes('\x1b[5;5~')), 'Modified Page Up remains available to Codex');
    }
    const historyThumb = await slider.boundingBox();
    await page.mouse.move(historyThumb.x + historyThumb.width / 2, historyThumb.y + historyThumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(historyThumb.x + historyThumb.width / 2, screen.y + screen.height - 1, { steps: 5 });
    await page.mouse.up();
    for (let i = 0; i < 2; i++) {
      await page.locator('#dashboard-btn').click();
      await page.locator('.dashboard-row').first().click();
      await page.waitForTimeout(150);
      if (cmd === 'codex') {
        await page.locator('#dashboard-preview-output .xterm-helper-textarea').focus();
        await checkPageKeys();
      }
      if (i) {
        const preview = await page.locator('#dashboard-preview-output .xterm-screen').boundingBox();
        await page.mouse.move(preview.x + 40, preview.y + 40);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(100);
      }
      await page.locator('#dashboard-preview-close').click();
      await page.locator('#dashboard-btn').click();
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.qa.spawn.onOut.onmessage('New output\r\n'.repeat(5500)));
    await page.waitForTimeout(200);
    assert.ok(await slider.evaluate(el => parseFloat(el.style.top) > el.parentElement.clientHeight / 2), `${cmd}@${width}: Overview must preserve follow-output`);
    screen = await page.locator('.xterm-screen').boundingBox();
    await page.evaluate(() => {
      window.qa.spawn.onOut.onmessage('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HFull-screen transcript');
      window.qa.writes = [];
    });
    await page.waitForTimeout(100);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageDown');
    assert.ok(await page.evaluate(() => window.qa.writes.includes('\x1b[5~') && window.qa.writes.includes('\x1b[6~')), `${cmd}: full-screen applications must receive both page keys`);
    await page.mouse.move(screen.x + 80, screen.y + 80);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => window.qa.writes.some(s => /^\x1b\[<64;/.test(s))), `${cmd}: full-screen wheel must reach the agent`);
    await page.evaluate(() => { window.qa.writes = []; });
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => window.qa.writes.some(s => /^\x1b\[<64;/.test(s))), `${cmd}: full-screen keyboard scroll must reach the agent`);
    await page.evaluate(() => { window.qa.writes = []; });
    await page.mouse.move(screen.x + screen.width - 4, screen.y + 50);
    await page.mouse.down();
    await page.mouse.move(screen.x + screen.width - 4, screen.y + 150, { steps: 5 });
    await page.mouse.up();
    const reports = await page.evaluate(() => window.qa.writes);
    for (const pattern of [/^\x1b\[<0;.*M$/, /^\x1b\[<32;.*M$/, /^\x1b\[<0;.*m$/]) {
      assert.ok(reports.some(s => pattern.test(s)), `${cmd}: agent-owned scrollbar must receive mouse down, drag, and release`);
    }
    console.log(`PASS ${cmd}@${width}: wheel, scrollbar drag, page keys, keyboard history, Overview follow-output, full-screen mouse reports`);
    await context.close();
  }
} finally { await browser.close(); }
