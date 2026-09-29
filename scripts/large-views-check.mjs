// npm run build; serve dist, then RESP_BASE=http://127.0.0.1:4178 node scripts/large-views-check.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.RESP_BASE || 'http://127.0.0.1:4178';
assert.equal((await fetch(base)).status, 200);
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const out = 'node_modules/.cache/large-views-check';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const [mode, count, wrapped] of [['file', 1000], ['file', 50000], ['file', 250000], ['tree', 1000], ['tree', 20000], ['file', 5000, true], ['diff', 5000, true]]) {
    if (process.argv.length > 2 && !process.argv.slice(2).includes(mode)) continue;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const setup = ({ mode, count, wrapped }) => {
      window.qa = { panes: [], tasks: [], patches: [] };
      new PerformanceObserver(list => window.qa.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
      const line = wrapped ? 'a long wrapped source line '.repeat(12) : 'value=1';
      const patch = `diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -1,${count - 100} +1,${count - 100} @@\n`
        + (' ' + line + '\n').repeat(count - 100)
        + `@@ -${count - 99},100 +${count - 99},100 @@\n-old\n+new\n` + (' ' + line + '\n').repeat(99);
      mockWindows('main');
      mockIPC((call, args = {}) => {
        if (call === 'load_state') return JSON.stringify({ ui: { thread: 0, planUsage: false }, threads: [{ repo: 'C:\\test', dir: 'C:\\test', name: 'Large views', panes: [{ cmd: 'powershell' }] }] });
        if (call === 'pty_spawn') window.qa.panes.push(args);
        if (call === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
        if (call === 'plugin:path|join') return args.paths.join('\\');
        if (call === 'git_run') {
          if (args.args[0] === 'ls-files') return mode === 'tree'
            ? Array.from({ length: count }, (_, i) => `file-${String(i).padStart(6, '0')}.txt\0`).join('') : 'large.txt\0';
          if (mode === 'diff' && args.args[0] === 'status') return ' M large.txt\0';
          if (mode === 'diff' && args.args[0] === 'diff' && args.args.includes('--')) return patch;
          return '';
        }
        if (call === 'git_stdin') window.qa.patches.push(args);
        if (call === 'read_file') return (line + '\n').repeat(count);
        if (call === 'pane_booted') return true;
        if (['take_wakes', 'take_sessions', 'model_options'].includes(call)) return [];
        if (call === 'session_usage' || call === 'last_messages') return {};
      }, { shouldMockEvents: true });
    };
    await context.addInitScript({ content: mocks + '\n(' + setup.toString() + ')(' + JSON.stringify({ mode, count, wrapped }) + ');' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.qa.panes.length === 1);
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const before = await metrics();
    await page.evaluate(() => { window.qa.measureStart = performance.now(); window.qa.tasks = []; });
    await page.locator('#changes-btn').click();
    if (mode !== 'diff') await page.locator('#panel-files').click();
    await page.locator('#changes-body .file').first().waitFor();
    if (mode !== 'tree') {
      await page.locator('#changes-body .file').first().click();
      await page.locator('#diff-body .line').first().waitFor();
    }
    await page.waitForTimeout(300);
    const after = await metrics();
    const body = mode === 'tree' ? '#changes-body' : '#diff-body';
    const details = await page.evaluate(({ mode, body }) => ({
      rows: document.querySelectorAll(body + (mode === 'tree' ? ' .file' : ' .line')).length,
      nodes: document.querySelectorAll('*').length,
      longTasks: window.qa.tasks.filter(t => t.start >= window.qa.measureStart),
    }), { mode, body });
    const result = { mode, inputRows: count, wrapped: !!wrapped,
      taskMs: +((after.TaskDuration - before.TaskDuration) * 1000).toFixed(1),
      heapGrowthMiB: +((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576).toFixed(1), ...details };
    assert.ok(result.rows > 0 && result.rows <= 600, 'Render nearby rows, never the entire large list');
    assert.ok(result.nodes < 3000, `DOM must stay bounded: ${JSON.stringify(result)}`);
    console.log(JSON.stringify(result));
    results.push(result);
    writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
    await page.locator('#side-toggle').click();
    if (mode !== 'tree') await page.locator('#changes-btn').click();
    await page.waitForTimeout(250);
    const audit = async label => {
      assert.ok(await page.evaluate(body => {
        const root = document.documentElement, el = document.querySelector(body);
        return root.scrollWidth <= root.clientWidth && el.scrollWidth <= el.clientWidth;
      }, body), `No horizontal overflow in ${mode}/${label}`);
      await page.screenshot({ path: `${out}/${mode}-${count}-${wrapped ? 'wrap' : 'short'}-${label}.png` });
    };
    const widths = process.env.UI_WIDTHS ? process.env.UI_WIDTHS.split(',').map(Number)
      : wrapped || mode === 'tree' ? [1280, 1024, 768, 375, 320, 769, 1025, 1280] : [1280];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      for (const ratio of [0, 0.5, 1, 0]) {
        // Wrapped blocks acquire their real height as visited. Repeat an end
        // jump until the newly measured last block is also at the bottom.
        for (let n = 0; n < 3; n++) {
          await page.locator(body).evaluate((el, ratio) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio; }, ratio);
          await page.waitForTimeout(100);
        }
        await audit(`${width}-${ratio}`);
        if (ratio === 1) {
          if (mode === 'tree') assert.equal(await page.locator('#changes-body .file').last().getAttribute('title'), `file-${String(count - 1).padStart(6, '0')}.txt`);
          else assert.equal(await page.locator('#diff-body .line i + i').last().textContent(), String(Math.min(count, 50000)));
        }
        if (ratio === 0 && mode !== 'tree') assert.ok(await page.locator('#diff-body .line').first().textContent(), 'Top rows return after eviction');
      }
    }
    if (count > 50000) assert.ok((await page.locator(body).textContent()).includes(`${count - 50000} more lines`));
    if (mode === 'file') {
      const selected = await page.locator(body).evaluate(el => {
        const spans = el.querySelectorAll('.line > span');
        const range = document.createRange();
        range.setStart(spans[0].firstChild, 0);
        range.setEnd(spans[1].firstChild, spans[1].textContent.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return getSelection().toString();
      });
      await page.locator(body).evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => getSelection().toString()), selected, 'Scrolling must preserve selected text');
    }
    if (mode === 'tree') {
      await page.locator(body).evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(200);
      await page.locator('#changes-body .file').last().click({ button: 'right' });
      await page.waitForTimeout(200);
      await audit('file-context-menu');
      assert.ok((await page.locator('#pane-menu').textContent()).includes('Copy path'));
    }
    if (mode === 'diff') {
      await page.locator(body).evaluate(el => {
        const block = [...el.querySelectorAll('.row-block')].find(b => +b.dataset.start <= 4904 && +b.dataset.start + 100 > 4904);
        el.scrollTop = block.offsetTop;
      });
      const hunk = page.locator('#diff-body .line.hunk').filter({ hasText: '@@ -4901,100' });
      await hunk.waitFor();
      await hunk.getByRole('button', { name: 'Stage this hunk', exact: true }).click();
      assert.ok(await page.evaluate(() => window.qa.patches.some(p => p.patch.includes('@@ -4901,100 +4901,100 @@') && !p.patch.includes('@@ -1,'))), 'Stage the correct hunk after scrolling');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); }
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log('PASS bounded DOM, wrapped scrolling, last rows, file menus and off-screen hunks');
