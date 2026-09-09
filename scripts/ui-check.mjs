// Build, then run `npm run preview -- --port 4173` before this check.
// Set PLAYWRIGHT_MODULE to an installed playwright module path if it isn't local.
// Uses Tauri's official mocks; no real terminals, Git writes, or account requests.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200, 'Production preview must be serving');
const out = resolve('node_modules/.cache/ui-check');
mkdirSync(out, { recursive: true });
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
try {
  for (const width of (process.env.UI_WIDTHS || '320,375,768,1024,1280').split(',').map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const setup = () => {
      const repo = 'C:\\projects\\loom';
      const thread = (name, panes) => ({ repo, dir: `${repo}\\${name}`, branch: `loom/${name}`, name, panes: panes.map(cmd => ({ cmd })) });
      const toolsRepo = 'C:\\projects\\tools';
      let state = { repos: [repo, toolsRepo], threads: [thread('search-polish', ['claude', 'codex']), thread('review-keyboard-navigation', ['claude']), { ...thread('fix-settings', ['claude']), repo: toolsRepo, dir: toolsRepo }] };
      if (location.search.includes('memory')) state.threads[2].panes.push({ cmd: 'claude' });
      if (location.search.includes('resume')) state.threads[0].panes = [{ cmd: 'codex' }, { cmd: 'codex' }];
      if (location.search.includes('legacy')) state.threads[0].panes = [{ cmd: 'opencode', sid: 'old-placeholder-a' }, { cmd: 'opencode', sid: 'old-placeholder-b' }];
      if (location.search.includes('restore')) state = JSON.parse(localStorage.getItem('qa-state'));
      const qa = window.qa = { calls: [], panes: [], saved: null, failCreate: false, wakes: [], failSessions: false };
      mockWindows('main');
      mockIPC((cmd, args = {}) => {
        qa.calls.push({ cmd, args });
        if (cmd === 'load_state') return JSON.stringify(location.search.includes('empty') ? {} : state);
        if (cmd === 'save_state') {
          if (qa.failSave) throw new Error('Test disk write failed');
          const write = () => { qa.saved = JSON.parse(args.json); localStorage.setItem('qa-state', args.json); };
          return location.search.includes('memory') ? new Promise(resolve => setTimeout(() => { write(); resolve(); }, 15)) : write();
        }
        if (cmd === 'pty_spawn') {
          qa.panes.push(args);
          args.onOut.onmessage('\x1b]0;Review workspace navigation\x07\x1b[38;2;217;119;87m❯ loom\x1b[0m\r\n\r\nReady to work on this thread.\r\nChanges stay in its own worktree.\r\n');
          return location.search.includes('restore') ? new Promise(resolve => setTimeout(resolve, qa.panes.length * 30)) : undefined;
        }
        if (cmd === 'take_wakes') return qa.wakes.splice(0);
        if (cmd === 'opencode_sessions') {
          if (qa.failSessions) throw new Error('OpenCode could not list sessions');
          return [{ id: 'ses_first', title: 'Fix sidebar navigation' }, { id: 'ses_second', title: 'Review terminal layout' }];
        }
        if (cmd === 'session_usage') return Object.fromEntries(args.panes.map(([id, , sid]) => [id, { ctx: 48000, window: 200000, input: 12000, output: 2400, cacheRead: 16000, cacheWrite: 800, turns: 6, mainTurns: 6, sid, model: 'sonnet', effort: 'high', liveModel: 'sonnet', liveEffort: 'high' }]));
        if (cmd === 'context_profile') return { buckets: [{ label: 'Read', tokens: 24000 }, { label: 'Prompts', tokens: 3000 }], series: [1000, 18000, 48000], drops: [], ctx: 48000, est: 27000 };
        if (cmd === 'plan_usage') return { tier: 'default_claude_pro', stale: false, limits: [{ label: 'session', group: 'session', percent: 24, severity: 'ok', resetsAt: '2026-09-09T05:00:00Z' }] };
        if (cmd === 'model_options') return [];
        if (cmd === 'plugin:dialog|open') return 'C:\\projects\\new-project';
        if (cmd === 'plugin:dialog|confirm') return false;
        if (cmd === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
        if (cmd === 'plugin:path|join') return args.paths.join('\\');
        if (cmd === 'git_run') {
          const a = args.args;
          if (a.includes('MERGE_HEAD') || a.includes('REVERT_HEAD') || a[0] === 'rebase') throw new Error('No operation in progress');
          if (a[0] === 'worktree' && a[1] === 'add' && qa.failCreate) throw new Error('Could not create worktree: branch is locked');
          if (a[0] === 'status') return ' M src/main.ts\0M  src/styles.css\0?? notes.txt\0';
          if (a.includes('--numstat')) return '18\t4\tsrc/main.ts\n7\t2\tsrc/styles.css\n';
          if (a[0] === 'diff' || a[0] === 'show') return 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old navigation\n+const description = "A long line of source code that should remain readable when reviewing changes inside a narrow workspace window.";\n';
          if (a[0] === 'log') return 'abc123 Improve workspace navigation\n';
          if (a[0] === 'branch') return 'main\nloom/search-polish\n';
          if (a[0] === 'stash' && a[1] === 'list') return 'stash@{0}\tOn main: workspace polish\n';
          if (a[0] === 'rev-list') return '0\t2';
          if (a.includes('--show-toplevel')) return args.dir;
          if (a.includes('@{upstream}')) return 'origin/main';
          if (a[0] === 'rev-parse') return 'main';
          return '';
        }
      }, { shouldMockEvents: true });
    };
    await context.addInitScript({ content: mocks + '\n(' + setup.toString() + ')();' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser:', e.message); });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved).catch(async e => {
      console.error(await page.evaluate(() => ({ panes: document.querySelectorAll('.pane').length, calls: window.qa?.calls.map(c => c.cmd), text: document.body.innerText.slice(0, 1000) })));
      throw e;
    });
    await page.waitForTimeout(250);
    // The skill's scrollWidth invariant, plus visible control bounds to catch clipping.
    async function audit(name) {
      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const offenders = [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea, dialog[open]')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.xterm') && (r.left < -1 || r.right > root.clientWidth + 1);
        }).map(el => `${el.tagName}#${el.id}.${el.className}`);
        return { width: root.clientWidth, scroll: root.scrollWidth, offenders };
      });
      assert.equal(result.width, width);
      assert.ok(result.scroll <= width, `${name}@${width}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.offenders, [], `${name}@${width}: clipped controls`);
      await page.screenshot({ path: `${out}/${name}-${width}.png` });
      checks++;
    }
    const escape = () => page.keyboard.press('Escape');
    await audit('workspace');
    for (const id of ['lang', 'prefix', 'layout']) {
      assert.equal(await page.locator('#bar #' + id).isVisible(), true, id + ' must be visible in the top bar');
    }
    assert.equal(await page.locator('#switch-thread').count(), 0);
    if (width <= 760) await page.click('#side-toggle');
    await audit('sidebar-hierarchy');
    assert.ok(await page.locator('.thread-top button').evaluateAll((buttons, min) => buttons.every(b => b.getBoundingClientRect().width >= min && b.getBoundingClientRect().height >= min), width <= 760 ? 32 : 24));
    assert.ok(await page.locator('.agent').evaluateAll((rows, max) => rows.every(row => row.getBoundingClientRect().height <= max), width <= 760 ? 34 : 28));
    await page.locator('.repo').first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.repo').first().getAttribute('aria-expanded'), 'false');
    await audit('project-collapsed');
    await page.fill('#side-filter', 'review-keyboard');
    await audit('sidebar-filter');
    assert.equal(await page.locator('.repo').first().getAttribute('aria-expanded'), 'true');
    await page.fill('#side-filter', '');
    assert.equal(await page.locator('.repo').first().getAttribute('aria-expanded'), 'false');
    await page.locator('.repo').first().click();
    await page.locator('.thread-select').filter({ hasText: 'review-keyboard-navigation' }).click();
    assert.equal(await page.locator('#wsname').textContent(), 'review-keyboard-navigation');
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x07')));
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '4 waiting');
    await page.click('#waiting');
    await audit('waiting-list');
    assert.equal(await page.locator('.picker-row').count(), 4);
    await page.fill('#picker-query', 'does-not-exist');
    await audit('waiting-no-results');
    assert.equal(await page.locator('.picker-row').count(), 0);
    await page.fill('#picker-query', '');
    await page.locator('.picker-row').filter({ hasText: 'search-polish / codex' }).click();
    assert.equal(await page.locator('#waiting').textContent(), '3 waiting', 'Opening one agent must clear only its own notification');
    assert.match(await page.locator('.thread.on .agent.on').textContent(), /codex/);
    const closePane = page.locator('.grid:not(.hidden) .pane-head button[title="Close pane"]').first();
    await closePane.click();
    await audit('confirm-close-pane');
    assert.equal(await page.locator('#confirm button[value=cancel]').evaluate(b => b === document.activeElement), true);
    await escape();
    assert.equal(await page.locator('.pane').count(), 4);
    assert.equal(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'pty_kill')), false);
    await closePane.click();
    await page.click('#confirm button[value=cancel]');
    assert.equal(await page.locator('.pane').count(), 4);
    for (const id of ['theme', 'lang', 'prefix']) {
      if (id === 'theme') {
        await page.click('#preferences-btn');
        await audit('preferences');
      }
      await page.click('#' + id);
      await audit(id + '-menu');
      if (id !== 'theme') {
        await page.locator('.menu-item').nth(1).locator('span').first().click();
        assert.equal(await page.evaluate(key => window.qa.saved[key], id), 1, id + ' selection must be saved');
        await audit(id + '-selected');
      }
      await escape();
    }
    await page.click('#layout');
    assert.match(await page.locator('#layout').textContent(), /grid/);
    await escape();
    await audit('layout-grid');
    await page.click('#layout');
    assert.match(await page.locator('#layout').textContent(), /rows/);
    await escape();
    await audit('layout-rows');
    await page.keyboard.press('F1');
    await audit('shortcuts');
    await escape();
    for (const id of ['add-pane', 'wsmore', 'plan']) {
      await page.click('#' + id);
      await audit(id + '-menu');
      await escape();
    }
    await page.click('#wsmore');
    await page.locator('.menu-item').filter({ hasText: /^Rename/ }).click();
    await audit('rename');
    await escape();
    await page.locator('.grid:not(.hidden) .cfg').first().click();
    await audit('pane-settings');
    await escape();
    await page.locator('.grid:not(.hidden) .ctx').first().click();
    await page.waitForSelector('.spark');
    await audit('context-profile');
    await escape();
    await page.keyboard.press('Control+f');
    await audit('terminal-search');
    await escape();
    await page.click('#changes-btn');
    await page.waitForSelector('.file');
    await audit('changes');
    for (const id of ['commit-more', 'changes-more']) {
      await page.click('#' + id);
      await audit(id + '-menu');
      await escape();
    }
    for (const [label, name] of [['Switch branch', 'branches'], ['Restore a stash', 'stashes']]) {
      await page.click('#changes-more');
      await page.locator('.menu-item').filter({ hasText: label }).click();
      await page.waitForSelector('#pane-menu:not(.hidden)');
      await audit(name);
      await escape();
    }
    await page.locator('.file').first().click({ button: 'right' });
    await audit('file-actions');
    await page.locator('.menu-item').filter({ hasText: /^Discard changes/ }).click();
    await audit('confirm-discard');
    await escape();
    await page.locator('.changes-h').filter({ hasText: 'Commits' }).click();
    await page.locator('.commit').first().click({ button: 'right' });
    await audit('commit-actions');
    await escape();
    await page.locator('.file').first().click();
    await page.waitForSelector('#diff:not(.hidden) .line');
    await page.click('#changes-close');
    await audit('diff');
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x07')));
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '4 waiting');
    await page.click('#waiting');
    await page.locator('.picker-row').filter({ hasText: 'search-polish / codex' }).click();
    assert.equal(await page.locator('#diff').isVisible(), false, 'Waiting chooser must reveal the terminal behind an open diff');
    assert.equal(await page.locator('#waiting').textContent(), '3 waiting');
    await page.keyboard.press('F2');
    await audit('zoomed-pane');
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting');
    await page.click('#waiting');
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${window.qa.panes.at(-1).id}`, payload: 0 }));
    assert.equal(await page.locator('.picker-row').count(), 1, 'An exited pane must leave the waiting list immediately');
    await escape();
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#waiting').isVisible(), false);
    await page.click('#new-thread');
    await audit('new-checkout');
    await page.check('input[value=worktree]');
    await page.fill('#new-name', 'keyboard-pass');
    await audit('new-worktree');
    await page.click('#new-advanced summary');
    await audit('new-advanced');
    await page.fill('#new-base', 'main');
    await page.evaluate(() => window.qa.failCreate = true);
    await page.click('#new-go');
    await page.waitForFunction(() => document.querySelector('#new-err').textContent.includes('locked'));
    await audit('new-error');
    assert.equal(await page.locator('#new-go').isEnabled(), true);
    await page.evaluate(() => window.qa.failCreate = false);
    await page.click('#new-go');
    await page.waitForFunction(() => !document.querySelector('#new').open);
    assert.equal(await page.locator('#wsname').textContent(), 'keyboard-pass');
    assert.ok(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'git_run' && c.args.args[0] === 'worktree' && c.args.args.includes('loom/keyboard-pass') && c.args.args.at(-1) === 'main')));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    for (let i = 0; i < 2; i++) {
      await page.click('#add-pane');
      await page.locator('.menu-item').filter({ hasText: /^claude/ }).click();
    }
    await audit('four-panes');
    const paneWidths = await page.locator('.grid:not(.hidden) .pane').evaluateAll(panes => panes.map(p => p.clientWidth));
    assert.ok(paneWidths.every(w => w >= 260), 'Pane controls must stay readable with four columns requested');
    if (width <= 760) await page.click('#side-toggle');
    const source = await page.locator('.thread-select').filter({ hasText: 'search-polish' }).boundingBox();
    const target = await page.locator('.thread').filter({ has: page.locator('.thread-select', { hasText: 'review-keyboard-navigation' }) }).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, target.y + target.height - 8, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.qa.saved.threads[0].name), 'review-keyboard-navigation', 'Thread-name buttons must still support drag-to-reorder');
    await page.goto(base + '?empty');
    await page.waitForSelector('#empty:not(.hidden)');
    await audit('empty-workspace');
    await page.click('#new-thread');
    await page.click('#new-browse');
    await page.waitForFunction(() => document.querySelector('#new-repo').value.includes('new-project'));
    await page.click('#new-go');
    await page.waitForFunction(() => !document.querySelector('#new').open);
    assert.ok(await page.evaluate(() => !window.qa.calls.some(c => c.cmd === 'git_run' && c.args.args[0] === 'worktree')), 'Opening a checkout must not create a worktree');
    await page.goto(base + '?resume');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.evaluate(() => {
      const codex = window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex'));
      window.qa.wakes.push([codex[0].id + '.session', '11111111-2222-4333-8444-555555555555'], [codex[1].id + '.session', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    });
    await page.waitForFunction(() => window.qa.saved.threads[0].panes.every(p => p.sessionId));
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.panes.length === 4);
    const restored = await page.evaluate(() => window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex')).map(p => p.argv.at(-1)));
    assert.ok(restored.some(c => c.includes('resume 11111111-2222-4333-8444-555555555555')));
    assert.ok(restored.some(c => c.includes('resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')));
    assert.ok(restored.every(c => !c.includes('--last') && !c.includes('||')));
    await page.goto(base + '?legacy');
    await page.waitForSelector('.resume-notice');
    await audit('legacy-session-recovery');
    await page.locator('.resume-notice button').filter({ hasText: 'Choose session' }).first().click();
    await page.waitForSelector('#session-list button');
    await audit('session-picker');
    await escape();
    assert.equal(await page.locator('.resume-notice').count(), 2);
    await page.evaluate(() => window.qa.failSessions = true);
    await page.locator('.resume-notice button').filter({ hasText: 'Choose session' }).first().click();
    await page.waitForFunction(() => document.querySelector('#session-list').textContent.includes('Could not load'));
    await audit('session-picker-error');
    await escape();
    await page.evaluate(() => window.qa.failSessions = false);
    await page.locator('.resume-notice button').filter({ hasText: 'Choose session' }).first().click();
    await page.locator('#session-list button').first().click();
    await page.waitForFunction(() => window.qa.panes.some(p => p.argv.at(-1) === 'opencode --session ses_first'));
    await page.locator('.grid:not(.hidden) .pane-head button[title="Close pane"]').first().click();
    await page.click('#confirm-action');
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 3);
    assert.ok(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'pty_kill')));
    assert.equal(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'plugin:dialog|confirm')), false);
    await page.goto(base + '?memory');
    await page.waitForFunction(() => window.qa.saved?.threads[2].panes.length === 2);
    if (width <= 760) await page.click('#side-toggle');
    await page.locator('.thread-select').filter({ hasText: 'fix-settings' }).click();
    if (width > 760) {
      const split = page.locator('.grid:not(.hidden) .split').first();
      const r = await split.boundingBox();
      const horizontal = await split.evaluate(el => getComputedStyle(el).cursor === 'col-resize');
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2 + (horizontal ? 35 : 0), r.y + r.height / 2 + (horizontal ? 0 : 35));
      await page.mouse.up();
    }
    await page.locator('.grid:not(.hidden) .pane-title').nth(1).click();
    await page.keyboard.press('F2');
    await page.click('#changes-btn');
    await page.fill('#commit-msg', 'Keep this draft in the tools project');
    await page.waitForSelector('.file');
    await page.locator('.file').first().click();
    await page.click('#changes-close');
    if (width > 760) await page.click('#side-toggle');
    await page.waitForFunction(() => window.qa.saved?.ui.thread === 2 && window.qa.saved.ui.sideOpen === false && window.qa.saved.threads[2].tab === 0);
    await page.waitForTimeout(250); // ResizeObserver settles after hiding the sidebar.
    const remembered = await page.evaluate(() => window.qa.saved);
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.saved);
    assert.equal(await page.locator('#wsname').textContent(), 'fix-settings');
    assert.equal(await page.locator('#side').isVisible(), false);
    assert.equal(await page.locator('#changes').isVisible(), false);
    assert.equal(await page.locator('#diff').isVisible(), true);
    const afterRestore = await page.evaluate(() => window.qa.saved);
    for (const key of ['active', 'zoomed', 'tabs', 'tab', 'commitDraft', 'colW', 'rowH']) {
      assert.deepEqual(afterRestore.threads[2][key], remembered.threads[2][key], 'Restore ' + key);
    }
    const firstSave = await page.evaluate(() => JSON.parse(window.qa.calls.find(c => c.cmd === 'save_state').args.json));
    assert.equal(firstSave.ui.thread, 2, 'Do not save temporary startup selection');
    assert.equal(firstSave.threads.length, 3, 'Do not save a partial workspace during restore');
    await audit('restored-workspace');
    await page.click('#diff-close');
    assert.equal(await page.locator('.grid:not(.hidden) .pane.zoom').count(), 1);
    await audit('restored-pane-zoom');
    await page.click('#changes-btn');
    assert.equal(await page.inputValue('#commit-msg'), 'Keep this draft in the tools project');
    await page.click('#side-toggle');
    await page.fill('#side-filter', 'fix-settings');
    await page.waitForFunction(() => window.qa.saved.ui.sideOpen && window.qa.saved.ui.changesOpen && window.qa.saved.ui.sideQuery === 'fix-settings');
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.saved);
    assert.equal(await page.locator('#side').isVisible(), true);
    assert.equal(await page.locator('#changes').isVisible(), true);
    assert.equal(await page.inputValue('#side-filter'), 'fix-settings');
    await audit('restored-panels');
    await page.evaluate(async () => {
      window.qa.failSave = true;
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://close-requested', payload: null });
    });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Could not close safely'));
    assert.equal(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'plugin:window|destroy')), false, 'A failed save must not close the window');
    await page.evaluate(async () => {
      window.qa.failSave = false;
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://close-requested', payload: null });
    });
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'plugin:window|destroy'));
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log(`PASS ${width}px`);
    await context.close();
  }
  console.log(`PASS ${checks} rendered states. Screenshots: ${out}`);
} finally { await browser.close(); }
