// Replay real OpenCode plugin events through the served UI, without API calls.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import definition, { Loom } from '../src-tauri/src/loom-opencode.js';
const command = process.env.OPENCODE_COMMAND || 'opencode';
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = 'node_modules/.cache/opencode-status-check';
mkdirSync(output, { recursive: true });
let marker;
let dispose;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.exposeFunction('takeOpenCodeMarker', () => {
    if (!marker || !existsSync(marker)) return [];
    const value = readFileSync(marker, 'utf8');
    unlinkSync(marker);
    return [[process.env.LOOM_PANE, value]];
  });
  await context.addInitScript({ content: mocks + `\n(${((command) => {
    mockWindows('main');
    window.qa = {};
    mockIPC((call, args = {}) => {
      if (call === 'load_state') return JSON.stringify({ threads: [{ repo: 'C:\\test', dir: 'C:\\test', name: 'OpenCode status', panes: [{ cmd: command }] }] });
      if (call === 'pty_spawn') window.qa.pane = args;
      if (call === 'take_wakes') return window.takeOpenCodeMarker();
      if (['take_sessions', 'model_options'].includes(call)) return [];
      if (call === 'session_usage' || call === 'last_messages') return {};
      if (call === 'git_run') return '';
      if (call === 'pane_booted') return true;
    }, { shouldMockEvents: true });
  }).toString()})(${JSON.stringify(command)});` });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.qa.pane);
  process.env.LOOM_PANE = await page.evaluate(() => window.qa.pane.id);
  delete process.env.LOOM_SESSION_FILE;
  marker = join(tmpdir(), 'loom-wait', process.env.LOOM_PANE);
  const plugin = await Loom({ client: { session: { get: async ({ path }) => ({ data: { id: path.id, ...(path.id === 'ses_child' ? { parentID: 'ses_main' } : {}) } }) } } });
  let event = (type, properties = {}) => plugin.event({ event: { type, properties } });
  if (command === 'opencode2') {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    dispose = await definition.setup({ session: {
      get: async ({ sessionID }) => ({ id: sessionID, ...(sessionID === 'ses_child' ? { parentID: 'ses_main' } : {}) }),
      hook: async () => {},
    }, event: { subscribe: ({ signal }) => { signal.addEventListener('abort', () => void writer.close()); return stream.readable; } } });
    event = (type, data = {}) => {
      if (type === 'session.status') type = data.status.type === 'busy' ? 'session.execution.started' : data.status.type === 'retry' ? 'session.retry.scheduled' : 'session.execution.succeeded';
      if (type === 'session.idle') type = 'session.execution.succeeded';
      return writer.write({ type, data });
    };
  }
  const status = (type, sessionID = 'ses_main') => event('session.status', { sessionID, status: { type } });
  const expect = async (state, message) => {
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.agent').getAttribute('data-state'), state, message);
  };
  await status('busy'); // Resumed sessions do not emit session.created.
  await expect('busy', 'OpenCode busy must show Working even without its interrupt footer');
  await page.evaluate(() => window.qa.pane.onOut.onmessage('BUILD esc inter…\r\n'));
  await expect('busy', 'A truncated footer must not erase the provider busy state');
  await status('idle', 'ses_child');
  await event('session.idle', { sessionID: 'ses_child' });
  await expect('busy', 'A finished subagent must not mark the active parent Waiting');
  await event('permission.asked', { sessionID: 'ses_main', id: 'perm_1' });
  await expect('waiting', 'An approval must show Waiting');
  await event('permission.replied', { sessionID: 'ses_main', requestID: 'perm_1' });
  await expect('busy', 'Answering an approval must restore Working');
  await status('retry');
  await expect('busy', 'A provider retry is still Working');
  await status('idle');
  await event('session.idle', { sessionID: 'ses_main' });
  await expect('waiting', 'A completed turn must show Waiting');
  await status('busy');
  await expect('busy', 'The next turn must clear the previous Waiting state');
  // OpenCode dispatches plugin events without awaiting them. Delay the first
  // resumed-session lookup so a later idle event could otherwise overtake it.
  let release, lookups = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const resumed = await Loom({ client: { session: { get: async () => {
    if (++lookups === 1) await gate;
    return { data: { id: 'ses_resume' } };
  } } } });
  const first = resumed.event({ event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'busy' } } } });
  const last = resumed.event({ event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'idle' } } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await Promise.all([first, last]);
  await expect('waiting', 'Concurrent events must preserve the latest provider status');
  await status('idle');
  await status('busy');
  await expect('busy', 'Working resumes after the concurrency check');
  for (const width of [320, 375, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 760 && await page.locator('#side').isVisible()) await page.click('#side-toggle');
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    assert.equal(await page.locator('.pane-state').textContent(), 'Working');
    assert.ok(await page.locator('.pane-state').isVisible());
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  console.log(`PASS ${command} busy, truncated footer, child idle, approval reply, retry, completion, next turn and concurrent events`);
} finally {
  dispose?.();
  await browser.close();
  if (marker && existsSync(marker)) unlinkSync(marker);
}
