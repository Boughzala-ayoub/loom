// Frontend cost probe for docs/performance-plan.md. Build and serve the production bundle first.
// Mocked IPC, 9 threads and 27 panes shaped like the real workspace. Measures idle cost, output cost
// by agent type, the sidebar spinner with 1 and 9 busy rows, Overview rebuilds, and writes a CPU profile.
// Numbers only, no pass/fail: compare them between builds. Headless Chrome doesn't cap frames at 60 Hz.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.RESP_BASE || 'http://localhost:4173';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const out = 'node_modules/.cache/perf-frontend-check';
mkdirSync(out, { recursive: true });
const MIX = ['codex', 'claude', 'opencode', 'codex', 'claude', 'opencode', 'codex', 'claude', 'codex', 'claude', 'powershell', 'codex', 'claude', 'opencode', 'codex', 'claude', 'opencode', 'codex', 'claude', 'codex', 'claude', 'powershell', 'codex', 'codex', 'opencode', 'codex', 'claude'];
// Real GPU, so the compositor isn't software WebGL.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const results = {};
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript({ content: mocks + `\n(${(() => {
    window.qa = { panes: [], calls: {} };
    mockWindows('main');
    mockIPC((call, args = {}) => {
      window.qa.calls[call] = (window.qa.calls[call] || 0) + 1;
      if (call === 'load_state') return JSON.stringify({ ui: { thread: 0, changesOpen: false }, threads: Array.from({ length: 9 }, (_, i) => ({
        repo: 'C:\\test' + i, dir: 'C:\\test' + i, name: 'Thread ' + i, open: true,
        panes: window.MIX.slice(i * 3, i * 3 + 3).map((cmd, j) => ({ cmd, ...(cmd === 'opencode' || cmd === 'codex' ? { sessionId: 'ses_' + i + j } : {}) })),
      })) });
      if (call === 'pty_spawn') window.qa.panes.push(args);
      if (call === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
      if (call === 'plugin:path|join') return args.paths.join('\\');
      if (call === 'git_run') return '';
      if (call === 'pane_booted' || call === 'has_session' || call === 'has_codex_session') return true;
      if (['take_sessions', 'model_options'].includes(call)) return [];
      if (call === 'session_usage') return {};
      if (call === 'last_messages') return Object.fromEntries(args.panes.map(p => [p[0], { user: 'Fix the bug', agent: 'Done.' }]));
    }, { shouldMockEvents: true });
  }).toString()})();`.replace('window.MIX', JSON.stringify(MIX)) });
  const page = await context.newPage();
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(base);
  await page.waitForFunction(n => window.qa.panes.length === n, MIX.length);
  await page.waitForTimeout(1500);
  const renderer = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'none'; });
  console.log('WebGL renderer:', renderer);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const sample = async (name, seconds, work) => {
    await page.evaluate(() => { window.qa.calls = {}; });
    const before = await metrics();
    const stop = work ? await work() : null;
    await page.waitForTimeout(seconds * 1000);
    if (stop) await stop();
    const after = await metrics();
    const d = k => after[k] - before[k];
    const secs = after.Timestamp - before.Timestamp;
    const calls = await page.evaluate(() => window.qa.calls);
    const r = { secs: +secs.toFixed(2), mainThreadPct: +(d('TaskDuration') / secs * 100).toFixed(1), scriptPct: +(d('ScriptDuration') / secs * 100).toFixed(1),
      stylePerSec: +(d('RecalcStyleCount') / secs).toFixed(1), styleMsPerSec: +(d('RecalcStyleDuration') * 1000 / secs).toFixed(1),
      layoutPerSec: +(d('LayoutCount') / secs).toFixed(1), layoutMsPerSec: +(d('LayoutDuration') * 1000 / secs).toFixed(1),
      heapMB: +(after.JSHeapUsedSize / 1048576).toFixed(1), nodes: after.Nodes, ipcPerSec: +(Object.values(calls).reduce((a, b) => a + b, 0) / secs).toFixed(1), calls };
    console.log(name.padEnd(46), JSON.stringify(r));
    results[name] = r;
    return r;
  };
  // Drive panes with TUI-like redraw frames: cursor home on the last rows, a changing status line.
  // `limit` drives only the first N matching panes.
  const driver = (filter, hz, withHint = true, limit = Infinity) => async () => {
    await page.evaluate(({ filter, hz, withHint, limit }) => {
      let n = 0;
      const targets = window.qa.panes.filter(p => filter.includes(p.argv.join(' ').match(/codex|claude|opencode|powershell/)?.[0])).slice(0, limit);
      window.qa.driven = targets.length;
      window.qa.timer = setInterval(() => {
        n++;
        for (const p of targets) {
          const hint = withHint ? ' · esc to interrupt' : '';
          p.onOut.onmessage(`\x1b[?25l\x1b[20;1H\x1b[2K\x1b[38;5;208m✻\x1b[0m Working… (${Math.floor(n / hz)}s${hint}) ${'─'.repeat(40)}\x1b[21;1H\x1b[2K> \x1b[?25h`);
        }
      }, 1000 / hz);
    }, { filter, hz, withHint, limit: limit === Infinity ? 1e9 : limit });
    return () => page.evaluate(() => clearInterval(window.qa.timer));
  };
  const busyRows = () => page.locator('.agent[data-state="busy"]').count();
  await page.locator('.thread-name').nth(0).click();
  await page.waitForTimeout(500);

  await sample('A idle, 27 panes', 5);
  // B: output rate and cost by agent type. 10 Hz status redraws.
  const panes = (...kinds) => MIX.filter(c => kinds.includes(c)).length;
  await sample(`B1 claude panes (${panes('claude')}) 10Hz`, 5, driver(['claude'], 10));
  await page.waitForTimeout(2000);
  await sample(`B2 codex+opencode panes (${panes('codex', 'opencode')}) 10Hz`, 5, driver(['codex', 'opencode'], 10));
  await page.waitForTimeout(2000);
  await sample('B3 codex+opencode, no interrupt hint 10Hz', 5, driver(['codex', 'opencode'], 10, false));
  await page.waitForTimeout(2000);
  // C: sidebar spinner. Every thread is listed (open: true), so each busy claude pane is a spinning row.
  // 3 Hz output keeps them busy. Off = the same load with the spinner held on one frame: the spin
  // clock still writes --spin, but nothing it drives moves.
  const spinner = async (label, limit) => {
    let rows = 0;
    const r = await sample(label, 5, async () => { const stop = await driver(['claude'], 3, true, limit)(); await page.waitForTimeout(1000); rows = await busyRows(); return stop; });
    console.log('  busy rows while sampling:', rows);
    r.busyRows = rows;
    await page.waitForTimeout(2000);
  };
  await spinner('C1 1 busy row, spinner on', 1);
  await spinner(`C2 ${panes('claude')} busy rows, spinner on`, Infinity);
  await page.addStyleTag({ content: '.agent-spin > span { transform: none !important; }' });
  await page.waitForTimeout(500);
  await spinner('C3 1 busy row, spinner animation off', 1);
  await spinner(`C4 ${panes('claude')} busy rows, spinner animation off`, Infinity);
  // D: Overview open, busy agents with a changing status line (1 Hz like a seconds timer).
  await page.locator('#dashboard-btn').click();
  await page.waitForTimeout(1500);
  // A rebuild is wasted when the cards' text is the same afterwards.
  await page.evaluate(() => {
    const list = document.querySelector('#dashboard-list');
    let text = list.textContent;
    window.qa.rebuilds = window.qa.wasted = 0;
    new MutationObserver(() => { window.qa.rebuilds++; if (list.textContent === text) window.qa.wasted++; text = list.textContent; }).observe(list, { childList: true });
  });
  const rebuilds = () => page.evaluate(() => { const r = { all: window.qa.rebuilds, wasted: window.qa.wasted }; window.qa.rebuilds = window.qa.wasted = 0; return r; });
  await sample('D1 overview open, idle', 5);
  results.overviewRebuilds5s = { idle: await rebuilds() };
  await sample('D2 overview open, claude+codex 2Hz', 5, driver(['claude', 'codex'], 2));
  results.overviewRebuilds5s.busy = await rebuilds();
  // D3: the same, counted once every driven pane is already working. D2 also counts the cards moving
  // into Working, and the message re-read the next 4 s poll makes for each pane that started working.
  await page.waitForTimeout(2000);
  await sample('D3 overview open, claude+codex 2Hz, already working', 5, async () => {
    const stop = await driver(['claude', 'codex'], 2)();
    await page.waitForTimeout(6000); // past that poll: its 4 s gate is checked once a second
    await rebuilds();
    return stop;
  });
  results.overviewRebuilds5s.alreadyWorking = await rebuilds();
  console.log('overview rebuilds per 5 s, all and wasted:', JSON.stringify(results.overviewRebuilds5s), 'cards', await page.locator('.dashboard-card').count());
  await page.locator('#dashboard-btn').click();
  await page.waitForTimeout(1000);
  // E: CPU profile of the codex/opencode path to attribute time.
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const stop = await driver(['codex', 'opencode'], 10)();
  await page.waitForTimeout(4000);
  await stop();
  const { profile } = await cdp.send('Profiler.stop');
  writeFileSync(out + '/codex-opencode.cpuprofile', JSON.stringify(profile));
  // Self time by function.
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; let total = 0;
  profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); total += dt[i] || 0; });
  const top = [...self].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('profile total ms', (total / 1000).toFixed(0));
  for (const [k, v] of top) console.log((v / 1000).toFixed(1).padStart(8), 'ms', k);
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2));
  console.log('Wrote', out + '/results.json');
} finally { await browser.close(); }
