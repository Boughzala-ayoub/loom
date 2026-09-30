// Build and serve the production bundle before running this check.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const out = 'node_modules/.cache/performance-check';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript({ content: mocks + `\n(${(() => {
    window.qa = { panes: [], calls: {}, inFlight: {}, maxInFlight: {}, activePtys: new Set(), pendingStarts: [] };
    window.qa.observed = new Set();
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      targets = new Set();
      observe(target, options) { this.targets.add(target); window.qa.observed.add(target); super.observe(target, options); }
      unobserve(target) { this.targets.delete(target); window.qa.observed.delete(target); super.unobserve(target); }
      disconnect() { for (const target of this.targets) window.qa.observed.delete(target); this.targets.clear(); super.disconnect(); }
    };
    mockWindows('main');
    mockIPC((call, args = {}) => {
      window.qa.calls[call] = (window.qa.calls[call] || 0) + 1;
      if (window.qa.slowPolls && (call === 'session_usage' || call === 'git_run' && ['diff', 'status'].includes(args.args?.[0]))) {
        const key = call === 'git_run' ? args.dir + ':' + args.args.join(' ') : call;
        const qa = window.qa;
        qa.inFlight[key] = (qa.inFlight[key] || 0) + 1;
        qa.maxInFlight[key] = Math.max(qa.maxInFlight[key] || 0, qa.inFlight[key]);
        return new Promise(resolve => setTimeout(() => { qa.inFlight[key]--; resolve(call === 'git_run' ? '' : call === 'session_usage' ? {} : []); }, 1000));
      }
      if (call === 'load_state') return JSON.stringify({ threads: Array.from({ length: 24 }, (_, i) => ({
        repo: 'C:\\test', dir: 'C:\\test', name: 'Session ' + i, panes: [{ cmd: ['codex', 'claude', 'opencode', 'powershell'][i % 4],
          ...(i % 4 === 2 ? { sid: 'opencode-state-' + i, sessionId: 'ses_test' } : {}) }],
      })) });
      if (call === 'pty_spawn') {
        window.qa.panes.push(args);
        if (window.qa.holdStarts) return new Promise(resolve => window.qa.pendingStarts.push(() => { window.qa.activePtys.add(args.id); resolve(); }));
        window.qa.activePtys.add(args.id);
      }
      if (call === 'pty_kill') window.qa.activePtys.delete(args.id);
      if (call === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
      if (call === 'plugin:path|join') return args.paths.join('\\');
      if (call === 'plugin:window|is_minimized') return window.qa.minimized === true;
      if (call === 'git_run') return '';
      if (call === 'pane_booted') return true;
      if (['take_sessions', 'model_options'].includes(call)) return [];
      if (call === 'session_usage') return {};
      if (call === 'last_messages') {
        (window.qa.messageProviders ??= []).push(args.panes.map(p => p[1]));
        return window.qa.stallOpenCode && args.panes.some(p => p[1] === 'opencode') ? new Promise(() => {}) : {};
      }
    }, { shouldMockEvents: true });
  }).toString()})();` });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.qa.panes.length === 24);
  await page.waitForTimeout(1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const sample = async (name, work) => {
    const before = await metrics();
    await work();
    const after = await metrics();
    const result = { name, seconds: after.Timestamp - before.Timestamp, taskSeconds: after.TaskDuration - before.TaskDuration,
      heapMB: after.JSHeapUsedSize / 1048576, nodes: after.Nodes, layouts: after.LayoutCount - before.LayoutCount };
    console.log(JSON.stringify(result));
    return result;
  };
  const results = [await sample('24 panes idle', () => page.waitForTimeout(3000))];
  // WebView2 can stay visible while its native window is minimized.
  await page.evaluate(async () => {
    window.qa.minimized = true;
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://resize', payload: { width: 1280, height: 900 } });
  });
  await page.waitForTimeout(200);
  const minimizedBefore = await page.evaluate(() => ({ ...window.qa.calls }));
  await page.evaluate(() => { for (const p of window.qa.panes) p.onOut.onmessage('Background output\r\n'); });
  await page.waitForTimeout(11_000);
  const minimizedAfter = await page.evaluate(() => ({ ...window.qa.calls }));
  for (const call of ['session_usage', 'git_run']) assert.equal(minimizedAfter[call], minimizedBefore[call], `${call} must pause while native window is minimized`);
  for (const call of ['take_sessions', 'pty_acks']) assert.ok(minimizedAfter[call] > (minimizedBefore[call] || 0), `${call} must keep running while minimized`);
  assert.equal(await page.evaluate(() => document.hidden), false, 'Check native minimization even with a visible document');
  await page.evaluate(async () => {
    window.qa.minimized = false;
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://resize', payload: { width: 1280, height: 900 } });
  });
  await page.waitForFunction(n => window.qa.calls.session_usage > n, minimizedAfter.session_usage);
  console.log('PASS native minimized polling, output acknowledgements, and immediate restore');
  await page.evaluate(() => {
    window.qa.slowPolls = true;
    for (let i = 0; i < 4; i++) document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  const concurrentPolls = await page.evaluate(() => { window.qa.slowPolls = false; return window.qa.maxInFlight; });
  console.log('Concurrent identical background reads:', concurrentPolls);
  assert.ok(Object.values(concurrentPolls).every(n => n === 1), 'Slow background polls and visibility changes must not pile up duplicate reads');
  const feed = count => page.evaluate(count => {
    const text = Array.from({ length: count }, (_, i) => 'History line ' + i + '\r\n').join('');
    for (const p of window.qa.panes) p.onOut.onmessage(text);
  }, count);
  results.push(await sample('24 panes with 1800 lines each', async () => { await feed(1800); await page.waitForTimeout(2000); }));
  results.push(await sample('24 panes streaming while hidden', async () => {
    for (let n = 0; n < 30; n++) { await feed(10); await page.waitForTimeout(100); }
    await page.waitForTimeout(200);
  }));
  await page.evaluate(() => {
    for (const canvas of document.querySelectorAll('.grid.hidden canvas')) canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await page.waitForTimeout(100);
  await feed(10);
  const slider = page.locator('.grid:not(.hidden) .xterm .scrollbar.vertical .slider');
  const position = () => slider.evaluate(el => ({ top: parseFloat(el.style.top), height: parseFloat(el.style.height), track: el.parentElement.clientHeight }));
  for (const i of [...Array(24).keys(), ...Array(24).keys(), 0]) {
    await page.locator('.thread-name').nth(i).click();
    await page.waitForTimeout(200);
    const at = await position();
    assert.ok(at.top > at.track / 2, `Pane ${i} must still follow the bottom after hidden output and GPU eviction: ${JSON.stringify(at)}`);
    await feed(10);
  }
  // Overview moves the live terminal into a differently sized dialog and back.
  for (let n = 0; n < 4; n++) {
    await page.locator('#dashboard-btn').click();
    await page.locator('.dashboard-row').filter({ hasText: 'Session 0 / codex' }).click();
    await page.waitForTimeout(200);
    if (n % 2) {
      const previewScreen = await page.locator('#dashboard-preview-output .xterm-screen').boundingBox();
      await page.mouse.move(previewScreen.x + 50, previewScreen.y + 50);
      await page.mouse.wheel(0, 120); // Scrolling down at the bottom must keep following output.
      await page.waitForTimeout(100);
      await feed(1800);
      await page.waitForTimeout(150);
    }
    await page.locator('#dashboard-preview-close').click();
    await page.locator('#dashboard-btn').click();
    await page.waitForTimeout(200);
    const at = await position();
    assert.ok(at.top > at.track / 2, `Overview round trip ${n} disabled follow-output: ${JSON.stringify(at)}`);
  }
  // A deliberately scrolled pane must retain history through both hide and reparent.
  const livePosition = await position();
  const screen = await page.locator('.grid:not(.hidden) .xterm-screen').boundingBox();
  await page.mouse.move(screen.x + 50, screen.y + 50);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(150);
  const history = await position();
  assert.ok(history.top < livePosition.top, 'The history check must first scroll away from the bottom');
  await page.locator('.thread-name').nth(1).click();
  await page.locator('.thread-name').nth(0).click();
  await page.waitForTimeout(200);
  assert.ok(Math.abs((await position()).top - history.top) < 2, 'Switching threads must preserve deliberately scrolled history');
  await page.locator('#dashboard-btn').click();
  await page.locator('.dashboard-row').filter({ hasText: 'Session 0 / codex' }).click();
  await page.waitForTimeout(200);
  await page.locator('#dashboard-preview-close').click();
  await page.locator('#dashboard-btn').click();
  await page.waitForTimeout(200);
  const restoredHistory = await position();
  assert.ok(restoredHistory.top > 0 && Math.abs(restoredHistory.top - history.top) < 1,
    `Preview round trip must retain deliberately scrolled history: ${JSON.stringify({ history, restoredHistory })}`);
  const thumb = await slider.boundingBox();
  const currentScreen = await page.locator('.grid:not(.hidden) .xterm-screen').boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, currentScreen.y + currentScreen.height - 1, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const bottom = await position();
  assert.ok(Math.abs(bottom.top + bottom.height - bottom.track) <= 1, 'Start the hidden-output test at the bottom');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let n = 0; n < 12; n++) {
    await page.locator('.thread-name').nth(13).click();
    await feed(1800);
    await page.setViewportSize({ width: n % 2 ? 1280 : 1024, height: n % 2 ? 900 : 700 });
    await page.waitForTimeout(100);
    await page.locator('.thread-name').nth(0).click();
    await page.waitForTimeout(200);
    const at = await position();
    assert.ok(at.top > at.track / 2, `Hidden output and window resizing reset a following pane: ${JSON.stringify(at)}`);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.screenshot({ path: out + '/restored-pane.png' });
  writeFileSync(out + '/measurements.json', JSON.stringify(results, null, 2));
  await page.locator('.thread-name').nth(3).click();
  await page.locator('.grid:not(.hidden) button[title="Close pane"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => [...window.qa.observed].filter(el => !el.isConnected && el.matches('.pane-term, .grid')).length), 0,
    'Closed panes must disconnect their resize observers');
  await page.evaluate(() => { window.qa.holdStarts = true; });
  await page.locator('#add-pane').click();
  await page.locator('.menu-item').filter({ hasText: /^powershell/ }).click();
  await page.waitForFunction(() => window.qa.pendingStarts.length > 0);
  const closedId = await page.locator('.grid:not(.hidden) .pane').getAttribute('data-id');
  await page.locator('.grid:not(.hidden) button[title="Close pane"]').click();
  await page.evaluate(() => window.qa.pendingStarts.splice(0).forEach(done => done()));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(id => window.qa.activePtys.has(id), closedId), false, 'Closing during startup must also stop the process that finishes spawning afterward');
  assert.equal(await page.evaluate(() => [...window.qa.observed].filter(el => !el.isConnected && el.matches('.pane-term, .grid')).length), 0,
    'A late spawn must not reattach observers to a closed pane');
  await page.locator('#new-thread').click();
  await page.check('input[value=worktree]');
  await page.fill('#new-name', 'closing-start');
  await page.selectOption('#new-agent', 'powershell');
  await page.locator('#new-go').click();
  await page.waitForFunction(() => window.qa.pendingStarts.length > 0);
  const threadPty = await page.evaluate(() => window.qa.panes.at(-1).id);
  await page.keyboard.press('Escape');
  await page.locator('#wsmore').click();
  await page.locator('#menu-list .menu-item').filter({ hasText: 'Close thread' }).click();
  await page.locator('#confirm-action').click();
  await page.evaluate(() => window.qa.pendingStarts.splice(0).forEach(done => done()));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(id => window.qa.activePtys.has(id) || window.qa.pendingStarts.length > 0, threadPty), false,
    'A thread closed during startup must not leave a process or recreate its default pane');
  assert.equal(await page.evaluate(() => [...window.qa.observed].filter(el => !el.isConnected && el.matches('.pane-term, .grid')).length), 0,
    'Closed threads must disconnect their own observer');
  console.log('PASS 24-pane output, GPU eviction, thread switching and preview scroll history');
  await page.locator('.thread-name').first().click();
  await page.locator('#changes-btn').click();
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.qa.slowPolls = true; window.qa.maxInFlight = {}; });
  const gitBefore = await page.evaluate(() => window.qa.calls.git_run);
  await page.locator('#changes-refresh').click();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(n => window.qa.calls.git_run - n, gitBefore), 5, 'One Changes refresh must launch one set of Git reads');
  for (let i = 0; i < 3; i++) await page.locator('#changes-refresh').click();
  await page.waitForTimeout(2200);
  assert.ok(Object.values(await page.evaluate(() => window.qa.maxInFlight)).every(n => n === 1), 'Rapid Changes refreshes must serialize identical reads');
  await page.evaluate(() => { window.qa.slowPolls = false; window.qa.stallOpenCode = true; });
  await page.locator('#changes-btn').click();
  await page.locator('#dashboard-btn').click();
  await page.waitForTimeout(300);
  const readsBefore = await page.evaluate(() => window.qa.calls.last_messages);
  await page.evaluate(() => window.qa.panes.find(p => p.argv[0] === 'claude').onOut.onmessage('Completed work\x07'));
  await page.waitForTimeout(5000);
  assert.ok(await page.evaluate(n => window.qa.calls.last_messages > n, readsBefore), 'A stalled OpenCode export must not prevent other Overview rows refreshing');
  await page.locator('#dashboard-btn').click();
  await page.evaluate(() => { window.qa.holdStarts = false; });
  await page.locator('#add-pane').click();
  await page.locator('.menu-item').filter({ hasText: /^codex/ }).click();
  await page.waitForFunction(() => window.qa.panes.at(-1).argv.join(' ').includes('codex'));
  const codex = await page.evaluate(() => window.qa.panes.at(-1).id);
  const failStartup = () => page.evaluate(async id => {
    const pane = window.qa.panes.filter(p => p.id === id).at(-1);
    // Exit can arrive before the final channel message.
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'pty-exit:' + id, payload: 1 });
    pane.onOut.onmessage('Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed ');
    pane.onOut.onmessage('out (code -32603)');
  }, codex);
  const starts = await page.evaluate(id => window.qa.panes.filter(p => p.id === id).length, codex);
  await failStartup();
  await page.waitForFunction(({ id, starts }) => window.qa.panes.filter(p => p.id === id).length === starts + 1, { id: codex, starts });
  await failStartup();
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(id => window.qa.panes.filter(p => p.id === id).length, codex), starts + 1, 'Codex startup recovery must retry at most once');
  assert.ok(await page.evaluate(() => window.qa.calls.pty_acks > 0), 'Terminal parsing must acknowledge native output');
  console.log('PASS Changes coalescing, independent Overview refresh, bounded Codex bootstrap recovery and parser acknowledgements');
} finally { await browser.close(); }
