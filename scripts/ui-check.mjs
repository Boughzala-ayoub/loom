// Build, then run `npm run preview -- --port 4173` before this check.
// Set PLAYWRIGHT_MODULE to an installed playwright module path if it isn't local.
// Uses Tauri's official mocks; no real terminals, Git writes, or account requests.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RESP_BASE || 'http://127.0.0.1:4173';
assert.equal((await fetch(base)).status, 200, 'Production preview must be serving');
const out = resolve('node_modules/.cache/ui-check', process.env.UI_THEME || '');
mkdirSync(out, { recursive: true });
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
let checks = 0;
try {
  for (const width of (process.env.UI_WIDTHS || '320,375,768,1024,1280').split(',').map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: Number(process.env.UI_HEIGHT || 900) } });
    const setup = (theme) => {
      const repo = 'C:\\projects\\loom';
      const thread = (name, panes) => ({ repo, dir: `${repo}\\${name}`, branch: `loom/${name}`, name, panes: panes.map(cmd => ({ cmd })) });
      const toolsRepo = 'C:\\projects\\tools';
      let state = { repos: [repo, toolsRepo], threads: [thread('search-polish', ['claude', 'codex']), thread('review-keyboard-navigation', ['claude']), { ...thread('fix-settings', ['claude']), repo: toolsRepo, dir: toolsRepo }] };
      state.theme = theme;
      if (location.search.includes('long-location')) {
        state.threads[0].branch = '';
        state.threads[0].dir = 'C:\\Users\\ayoub\\Videos\\claude\\personal-portfolio\\personal-portfolio';
        state.agentGroups = [{ id: 'active', name: 'active' }];
        state.threads[0].panes.forEach(p => { p.groupIds = ['active']; });
      }
      if (location.search.includes('dashboard')) Object.assign(state.threads[0].panes[1], { sid: 'dashboard-codex-pane', sessionId: 'valid-session' });
      if (location.search.includes('needs-session')) delete state.threads[0].panes[1].sessionId;
      if (location.search.includes('many')) state.threads = Array.from({ length: 40 }, (_, i) => thread(`thread-${i}-with-a-long-review-description`, ['claude']));
      if (location.search.includes('memory')) state.threads[2].panes.push({ cmd: 'claude' });
      if (location.search.includes('resume')) state.threads[0].panes = [{ cmd: 'codex' }, { cmd: 'codex' }];
      if (location.search.includes('close-race')) state.threads[0].zoomed = 0;
      if (location.search.includes('hold-session')) state.threads[0].panes[0].sid = 'held-claude'; // resumes, so asks has_session
      if (location.search.includes('legacy')) state.threads[0].panes = [{ cmd: 'opencode', sid: 'old-placeholder-a' }, { cmd: 'opencode', sid: 'old-placeholder-b' }];
      if (location.search.includes('legacy-opencode2')) state.threads[0].panes.forEach(p => p.cmd = 'opencode2');
      if (location.search.includes('stale-codex')) state.threads[0].panes = [{ cmd: 'codex', sid: 'pane-a', sessionId: 'missing-session' }];
      if (location.search.includes('restore')) state = JSON.parse(localStorage.getItem('qa-state'));
      const qa = window.qa = { calls: [], panes: [], saved: null, failCreate: false, sessions: [], failSessions: false, beeps: 0, holdKills: false, pendingKills: [], pendingSessions: [], pendingWrites: [], pendingCodex: [] };
      // Count chimes instead of playing them; only createOscillator matters.
      const node = { connect() { return node; }, start() {}, stop() {}, frequency: { setValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
      window.AudioContext = class { state = 'running'; currentTime = 0; destination = node; resume() {} createGain() { return node; } createOscillator() { qa.beeps++; return node; } };
      mockWindows('main');
      mockIPC((cmd, args = {}) => {
        qa.calls.push({ cmd, args });
        if (cmd === 'load_state') return JSON.stringify(location.search.includes('empty') ? {} : state);
        if (cmd === 'set_keep_awake') {
          if (qa.failAwake || location.search.includes('awake-error')) throw new Error('Test power request failed');
          qa.keepAwake = args.enabled;
        }
        if (cmd === 'save_state') {
          if (qa.failSave) throw new Error('Test disk write failed');
          const write = () => { qa.saved = JSON.parse(args.json); localStorage.setItem('qa-state', args.json); };
          return location.search.includes('memory') ? new Promise(resolve => setTimeout(() => { write(); resolve(); }, 15)) : write();
        }
        if (cmd === 'has_session' && location.search.includes('hold-session') && !qa.sessionsReleased) return new Promise(resolve => qa.pendingSessions.push(resolve));
        if (cmd === 'pty_spawn') {
          if (qa.failSpawn) throw new Error('Test spawn failed');
          qa.panes.push(args);
          args.onOut.onmessage('\x1b]0;Review workspace navigation\x07\x1b[34m❯ loom\x1b[0m\r\n\r\nReady to work on this thread.\r\nChanges stay in its own worktree.\r\n\r\n\x1b[32m+ Ready\x1b[0m  \x1b[33m~ Pending\x1b[0m  \x1b[31m- Removed\x1b[0m\r\n\x1b[34mBlue\x1b[0m  \x1b[35mMagenta\x1b[0m  \x1b[36mCyan\x1b[0m\r\n');
          return location.search.includes('restore') ? new Promise(resolve => setTimeout(resolve, qa.panes.length * 30)) : undefined;
        }
        if (cmd === 'pty_kill' && qa.onKill) qa.onKill(args.id); // Lets a test change the worktree as its panes stop.
        if (cmd === 'pty_kill' && qa.holdKills) return new Promise(resolve => qa.pendingKills.push(resolve));
        if (cmd === 'pty_write' && (qa.holdWrites === true || qa.holdWrites === args.id)) return new Promise(resolve => qa.pendingWrites.push(resolve)); // true: every pane; an id: that one
        if (cmd === 'pty_write' && qa.failWrite) throw new Error('Test terminal write failed');
        // One write held in flight, reaching the pane when released; one that fails before
        // the pane gets it; one the pane gets but whose answer is lost.
        if (cmd === 'pty_write' && qa.gateWrite?.(args.data)) return new Promise(resolve => qa.gated.push(() => { qa.onWrite?.(args); resolve(); }));
        if (cmd === 'pty_write' && qa.failWriteIf?.(args.data)) throw new Error('Test: the terminal write failed');
        if (cmd === 'pty_write' && qa.loseReplyIf?.(args.data)) { qa.onWrite?.(args); throw new Error('Test: the terminal answered, and the answer was lost'); }
        if (cmd === 'dictate_stop') return qa.dictation ?? '';
        if (cmd === 'pty_write' && qa.onWrite) qa.onWrite(args); // Lets a test pane echo or redraw like a live agent.
        if (cmd === 'pty_kill' && qa.controlKill) return window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${args.id}`, payload: 1 });
        if (cmd === 'plugin:window|is_focused') return qa.focused ?? true;
        if (cmd === 'has_codex_session' && qa.holdCodex) return new Promise(resolve => qa.pendingCodex.push(resolve));
        if (cmd === 'has_codex_session') return args.sid !== 'missing-session';
        if (cmd === 'pane_booted') return true;
        if (cmd === 'codex_sessions') return [{ id: 'valid-session', title: 'Saved Codex conversation' }];
        if (cmd === 'take_sessions') {
          const mine = qa.sessions.filter(([id]) => args.ids.includes(id));
          qa.sessions = qa.sessions.filter(s => !mine.includes(s));
          return mine;
        }
        if (cmd === 'read_file') return 'export const answer = 42;\n// ' + args.path + '\n';
        if (cmd === 'read_image') {
          if (qa.failImage) throw new Error('Image file not found');
          if (qa.imageMatches && args.path === 'dashboard-message-sent-375.png') throw { matches: qa.imageMatches };
          const canvas = document.createElement('canvas');
          canvas.width = 1600; canvas.height = 1000;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#e8edf2'; ctx.fillRect(0, 0, 1600, 1000);
          ctx.fillStyle = '#162b40'; ctx.fillRect(80, 80, 1440, 840);
          ctx.fillStyle = '#b7dccf'; ctx.font = '60px sans-serif'; ctx.fillText('Image preview · 1600 × 1000', 160, 500);
          return Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0)).buffer;
        }
        if (cmd === 'opencode_sessions') {
          if (qa.failSessions) throw new Error('OpenCode could not list sessions');
          return [{ id: 'ses_first', title: 'Fix sidebar navigation' }, { id: 'ses_second', title: 'Review terminal layout' }];
        }
        if (cmd === 'last_messages') return Object.fromEntries(args.panes.map(([id, agent]) => [id, {
          user: `Review the ${agent} changes`, agent: `The ${agent} changes are ready`,
        }]));
        if (cmd === 'session_usage') return Object.fromEntries(args.panes.map(([id, , sid]) => [id, { ctx: 48000, window: 200000, input: 12000, output: 2400, cacheRead: 16000, cacheWrite: 800, turns: 6, mainTurns: 6, sid, model: 'sonnet', effort: 'high', liveModel: 'sonnet', liveEffort: 'high' }]));
        if (cmd === 'context_profile') return { buckets: [{ label: 'Read', tokens: 24000 }, { label: 'Prompts', tokens: 3000 }], series: [1000, 18000, 48000], drops: [], ctx: 48000, est: 27000 };
        if (cmd === 'plan_usage') {
          if (location.search.includes('usage-error')) throw new Error('Claude session expired');
          return { tier: 'default_claude_pro', stale: false, limits: [{ label: 'session', group: 'session', percent: 24, severity: 'ok', resetsAt: new Date(Date.now() + 3600000).toISOString() }] };
        }
        if (cmd === 'codex_plan_usage') {
          if (location.search.includes('usage-error')) throw new Error('No Codex credentials found');
          const stale = location.search.includes('usage-local');
          return { tier: 'prolite', stale, limits: [
            { label: 'Weekly', group: 'weekly', percent: location.search.includes('usage-weekly') ? 94 : 4, severity: location.search.includes('usage-weekly') ? 'critical' : 'ok', resetsAt: String(Math.floor(Date.now() / 1000) + 604800) },
            { label: '5h limit', group: 'session', percent: 42, severity: 'ok', resetsAt: String(Math.floor(Date.now() / 1000) + 18000) },
          ], ...(stale ? { note: 'Live refresh unavailable; showing local session usage.' } : { bankedResets: 3, bankedResetExpiries: ['2030-09-10T12:00:00Z', null] }) };
        }
        if (cmd === 'model_options') return [];
        if (cmd === 'plugin:dialog|open') return 'C:\\projects\\new-project';
        if (cmd === 'plugin:dialog|confirm') return false;
        if (cmd === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
        if (cmd === 'plugin:path|join') return args.paths.join('\\');
        if (cmd === 'git_midway') return '';
        if (cmd === 'git_run') {
          const a = args.args;
          if (a[0] === 'worktree' && a[1] === 'add' && qa.failCreate) throw new Error('Could not create worktree: branch is locked');
          if (a[0] === 'status' && qa.statusFor?.[args.dir] !== undefined) return qa.statusFor[args.dir]; // one worktree's own status
          if (a[0] === 'status') return (a.includes('--branch') ? '## main...origin/main [ahead 2]\0' : '') + (qa.clean ? '' : ' M src/main.ts\0M  src/styles.css\0?? notes.txt\0') + (a.includes('--ignored=matching') ? qa.ignored ?? '' : '');
          if (a[0] === 'worktree' && a[1] === 'remove' && qa.failRemove) throw new Error('Test: the worktree folder is in use');
          if (a[0] === 'branch' && a[1] === '-D' && qa.failBranch) throw new Error('Test: the branch is checked out elsewhere');
          if (a.includes('--numstat')) return '18\t4\tsrc/main.ts\n7\t2\tsrc/styles.css\n';
          if (a[0] === 'ls-files') return 'README.md\0preview.png\0src/main.ts\0src/styles.css\0src/ui/menu.ts\0';
          if ((a[0] === 'diff' || a[0] === 'show') && qa.longDiff) return 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1,601 @@\n context line one\n' + '+added line\n'.repeat(600);
          if (a[0] === 'diff' || a[0] === 'show') return (a.includes('-U999999') ? ' context line one\n context line two\n' : '') + 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old navigation\n+const description = "A long line of source code that should remain readable when reviewing changes inside a narrow workspace window.";\n';
          if (a[0] === 'log') return 'abc123 Improve workspace navigation\n';
          if (a[0] === 'branch') return 'main\nloom/search-polish\n';
          if (a[0] === 'stash' && a[1] === 'list') return 'stash@{0}\tOn main: workspace polish\n';
          if (a[0] === 'rev-list' && a.includes('--not')) return qa.unmerged ?? '0';
          if (a.includes('--show-toplevel')) return args.dir;
          if (a[0] === 'rev-parse') return location.search.includes('long-location') ? '' : 'main';
          return '';
        }
      }, { shouldMockEvents: true });
    };
    await context.addInitScript({ content: mocks + '\n(' + setup.toString() + ')(' + JSON.stringify(process.env.UI_THEME || 'loom') + ');' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser:', e.message); });
    await page.goto(base + (process.env.UI_CLOSE_ONLY ? '?resume&close-race' : ''));
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved).catch(async e => {
      console.error(await page.evaluate(() => ({ panes: document.querySelectorAll('.pane').length, calls: window.qa?.calls.map(c => c.cmd), text: document.body.innerText.slice(0, 1000) })));
      throw e;
    });
    await page.waitForTimeout(250);
    if (process.env.UI_CLOSE_ONLY) {
      const checkClose = async name => {
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        assert.ok(scrollWidth <= clientWidth, `${name}@${width}: horizontal overflow`);
        await page.screenshot({ path: `${out}/${name}-${width}.png` });
        checks++;
      };
      await page.evaluate(() => { window.qa.holdKills = true; });
      await page.locator('.grid:not(.hidden) .pane-head button[title="Close pane"]').first().click();
      await page.click('#confirm-action');
      await page.waitForFunction(() => document.querySelectorAll('.grid:not(.hidden) .pane').length === 1 && window.qa.saved?.threads[0].panes.length === 1, null, { timeout: 1500 });
      assert.equal(await page.locator('.grid:not(.hidden) .pane:visible').count(), 1, 'A slow Codex shutdown must leave its sibling visible');
      await checkClose('codex-pane-close-pending');
      await page.goto(base + '?resume&close-race');
      await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
      await page.evaluate(() => { window.qa.holdKills = true; });
      await page.click('#wsmore');
      await page.locator('#menu-list .menu-item').filter({ hasText: 'Close thread' }).click();
      await page.click('#confirm-action');
      await page.waitForFunction(() => document.querySelector('#wsname').textContent !== 'search-polish' && [...document.querySelectorAll('.grid:not(.hidden) .pane')].some(p => p.getBoundingClientRect().height > 0), null, { timeout: 1500 });
      await checkClose('codex-thread-close-pending');
      assert.deepEqual(errors, []);
      console.log(`PASS slow Codex close ${width}px`);
      await context.close();
      continue;
    }
    // The skill's scrollWidth invariant, plus visible control bounds to catch clipping.
    async function audit(name) {
      // Layout changes are fitted after xterm's next render. Inspect the painted
      // result, rather than the old canvas in the same turn as the UI action.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const offenders = [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea, dialog[open]')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.xterm') && (r.left < -1 || r.right > root.clientWidth + 1);
        }).map(el => `${el.tagName}#${el.id}.${el.className}`);
        const misplacedPaneActions = [...document.querySelectorAll('.pane-head')].filter(head => {
          const bounds = head.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return false;
          const close = head.querySelector('button[title="Close pane"]').getBoundingClientRect();
          const zoom = head.querySelector('button[title="Zoom (F2)"]').getBoundingClientRect();
          return Math.abs(bounds.right - close.right - 4) > 1 || Math.abs(close.left - zoom.right - 2) > 1;
        }).map(head => head.querySelector('.pane-title').textContent);
        const bar = document.querySelector('#bar').getBoundingClientRect();
        const clippedHeader = [...document.querySelectorAll('#bar > button')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.height && (r.top < bar.top || r.bottom > bar.bottom);
        }).map(el => el.id);
        const clippedTerminals = [...document.querySelectorAll('.pane-term .xterm-screen')].flatMap(screen => {
          const r = screen.getBoundingClientRect();
          if (!r.width || !r.height) return [];
          const host = screen.closest('.pane-term');
          const bounds = host.getBoundingClientRect();
          const style = getComputedStyle(host);
          const pane = host.closest('.pane');
          // A pane scrolled out of the stacked column pauses its renderer and refits
          // when it comes back into view (checked after thread-add-powershell).
          const column = pane.closest('.grid')?.getBoundingClientRect(), box = pane.getBoundingClientRect();
          if (column && (box.bottom <= column.top || box.top >= column.bottom)) return [];
          const bottom = pane.getBoundingClientRect().bottom - parseFloat(getComputedStyle(pane).borderBottomWidth) - 4;
          const right = bounds.right - parseFloat(style.paddingRight);
          return r.bottom > bottom + 0.5 || r.right > right + 0.5
            ? [{ pane: host.closest('.pane').dataset.id, bottom: r.bottom, limit: bottom, right: r.right, rightLimit: right }]
            : [];
        });
        return { width: root.clientWidth, scroll: root.scrollWidth, offenders, misplacedPaneActions, clippedHeader, clippedTerminals };
      });
      assert.equal(result.width, width);
      assert.ok(result.scroll <= width, `${name}@${width}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.offenders, [], `${name}@${width}: clipped controls`);
      assert.deepEqual(result.clippedHeader, [], `${name}@${width}: header controls must fit vertically`);
      assert.deepEqual(result.misplacedPaneActions, [], `${name}@${width}: fullscreen and close must stay together at the right edge`);
      assert.deepEqual(result.clippedTerminals, [], `${name}@${width}: terminal cells must stay clear of the pane's bottom edge`);
      await page.screenshot({ path: `${out}/${name}-${width}.png`, animations: 'disabled' });
      checks++;
    }
    const escape = () => page.keyboard.press('Escape');
    if (width === 1280) {
      // loomctl's stop against a pane still starting, and a restart that fails (LOOM_CLI_REVIEW F5, F7).
      await page.goto(base + '?hold-session&dashboard'); // dashboard: the Codex pane has a saved session
      await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'cli_ready') && window.qa.pendingSessions.length > 0);
      const call = (cmd, argv, stdin, key, timeout = 5) => page.evaluate(async ([cmd, argv, stdin, key, timeout]) => {
        const id = window.qa.cliIds = (window.qa.cliIds ?? 0) + 1;
        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'cli', payload: { id, cmd, argv, stdin, cwd: null, timeout, key } });
        for (const end = Date.now() + 15000; Date.now() < end;) {
          const reply = window.qa.calls.find(c => c.cmd === 'cli_reply' && c.args.id === id);
          if (reply) return reply.args.reply;
          await new Promise(r => setTimeout(r, 20));
        }
        return { hung: [cmd, ...argv].join(' ') };
      }, [cmd, argv, stdin ?? null, key ?? null, timeout]);
      const cli = (cmd, ...argv) => call(cmd, argv);
      const stopped = await cli('stop', 'search-polish:1', '--yes');
      assert.equal(stopped.ok, true, JSON.stringify(stopped));
      await page.evaluate(() => { window.qa.sessionsReleased = true; window.qa.pendingSessions.splice(0).forEach(r => r(true)); });
      await page.waitForTimeout(300);
      const spawns = id => page.evaluate(id => window.qa.calls.filter(c => c.cmd === 'pty_spawn' && c.args.id === id).length, id);
      assert.equal(await spawns(stopped.data.id), 0, 'A pane stopped while starting never starts');
      assert.equal((await cli('stop', 'search-polish:1', '--yes')).text, 'search-polish:1 has already exited.');
      await page.evaluate(() => { window.qa.failSpawn = true; });
      const failed = await cli('restart', 'search-polish:1');
      assert.equal(failed.ok, false, JSON.stringify(failed));
      assert.match(failed.error, /didn't start: .*Test spawn failed/);
      await page.evaluate(() => { window.qa.failSpawn = false; });
      const restarted = await cli('restart', 'search-polish:1');
      assert.equal(restarted.ok, true, JSON.stringify(restarted));
      assert.equal(await spawns(stopped.data.id), 2, 'The failed start, then the one that worked');
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS loomctl stop while starting, failed restart ${width}px`);

      // Driving agents with loomctl (LOOM_CLI_AGENT_REVIEW A2 to A6).
      const claude = stopped.data.id;
      const out = async (id, text) => {
        await page.evaluate(([id, text]) => window.qa.panes.filter(a => a.id === id).at(-1).onOut.onmessage(text), [id, text]);
        await page.waitForTimeout(150);
      };
      const writes = id => page.evaluate(id => window.qa.calls.filter(c => c.cmd === 'pty_write' && c.args.id === id).map(c => c.args.data), id);
      const enters = async () => (await writes(claude)).filter(d => d === '\r').length;
      const holdWrites = () => page.evaluate(() => { window.qa.holdWrites = true; });
      const releaseWrites = () => page.evaluate(() => { window.qa.holdWrites = false; window.qa.pendingWrites.splice(0).forEach(r => r()); });
      // A2: text queued for a session never reaches the one a restart brings up.
      await holdWrites();
      const typing = cli('send', 'search-polish:1', '--no-enter', 'first words');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      const queued = cli('send', 'search-polish:1', '--no-enter', 'old-session task');
      const again = await cli('restart', 'search-polish:1', '--yes');
      assert.equal(again.ok, true, JSON.stringify(again));
      await releaseWrites();
      assert.equal((await typing).ok, true, 'Typed into the old session before the restart');
      const stale = await queued;
      assert.equal(stale.ok, false, JSON.stringify(stale));
      assert.match(stale.error, /was restarted before Loom typed anything/);
      assert.equal(stale.typed, false);
      assert.ok(!(await writes(claude)).some(d => d.includes('old-session task')), 'Nothing queued for the old session was written');
      assert.equal((await cli('send', 'search-polish:1', '--no-enter', 'fresh task')).ok, true, 'The new session takes input');
      // A3: a stop during a dead Codex pane's restart, while it checks its saved session, cancels the restart.
      const codex = await cli('stop', 'search-polish:2', '--yes');
      assert.equal(codex.ok, true, JSON.stringify(codex));
      const codexSpawns = await spawns(codex.data.id);
      await page.evaluate(() => { window.qa.holdCodex = true; });
      const restarting = cli('restart', 'search-polish:2');
      await page.waitForFunction(() => window.qa.pendingCodex.length === 1);
      const stopping = cli('stop', 'search-polish:2', '--yes');
      await page.waitForTimeout(100);
      await page.evaluate(() => { window.qa.holdCodex = false; window.qa.pendingCodex.splice(0).forEach(r => r(true)); });
      const [restart3, stop3] = await Promise.all([restarting, stopping]);
      assert.equal(stop3.ok, true, JSON.stringify(stop3));
      assert.equal(stop3.text, 'search-polish:2 stopped', 'Not "already exited" while a start is pending');
      assert.equal(restart3.ok, false, JSON.stringify(restart3));
      assert.equal(await spawns(codex.data.id), codexSpawns, 'The cancelled restart never spawned');
      // A4: choose answers only the question it was asked about.
      const menuScreen = q => `\x1b[2J\x1b[H ${q}\r\n ❯ 1. Yes\r\n   2. No (esc)\r\n`;
      await out(claude, menuScreen('Read README.md?'));
      const readme = await cli('menu', 'search-polish:1');
      assert.match(readme.data.rev, /^[0-9a-f]{8}$/, JSON.stringify(readme));
      await holdWrites();
      const busy = cli('keys', 'search-polish:1', 'x');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      const choosing = cli('choose', 'search-polish:1', '1');
      await page.waitForTimeout(100);
      await out(claude, menuScreen('Delete the project?'));
      const entersBefore = await enters();
      await releaseWrites();
      assert.equal((await busy).ok, true);
      const swapped = await choosing;
      assert.equal(swapped.ok, false, JSON.stringify(swapped));
      assert.match(swapped.error, /question on claude's screen changed/);
      assert.equal(await enters(), entersBefore, 'No Enter for a question that changed under the same options');
      const staleRev = await cli('choose', 'search-polish:1', '1', '--menu', readme.data.rev);
      assert.equal(staleRev.ok, false, JSON.stringify(staleRev));
      assert.match(staleRev.error, /another question now/);
      const wipe = await cli('menu', 'search-polish:1');
      assert.notEqual(wipe.data.rev, readme.data.rev);
      assert.equal((await cli('choose', 'search-polish:1', '1', '--menu', wipe.data.rev)).ok, true);
      assert.equal(await enters(), entersBefore + 1);
      // A5: standard input is text, even when it starts with --.
      await out(claude, '\x1b[2J\x1b[H> ');
      await page.evaluate(id => { window.qa.onWrite = ({ id: to, data }) => { if (to === id && data !== '\r') window.qa.panes.filter(a => a.id === id).at(-1).onOut.onmessage(data.replace(/\x1b\[20[01]~/g, '').replace(/\n/g, '\r\n')); }; }, claude);
      const dashes = '--no-enter --json\nSELECT 1; -- the task';
      const piped = await call('send', ['search-polish:1', '-'], dashes + '\r\n');
      assert.equal(piped.ok, true, JSON.stringify(piped));
      assert.ok((await writes(claude)).includes(dashes), 'The pane got the text exactly, less the final line break');
      assert.equal(await enters(), entersBefore + 2, '--no-enter in the text did not stop Enter');
      // A6: a task taller than the screen submits once, collapsed or not; one that never shows says it was typed.
      const task = ['TASK-HEADER unique', ...Array.from({ length: 120 }, (_, i) => `step ${i} of the task`)].join('\n');
      await out(claude, '\x1b[2J\x1b[H> ');
      const tall = await cli('send', 'search-polish:1', task);
      assert.equal(tall.ok, true, JSON.stringify(tall));
      assert.equal(await enters(), entersBefore + 3, 'Its start scrolled away, and it was still submitted');
      await page.evaluate(id => { window.qa.onWrite = ({ id: to, data }) => { if (to === id && data !== '\r') window.qa.panes.filter(a => a.id === id).at(-1).onOut.onmessage('[Pasted text #1 +120 lines]'); }; }, claude);
      await out(claude, '\x1b[2J\x1b[H> ');
      assert.equal((await cli('send', 'search-polish:1', task)).ok, true, "Claude's collapsed paste counts as shown");
      assert.equal(await enters(), entersBefore + 4);
      await page.evaluate(() => { window.qa.onWrite = null; });
      const pastes = async () => (await writes(claude)).filter(d => d.includes('TASK-HEADER')).length;
      const pastesBefore = await pastes();
      const lost = await cli('send', 'search-polish:1', task);
      assert.equal(lost.ok, false, JSON.stringify(lost));
      assert.equal(lost.typed, true);
      assert.match(lost.error, /don't send it again/);
      assert.equal(await pastes(), pastesBefore + 1, 'Pasted once');
      assert.equal(await enters(), entersBefore + 4, 'and not submitted');
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS loomctl input bound to its session, stop cancels a pending restart, menu revisions, stdin text, long tasks ${width}px`);

      // Second agent review. R1: the menu id covers the whole prompt, so a
      // changed path under an option is another question.
      const folderScreen = path => `\x1b[2J\x1b[H Which folder should be removed?\r\n \u276f 1. Build output\r\n      ${path}\r\n   2. Cancel\r\n`;
      await out(claude, folderScreen('C:\\project\\build'));
      const build = await cli('menu', 'search-polish:1');
      assert.ok(build.data.prompt.includes('C:\\project\\build'), JSON.stringify(build.data));
      await holdWrites();
      const busy2 = cli('keys', 'search-polish:1', 'x');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      const queuedChoose = cli('choose', 'search-polish:1', '1');
      await page.waitForTimeout(100);
      await out(claude, folderScreen('C:\\project\\src'));
      const entersR1 = await enters();
      await releaseWrites();
      assert.equal((await busy2).ok, true);
      assert.equal((await queuedChoose).ok, false, 'A queued choose refuses the changed path');
      const staleFolder = await cli('choose', 'search-polish:1', '1', '--menu', build.data.rev);
      assert.equal(staleFolder.ok, false, JSON.stringify(staleFolder));
      assert.match(staleFolder.error, /another question now/);
      assert.equal(await enters(), entersR1, 'No Enter for either');
      // R3: keys cut short by a restart say which went in, never "nothing".
      const xs = async () => (await writes(claude)).filter(d => d === 'x').length;
      const xsBefore = await xs();
      await holdWrites();
      const partial = cli('keys', 'search-polish:1', 'enter', 'x');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      assert.equal((await cli('restart', 'search-polish:1', '--yes')).ok, true);
      await releaseWrites();
      const cut = await partial;
      assert.equal(cut.ok, false, JSON.stringify(cut));
      assert.equal(cut.pressed, 1);
      assert.match(cut.error, /was restarted after 1 of 2 keys \(enter\); the rest weren't pressed/);
      assert.equal(await xs(), xsBefore, 'x never went in');
      // --gen: input for a launch the caller saw, refused once the pane moved on.
      const seen = (await cli('panes')).data.find(p => p.id === claude);
      assert.ok(Number.isInteger(seen.generation) && seen.generation > 0, JSON.stringify(seen));
      const old = await cli('send', 'search-polish:1', '--no-enter', '--gen', String(seen.generation - 1), 'for-an-old-launch');
      assert.equal(old.ok, false, JSON.stringify(old));
      assert.match(old.error, /was restarted before Loom typed anything, so nothing was sent/);
      assert.ok(!(await writes(claude)).some(d => d.includes('for-an-old-launch')));
      assert.equal((await cli('keys', 'search-polish:1', '--gen', String(seen.generation), 'x')).ok, true);
      assert.equal(await xs(), xsBefore + 1);
      // A shell's exit code, from Loom's prompt marks (OSC 133 D).
      await out(claude, '\x1b]133;C\x07\x1b]133;D;7\x07');
      const after = (await cli('panes')).data.find(p => p.id === claude);
      assert.deepEqual([after.commands, after.failed, after.exit], [seen.commands + 1, true, 7]);
      assert.ok(Date.parse(after.lastOutput) > 0, JSON.stringify(after));
      // A failure whose code the prompt can't know is a failure with no code, not a guessed 1.
      await out(claude, '\x1b]133;C\x07\x1b]133;D;1;exact=0\x07');
      const unknown = (await cli('panes')).data.find(p => p.id === claude);
      assert.deepEqual([unknown.commands, unknown.failed, unknown.exit], [seen.commands + 2, true, null]);
      await out(claude, '\x1b]133;C\x07\x1b]133;D;0\x07');
      const fine = (await cli('panes')).data.find(p => p.id === claude);
      assert.deepEqual([fine.failed, fine.exit], [false, 0]);
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS loomctl whole-prompt menu ids, partial keys, --gen, shell exit codes ${width}px`);

      // --key: a retry gets the first answer instead of a second run.
      const paneCount = async () => (await cli('panes')).data.length;
      const before = await paneCount();
      const added = await call('add', ['search-polish', '--cmd='], null, 'job-1');
      const again2 = await call('add', ['search-polish', '--cmd='], null, 'job-1');
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.deepEqual([again2.replayed, again2.data.id], [true, added.data.id], 'The retry answers with the pane the first one made');
      assert.equal(await paneCount(), before + 1, 'One pane, not two');
      const other = await call('add', ['review-keyboard-navigation', '--cmd='], null, 'job-1');
      assert.equal(other.ok, false, JSON.stringify(other));
      assert.match(other.error, /used for a different command/);
      assert.equal(await paneCount(), before + 1);
      const together = await Promise.all([call('send', ['search-polish:1', '--no-enter', 'once'], null, 'job-2'), call('send', ['search-polish:1', '--no-enter', 'once'], null, 'job-2')]);
      assert.deepEqual(together.map(r => r.ok), [true, true]);
      assert.equal((await writes(claude)).filter(d => d === 'once').length, 1, 'Two at once with one key run once');
      // A key still running survives 256 newer keys: its retry waits for it rather than running again.
      await holdWrites();
      const heldKeyed = call('send', ['search-polish:1', '--no-enter', 'long task'], null, 'held-job');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      await page.evaluate(async () => {
        const ids = Array.from({ length: 256 }, (_, i) => 100000 + i);
        for (const id of ids) await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'cli', payload: { id, cmd: 'panes', argv: [], stdin: null, cwd: null, timeout: 5, key: `filler-${id}` } });
        const replied = () => new Set(window.qa.calls.filter(c => c.cmd === 'cli_reply').map(c => c.args.id));
        while (!ids.every(id => replied().has(id))) await new Promise(r => setTimeout(r, 20));
      });
      const retryKeyed = call('send', ['search-polish:1', '--no-enter', 'long task'], null, 'held-job');
      await page.waitForTimeout(100);
      await releaseWrites();
      const [firstKeyed, secondKeyed] = await Promise.all([heldKeyed, retryKeyed]);
      assert.deepEqual([firstKeyed.ok, secondKeyed.ok, secondKeyed.replayed], [true, true, true], JSON.stringify(secondKeyed));
      assert.equal((await writes(claude)).filter(d => d === 'long task').length, 1, 'Typed once');
      const afterFinish = await call('send', ['search-polish:1', '--no-enter', 'long task'], null, 'held-job');
      assert.deepEqual([afterFinish.ok, afterFinish.replayed], [true, true], `Started first but finished after 256 newer keys, it's the newest result and still replays: ${JSON.stringify(afterFinish)}`);
      assert.equal((await writes(claude)).filter(d => d === 'long task').length, 1, 'Still typed once');
      // 256 keys still running don't push out a finished one: its retry still replays.
      const other2 = (await cli('panes')).data.find(p => p.thread === 'review-keyboard-navigation');
      await page.evaluate(id => { window.qa.holdWrites = id; }, claude);
      await page.evaluate(() => {
        for (let i = 0; i < 256; i++) void window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'cli', payload: { id: 200000 + i, cmd: 'send', argv: ['search-polish:1', '--no-enter', `queued ${i}`], stdin: null, cwd: null, timeout: 30, key: `queued-${i}` } });
      });
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      assert.equal((await call('send', [other2.id, '--no-enter', 'mutate once'], null, 'recent-done')).ok, true);
      assert.equal((await call('panes', [], null, 'one-more-key')).ok, true);
      const recentRetry = await call('send', [other2.id, '--no-enter', 'mutate once'], null, 'recent-done');
      assert.deepEqual([recentRetry.ok, recentRetry.replayed], [true, true], JSON.stringify(recentRetry));
      assert.equal((await writes(other2.id)).filter(d => d === 'mutate once').length, 1, 'The finished key replayed rather than typing again');
      await releaseWrites();
      await page.waitForFunction(() => { const got = new Set(window.qa.calls.filter(c => c.cmd === 'cli_reply').map(c => c.args.id)); for (let i = 0; i < 256; i++) if (!got.has(200000 + i)) return false; return true; }, null, { timeout: 30000 });
      // turns: each time an agent finishes or asks after new input; repeats and idle reminders don't count.
      const turnsNow = async () => (await cli('panes')).data.find(p => p.id === claude).turns;
      await out(claude, '\x07'); // the turn after the input above
      const t0 = await turnsNow();
      await out(claude, '\x07');
      assert.equal(await turnsNow(), t0, 'No input since the last turn: not a turn');
      await cli('send', 'search-polish:1', '--no-enter', 'go');
      const waiting = cli('wait', 'search-polish:1', '--turn-after', String(t0));
      await out(claude, '\x07');
      await page.evaluate(id => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'wakes', payload: [[id, '']] }), claude);
      await page.waitForTimeout(100);
      assert.equal(await turnsNow(), t0 + 1, 'The bell and the Stop hook for one turn count once');
      const turned = await waiting;
      assert.equal(turned.ok, true, JSON.stringify(turned));
      assert.equal(turned.data.turns, t0 + 1);
      // Receipts. An agent's: the first turn after the Enter.
      await page.evaluate(id => { window.qa.onWrite = ({ id: to, data }) => { if (to === id && data !== '\r') window.qa.panes.filter(a => a.id === id).at(-1).onOut.onmessage(data); }; }, claude);
      await out(claude, '\x1b[2J\x1b[H> ');
      const agentReceipt = await cli('send', 'search-polish:1', '--receipt', 'write the tests');
      assert.match(agentReceipt.text, /^[0-9a-f]{16}$/, JSON.stringify(agentReceipt));
      assert.ok(!(await writes(claude)).some(d => d.includes('loom-receipt')), "An agent's prompt carries no marker");
      const agentDone = cli('wait', '--receipt', agentReceipt.text);
      await out(claude, menuScreen('Run the tests?') + '\x07');
      const agentResult = await agentDone;
      assert.deepEqual([agentResult.ok, agentResult.data.done, agentResult.data.asking], [true, true, true], JSON.stringify(agentResult));
      // A receipt's outcome comes from the launch it went to: one finished before
      // a restart keeps it, and one cut off by a restart never takes the next launch's turn.
      await out(claude, '\x1b[2J\x1b[H> ');
      const kept = await cli('send', 'search-polish:1', '--receipt', 'first task');
      await out(claude, '\x07');
      assert.equal((await cli('restart', 'search-polish:1', '--yes')).ok, true);
      const keptResult = await cli('wait', '--receipt', kept.text);
      assert.deepEqual([keptResult.ok, keptResult.data.done, keptResult.data.asking], [true, true, null], JSON.stringify(keptResult));
      const cutShort = await cli('send', 'search-polish:1', '--receipt', 'second task'); // turns is 0 after the restart
      assert.equal(cutShort.ok, true, JSON.stringify(cutShort));
      assert.equal((await cli('restart', 'search-polish:1', '--yes')).ok, true);
      await cli('send', 'search-polish:1', '--no-enter', 'the new launch working');
      await out(claude, '\x07');
      assert.equal(await turnsNow(), 1, 'The new launch finished a turn');
      const cutResult = await cli('wait', '--receipt', cutShort.text);
      assert.equal(cutResult.ok, false, JSON.stringify(cutResult));
      assert.match(cutResult.error, /restarted before it finished/);
      // A turn's second signal, from the other path, can land after the next task
      // went in: it must not finish that task. Bell first then a late hook, and
      // (on a fresh launch) hook first then a late bell.
      const hook = async () => {
        await page.evaluate(id => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'wakes', payload: [[id, '']] }), claude);
        await page.waitForTimeout(150);
      };
      for (const [first, late] of [[() => out(claude, '\x07'), hook], [hook, () => out(claude, '\x07')]]) {
        assert.equal((await cli('restart', 'search-polish:1', '--yes')).ok, true); // a launch whose first turn picks its signal
        await out(claude, '\x1b[2J\x1b[H> ');
        const taskA = await cli('send', 'search-polish:1', '--receipt', 'task A');
        await first();
        assert.equal((await cli('wait', '--receipt', taskA.text)).ok, true, 'A finished');
        const taskB = await cli('send', 'search-polish:1', '--receipt', 'task B');
        await late(); // A's second signal
        const early = await call('wait', ['--receipt', taskB.text], null, null, 1);
        assert.deepEqual([early.ok, early.timeout], [false, true], `A's late signal didn't finish B: ${JSON.stringify(early)}`);
        await first(); // B's own turn
        const bDone = await cli('wait', '--receipt', taskB.text);
        assert.deepEqual([bDone.ok, bDone.data?.turn], [true, 2], JSON.stringify(bDone));
      }
      // A shell's: its own command line's exit code, paired by the marker at the end of the line.
      // The mock shells answer each Enter with E, C, D and a fresh prompt, after `delay` ms.
      const shellPane = added.data.id;
      const twin = (await call('add', ['search-polish', '--cmd='])).data.id;
      await page.evaluate(ids => {
        const prompt = '\x1b]133;A\x07PS> \x1b]133;B\x07';
        const qa = window.qa;
        qa.shell = { delay: 0, hang: false, events: [], lines: {} };
        const pane = id => qa.panes.filter(a => a.id === id).at(-1).onOut;
        qa.onWrite = ({ id, data }) => {
          if (!ids.includes(id)) return;
          qa.shell.events.push(`write:${data}`);
          if (data !== '\r') { qa.shell.lines[id] = (qa.shell.lines[id] ?? '') + data; pane(id).onmessage(data); return; }
          const line = qa.shell.lines[id] ?? '';
          qa.shell.lines[id] = '';
          if (qa.shell.hang) return;
          const code = /exit (\d+)/.exec(line)?.[1] ?? '0';
          setTimeout(() => { qa.shell.events.push(`done:${code}`); pane(id).onmessage(`\x1b]133;E;${line}\x07\x1b]133;C\x07\r\n\x1b]133;D;${code}\x07${prompt}`); }, qa.shell.delay);
        };
        for (const id of ids) pane(id).onmessage(prompt);
      }, [shellPane, twin]);
      await page.waitForTimeout(150);
      const refOf = async id => (await cli('panes')).data.find(p => p.id === id).ref;
      const shellRef = await refOf(shellPane), twinRef = await refOf(twin);
      const shellReceipt = await cli('send', shellRef, '--receipt', 'cmd /c exit 5');
      assert.equal(shellReceipt.ok, true, JSON.stringify(shellReceipt));
      assert.ok((await writes(shellPane)).some(d => d === `cmd /c exit 5  # loom-receipt:${shellReceipt.text}`), 'The marker rides on the line as a comment');
      const plain = await cli('send', shellRef, 'cmd /c exit 9'); // someone else's command, after ours
      assert.equal(plain.ok, true);
      const shellResult = await cli('wait', '--receipt', shellReceipt.text);
      assert.deepEqual([shellResult.data.failed, shellResult.data.exit], [true, 5], 'The receipt has its own command\'s code, not the later 9');
      // An Enter queued ahead spends the prompt: a receipt behind it waits for the next prompt, even when the marks are slow.
      await page.evaluate(() => { window.qa.shell.delay = 300; window.qa.shell.events = []; });
      const aheadSend = cli('send', shellRef, 'cmd /c exit 9');
      await page.waitForFunction(() => window.qa.shell.events.includes('write:cmd /c exit 9')); // typed, Enter still to come
      const behind = await cli('send', shellRef, '--receipt', 'cmd /c exit 3');
      const ahead = await aheadSend;
      assert.deepEqual([ahead.ok, behind.ok], [true, true], JSON.stringify(behind));
      const events = await page.evaluate(() => window.qa.shell.events);
      assert.ok(events.indexOf('done:9') >= 0 && events.indexOf('done:9') < events.findIndex(e => e.startsWith('write:cmd /c exit 3')), `Typed only after the command ahead finished: ${JSON.stringify(events)}`);
      const behindResult = await cli('wait', '--receipt', behind.text);
      assert.deepEqual([behindResult.data.failed, behindResult.data.exit], [true, 3], JSON.stringify(behindResult));
      await page.evaluate(() => { window.qa.shell.delay = 0; });
      // A receipt queued behind a send that starts a program never types into the program.
      await holdWrites();
      const starter = cli('send', shellRef, 'interactive-app');
      await page.waitForFunction(() => window.qa.pendingWrites.length === 1);
      const intoApp = cli('send', shellRef, '--receipt', 'cmd /c exit 4');
      await page.waitForTimeout(100);
      await out(shellPane, '\x1b]133;C\x07'); // the program starts, and has the pane now
      await releaseWrites();
      await starter;
      const refused = await intoApp;
      assert.deepEqual([refused.ok, refused.typed], [false, false], JSON.stringify(refused));
      assert.match(refused.error, /isn't at Loom's PowerShell prompt/);
      assert.ok(!(await writes(shellPane)).some(d => d.includes('cmd /c exit 4')), 'Nothing typed into the program');
      await out(shellPane, '\x1b]133;D;0\x07\x1b]133;A\x07PS> \x1b]133;B\x07');
      // Marker-like text in a command is just text: the appended comment decides.
      const literal = await cli('send', shellRef, '--receipt', 'Write-Output "loom-receipt:abcdefabcdefabcd"');
      const literalResult = await call('wait', ['--receipt', literal.text], null, null, 3);
      assert.deepEqual([literalResult.ok, literalResult.data?.failed], [true, false], JSON.stringify(literalResult));
      // Another pane can't finish a receipt, even with its token on the line.
      await page.evaluate(() => { window.qa.shell.hang = true; });
      const pending = await cli('send', shellRef, '--receipt', 'cmd /c exit 6');
      await page.evaluate(() => { window.qa.shell.hang = false; });
      assert.equal((await cli('send', twinRef, `cmd /c exit 9  # loom-receipt:${pending.text}`)).ok, true);
      const notYet = await call('wait', ['--receipt', pending.text], null, null, 1);
      assert.deepEqual([notYet.ok, notYet.timeout], [false, true], `The other pane's exit 9 isn't this receipt's: ${JSON.stringify(notYet)}`);
      await out(shellPane, `\x1b]133;E;cmd /c exit 6  # loom-receipt:${pending.text}\x07\x1b]133;C\x07\x1b]133;D;6\x07\x1b]133;A\x07PS> \x1b]133;B\x07`);
      const own = await cli('wait', '--receipt', pending.text);
      assert.deepEqual([own.data.pane, own.data.exit], [shellPane, 6], JSON.stringify(own));
      assert.equal((await cli('wait', '--receipt', 'nosuchtoken')).ok, false);
      await page.evaluate(() => { window.qa.onWrite = null; });
      for (const id of [shellPane, twin]) assert.equal((await cli('close', id, '--yes')).ok, true); // by id: refs renumber as panes close
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS loomctl --key retries, agent turns, receipts for agents and shells ${width}px`);

      // Operator experience review (2026-10-01). Input: a draft and a suggestion
      // with the same words read apart, and guarded sends check the input in the
      // pane's turn. A fresh launch, so its first turn picks the bell.
      assert.equal((await cli('restart', 'search-polish:1', '--yes')).ok, true);
      assert.equal((await cli('show', 'search-polish:1')).ok, true);
      const composer = () => page.evaluate(([id, rule]) => {
        const qa = window.qa;
        // Claude 2.1's input: typed text plain; its suggestion dim, the caret inverse on its first letter.
        // qa.prompt: the glyph and separator before it, "> " or this PC's "❯" and a no-break space.
        qa.draw = body => qa.panes.filter(a => a.id === id).at(-1).onOut.onmessage(`\x1b[2J\x1b[H● Done.\r\n${rule}\r\n${qa.prompt ?? '> '}${body}\x1b[0m\r\n${rule}\r\n  ? for shortcuts`);
        qa.ghost = text => `\x1b[7m${text[0]}\x1b[0m\x1b[2m${text.slice(1)}`;
        qa.input = ''; qa.submitted = []; qa.keep = ''; qa.collapse = false;
        // Typing replaces the suggestion (qa.keep: a provider that leaves it in front), a
        // multi-line paste collapses (qa.collapse), and Enter submits what's there.
        qa.onWrite = ({ id: to, data }) => {
          if (to !== id || qa.slowEcho) return; // slowEcho: the agent hasn't drawn it yet
          if (data === '\r') { qa.submitted.push(qa.input); qa.input = ''; return qa.draw('\x1b[7m \x1b[0m'); }
          const typed = data.replace(/\x1b\[20[01]~/g, '');
          qa.input += qa.collapse && typed.includes('\n') ? '[Pasted text #1 +3 lines]' : typed;
          qa.draw(qa.keep + qa.input + '\x1b[7m \x1b[0m');
        };
      }, [claude, '─'.repeat(40)]);
      await composer();
      const ask = 'fix the sign-up form fields too';
      const drawn = async body => { await page.evaluate(body => window.qa.draw(body), body); await page.waitForTimeout(150); };
      const showGhost = () => page.evaluate(() => { window.qa.input = ''; }).then(() => page.evaluate(ask => window.qa.ghost(ask), ask)).then(drawn);
      const showDraft = () => page.evaluate(ask => { window.qa.input = ask; }, ask).then(() => drawn(`${ask}\x1b[7m \x1b[0m`));
      const readNow = async (...more) => (await cli('read', 'search-polish:1', ...more)).data;
      const submittedLast = () => page.evaluate(() => window.qa.submitted.at(-1));
      const typedCount = async text => (await writes(claude)).filter(d => d.includes(text)).length;
      {
        await showGhost();
        const ghost = await readNow('--styles');
        await showDraft();
        const draft = await readNow();
        assert.equal(ghost.text, draft.text, 'As plain text the two screens are the same');
        assert.deepEqual([ghost.input.kind, ghost.input.text, draft.input.kind, draft.input.text], ['suggestion', ask, 'draft', ask], JSON.stringify([ghost.input, draft.input]));
        const row = ghost.rows.find(r => r.runs.map(run => run.text).join('').startsWith('> '));
        assert.deepEqual(row.runs.slice(1).map(run => [run.text, !!run.inverse, !!run.dim]), [['f', true, false], [ask.slice(1), false, true]], JSON.stringify(row));
        assert.ok(Number.isInteger(ghost.cursor.x) && Number.isInteger(ghost.cursor.y), JSON.stringify(ghost.cursor));
        await out(claude, '\x1b[?25l');
        assert.equal((await readNow()).cursor.hidden, true, 'The app hid the cursor');
        await out(claude, '\x1b[?25h');
        assert.equal((await readNow()).cursor.hidden, false);
        assert.equal((await cli('read', 'search-polish:1', '--styles', '--lines', '5')).ok, false, '--styles is for the screen');
        const codex = (await cli('panes')).data.find(p => p.agent === 'codex');
        assert.equal((await cli('read', codex.id)).data.input.kind, 'unknown', "Codex's input was never checked: unknown, not a guess");
      }
      {
        // A real draft survives a replace nobody approved: nothing typed, the draft still there.
        await showDraft();
        const before = (await writes(claude)).length;
        const refused = await cli('send', 'search-polish:1', '--replace', 'write the tests');
        assert.deepEqual([refused.ok, refused.typed], [false, false], JSON.stringify(refused));
        assert.match(refused.error, /holds a draft someone typed/);
        assert.equal((await writes(claude)).length, before, 'Nothing typed over the draft');
        assert.equal((await readNow()).input.text, ask, 'The draft is untouched');
        // An approved replace over a suggestion submits only the new text.
        await showGhost();
        const entersBefore = await enters();
        const replaced = await cli('send', 'search-polish:1', '--replace', 'write the tests');
        assert.equal(replaced.ok, true, JSON.stringify(replaced));
        assert.deepEqual([await enters(), await submittedLast()], [entersBefore + 1, 'write the tests'], 'No old text appended');
        // A provider that keeps the suggestion and types after it: Enter is held back.
        await showGhost();
        await page.evaluate(ask => { window.qa.keep = `\x1b[2m${ask}\x1b[0m`; }, ask);
        const held = await cli('send', 'search-polish:1', '--replace', 'write the tests');
        assert.deepEqual([held.ok, held.typed], [false, true], JSON.stringify(held));
        assert.match(held.error, /couldn't see the suggestion gone/);
        assert.equal(await enters(), entersBefore + 1, 'No Enter after the old text');
        await page.evaluate(() => { window.qa.keep = ''; });
      }
      {
        // One call: --input with the revision just read goes through.
        await showGhost();
        const fresh = (await readNow()).input.rev;
        const sent = await cli('send', 'search-polish:1', '--input', fresh, 'write the tests');
        assert.equal(sent.ok, true, JSON.stringify(sent));
        // Another loomctl writer between the read and the send: nothing typed.
        await showGhost();
        const seen = (await readNow()).input.rev;
        assert.equal((await cli('keys', 'search-polish:1', 'x')).ok, true);
        const typedBefore = await typedCount('stale task');
        const stale = await cli('send', 'search-polish:1', '--input', seen, 'stale task');
        assert.deepEqual([stale.ok, stale.typed], [false, false], JSON.stringify(stale));
        assert.match(stale.error, /input changed since revision/);
        assert.equal(await typedCount('stale task'), typedBefore);
        // Someone typing in the window counts the same, even before the agent draws it.
        await showGhost();
        const seen2 = (await readNow()).input.rev;
        await page.evaluate(() => { window.qa.slowEcho = true; });
        await page.locator(`.pane[data-id="${claude}"] .xterm-helper-textarea`).focus();
        await page.keyboard.type('h');
        await page.waitForFunction(id => window.qa.calls.some(c => c.cmd === 'pty_write' && c.args.id === id && c.args.data === 'h'), claude);
        assert.equal((await readNow()).input.kind, 'suggestion', 'The screen still shows only the suggestion');
        const human = await cli('send', 'search-polish:1', '--input', seen2, 'stale task');
        await page.evaluate(() => { window.qa.slowEcho = false; });
        assert.deepEqual([human.ok, human.typed], [false, false], JSON.stringify(human));
        assert.equal(await typedCount('stale task'), typedBefore);
        // The preview workflow: a first letter, a look, then the rest, each against what was read.
        await showGhost();
        assert.equal((await cli('send', 'search-polish:1', '--no-enter', '--input', (await readNow()).input.rev, 'W')).ok, true);
        await page.waitForTimeout(150);
        const preview = (await readNow()).input;
        assert.deepEqual([preview.kind, preview.text], ['draft', 'W'], 'The letter dismissed the suggestion');
        const rest = await cli('send', 'search-polish:1', '--input', preview.rev, 'rite the tests');
        assert.equal(rest.ok, true, JSON.stringify(rest));
        assert.equal(await submittedLast(), 'Write the tests');
        // ... and a writer between its two calls stops the rest.
        await showGhost();
        assert.equal((await cli('send', 'search-polish:1', '--no-enter', '--input', (await readNow()).input.rev, 'W')).ok, true);
        await page.waitForTimeout(150);
        const preview2 = (await readNow()).input;
        await cli('keys', 'search-polish:1', 'x');
        const restBefore = await typedCount('rest of it');
        const raced = await cli('send', 'search-polish:1', '--input', preview2.rev, 'rest of it');
        assert.deepEqual([raced.ok, raced.typed], [false, false], JSON.stringify(raced));
        assert.equal(await typedCount('rest of it'), restBefore);
      }
      let auditToken;
      {
        // Receipts keep the digest of exactly what was typed, not the text, after the screen moved on.
        await showGhost();
        await page.evaluate(() => { window.qa.collapse = true; });
        const exact = 'Fix the form.\n\n\t- keep tabs\n- é and 🙂';
        const digest = '92bc5efe82e8124ca71fb15b541e581e2c5f2dd483bd93407c2d917552612c6b'; // node:crypto
        const sent = await call('send', ['search-polish:1', '-', '--receipt'], exact + '\r\n', 'audit-task-1');
        assert.deepEqual([sent.ok, sent.data?.sha256, sent.data?.bytes], [true, digest, 41], JSON.stringify(sent));
        auditToken = sent.data.receipt;
        await out(claude, '\x1b[2J\x1b[H● Working on something else entirely\r\n');
        const record = (await cli('receipt', auditToken)).data;
        assert.deepEqual([record.wrote.sha256, record.wrote.bytes, record.wrote.stage, record.key, record.pane, record.generation, record.acknowledged, record.outcome],
          [digest, 41, 'submitted', 'audit-task-1', claude, sent.data.generation, null, 'pending'], JSON.stringify(record));
        const at = ['acceptedAt', 'typedAt', 'submittedAt'].map(k => Date.parse(record.wrote[k]));
        assert.ok(at.every(t => t > 0) && at[0] <= at[1] && at[1] <= at[2], JSON.stringify(record.wrote));
        assert.ok(!JSON.stringify(record).includes('keep tabs'), 'The record holds no text');
        // The same key again answers with the first record, typing nothing.
        const typedBefore = await typedCount('keep tabs');
        const retried = await call('send', ['search-polish:1', '-', '--receipt'], exact + '\r\n', 'audit-task-1');
        assert.deepEqual([retried.replayed, retried.data.receipt, retried.data.sha256], [true, auditToken, digest], JSON.stringify(retried));
        assert.equal(await typedCount('keep tabs'), typedBefore, 'The retry typed nothing');
        // The agent's turn ends: acknowledged, and nothing claims the job succeeded.
        await out(claude, '\x07');
        const acked = (await cli('receipt', auditToken)).data;
        assert.equal(acked.outcome, 'acknowledged', JSON.stringify(acked));
        assert.deepEqual(Object.keys(acked.acknowledged).sort(), ['at', 'turn'], JSON.stringify(acked.acknowledged));
        const waited = (await cli('wait', '--receipt', auditToken)).data;
        assert.ok(waited.done && !('failed' in waited) && !('success' in waited), JSON.stringify(waited));
        // Typed, but Enter held back: on record as typed, and wait says so at once.
        await page.evaluate(() => { window.qa.onWrite = null; window.qa.collapse = false; });
        const unsent = await cli('send', 'search-polish:1', '--receipt', 'this never shows on screen');
        assert.deepEqual([unsent.ok, unsent.typed, typeof unsent.receipt], [false, true, 'string'], JSON.stringify(unsent));
        const unsentRecord = (await cli('receipt', unsent.receipt)).data;
        assert.deepEqual([unsentRecord.wrote.stage, unsentRecord.wrote.submittedAt, unsentRecord.outcome], ['typed', null, 'none'], JSON.stringify(unsentRecord));
        const unsentWait = await call('wait', ['--receipt', unsent.receipt], null, null, 3);
        assert.deepEqual([unsentWait.ok, unsentWait.timeout], [false, false], JSON.stringify(unsentWait));
        assert.match(unsentWait.error, /didn't press Enter/);
        const never = await cli('receipt', '0123456789abcdef');
        assert.deepEqual([never.ok, never.unavailable], [false, true], JSON.stringify(never));
      }
      {
        // Deleting a worktree: ignored files count as loss, a plan pins what was
        // seen, and a cleanup that stops part-way says which steps finished.
        const worktree = async name => {
          const made = await cli('new', 'C:\\projects\\loom', '--name', name, '--cmd=');
          assert.equal(made.ok, true, JSON.stringify(made));
          await page.evaluate(dir => { window.qa.statusFor = { ...window.qa.statusFor, [dir]: '' }; }, made.data.dir);
          return made.data;
        };
        const statusOf = (dir, z) => page.evaluate(([dir, z]) => { window.qa.statusFor[dir] = z; }, [dir, z]);
        const open = async id => (await cli('threads')).data.some(t => t.id === id);
        const killed = ids => page.evaluate(ids => window.qa.calls.some(c => c.cmd === 'pty_kill' && ids.includes(c.args.id)), ids);
        const gitCalls = (verb, dir) => page.evaluate(([verb, dir]) => window.qa.calls.filter(c => c.cmd === 'git_run' && c.args.args.slice(0, 2).join(' ') === verb && (!dir || c.args.args.includes(dir))).length, [verb, dir]);
        const a = await worktree('cleanup-a');
        const paneIds = a.panes.map(p => p.id);
        await statusOf(a.dir, '!! .env\0!! node_modules/\0');
        const plan = await cli('close-plan', a.id, '--delete', 'branch');
        assert.equal(plan.ok, true, JSON.stringify(plan));
        assert.deepEqual([plan.data.thread, plan.data.dir, plan.data.branch, plan.data.panes.map(p => p.id), plan.data.lost, plan.data.ignored, plan.data.discard],
          [a.id, a.dir, a.branch, paneIds, { tracked: 0, untracked: 0, ignored: 2, commits: 0 }, ['.env', 'node_modules/'], ['ignored']], JSON.stringify(plan.data));
        assert.match(plan.data.rev, /^[0-9a-f]{16}$/);
        assert.match(plan.text, /--discard ignored/);
        assert.ok(await open(a.id) && !(await killed(paneIds)), 'A plan changes nothing');
        // A clean tree with only ignored files no longer deletes without a word.
        const unauthorized = await cli('close-thread', a.id, '--yes', '--delete', 'branch');
        assert.equal(unauthorized.ok, false, JSON.stringify(unauthorized));
        assert.match(unauthorized.error, /2 ignored files or folders will be deleted: \.env, node_modules\//);
        assert.deepEqual(unauthorized.discard, ['ignored']);
        assert.ok(await open(a.id) && !(await killed(paneIds)), 'Refused before closing anything');
        // A worktree or a thread that changed after the plan fails before cleanup.
        await statusOf(a.dir, '!! .env\0!! node_modules/\0?? notes/new.md\0');
        const changed = await cli('close-thread', a.id, '--yes', '--delete', 'branch', '--plan', plan.data.rev, '--discard', 'ignored');
        assert.equal(changed.ok, false, JSON.stringify(changed));
        assert.match(changed.error, /changed since plan/);
        await statusOf(a.dir, '!! .env\0!! node_modules/\0');
        const extra = await cli('add', a.id, '--cmd=');
        const morePanes = await cli('close-thread', a.id, '--yes', '--delete', 'branch', '--plan', plan.data.rev, '--discard', 'ignored');
        assert.equal(morePanes.ok, false, JSON.stringify(morePanes));
        assert.match(morePanes.error, /changed since plan/);
        assert.ok(await open(a.id) && !(await killed([...paneIds, extra.data.id])), 'Still open, every pane still running');
        assert.equal(await gitCalls('worktree remove') + await gitCalls('branch -D'), 0);
        // With the plan as it now is and the ignored files allowed, it goes, step by step.
        const plan2 = (await cli('close-plan', a.id, '--delete', 'branch')).data;
        const done = await cli('close-thread', a.id, '--yes', '--delete', 'branch', '--plan', plan2.rev, '--discard', 'ignored');
        assert.equal(done.ok, true, JSON.stringify(done));
        assert.deepEqual(done.data.steps, { panes: 'closed', worktree: 'removed', branch: 'deleted' });
        assert.ok(!(await open(a.id)));
        // The folder won't go: the panes are closed, the folder failed, the branch is kept.
        const b = await worktree('cleanup-b');
        await page.evaluate(() => { window.qa.failRemove = true; });
        const stuck = await cli('close-thread', b.id, '--yes', '--delete', 'branch');
        assert.equal(stuck.ok, false, JSON.stringify(stuck));
        assert.deepEqual([stuck.closed, stuck.steps], [b.id, { panes: 'closed', worktree: 'failed', branch: 'kept' }], JSON.stringify(stuck));
        assert.match(stuck.error, /stopped its panes, but couldn't remove its worktree folder, which may be partly deleted, so its branch was kept/);
        assert.equal(await gitCalls('branch -D', b.branch), 0, 'No branch deleted after the folder failed');
        // The folder goes and the branch won't: said apart. --force still deletes without looking.
        const c = await worktree('cleanup-c');
        await page.evaluate(() => { window.qa.failRemove = false; window.qa.failBranch = true; });
        const branchStuck = await cli('close-thread', c.id, '--yes', '--delete', 'branch', '--force');
        assert.deepEqual([branchStuck.ok, branchStuck.steps], [false, { panes: 'closed', worktree: 'removed', branch: 'failed' }], JSON.stringify(branchStuck));
        // Something writes as the panes stop: the folder is kept, and the answer says why.
        const d = await worktree('cleanup-d');
        await page.evaluate(([dir, ids]) => { window.qa.failBranch = false; window.qa.onKill = id => { if (ids.includes(id)) window.qa.statusFor[dir] = '?? crash.log\0'; }; }, [d.dir, d.panes.map(p => p.id)]);
        const racing = await cli('close-thread', d.id, '--yes', '--delete', 'worktree');
        assert.deepEqual([racing.ok, racing.steps], [false, { panes: 'closed', worktree: 'kept', branch: null }], JSON.stringify(racing));
        assert.match(racing.error, /kept its worktree folder: its untracked files changed while its panes closed/);
        assert.equal(await gitCalls('worktree remove', d.dir), 0);
        await page.evaluate(() => { window.qa.onKill = null; delete window.qa.statusFor; });
      }
      // Pane 7 review (2026-10-01).
      assert.equal((await cli('show', 'search-polish:1')).ok, true);
      await composer();
      const showEmpty = () => page.evaluate(() => { window.qa.input = ''; }).then(() => drawn('\x1b[7m \x1b[0m'));
      const held = () => page.evaluate(() => window.qa.input);
      {
        // This PC's Claude draws "❯" and a no-break space: read, replaced and checked after the paste.
        await page.evaluate(() => { window.qa.prompt = '❯\u00a0'; });
        await showGhost();
        const ghost = (await readNow()).input;
        await showDraft();
        const draft = (await readNow()).input;
        assert.deepEqual([ghost.kind, ghost.text, draft.kind, draft.text], ['suggestion', ask, 'draft', ask], JSON.stringify([ghost, draft]));
        await drawn(`\x1b[2m${ask}`);
        assert.equal((await readNow()).input.kind, 'suggestion', 'Unfocused, all dim');
        await showGhost();
        const entersBefore = await enters();
        const replaced = await cli('send', 'search-polish:1', '--replace', 'write the tests');
        assert.equal(replaced.ok, true, JSON.stringify(replaced));
        assert.deepEqual([await enters(), await submittedLast()], [entersBefore + 1, 'write the tests']);
        // The collapsed paste pane 7 showed reads as a draft after the paste, so Enter goes.
        await page.evaluate(() => { window.qa.collapse = true; });
        await showGhost();
        const collapsed = await cli('send', 'search-polish:1', '--replace', 'first line\nsecond line\nthird line');
        assert.equal(collapsed.ok, true, JSON.stringify(collapsed));
        assert.equal(await submittedLast(), '[Pasted text #1 +3 lines]');
        await page.evaluate(() => { window.qa.collapse = false; });
      }
      {
        // Nothing joins a send between its paste and its Enter. Loom's paste is held
        // in flight (gateWrite) while another writer that doesn't queue behind it writes.
        const inFlight = async (text, args) => {
          await page.evaluate(text => { window.qa.gated = []; window.qa.gateWrite = d => d.includes(text); }, text);
          const sending = cli('send', 'search-polish:1', ...args, text);
          await page.waitForFunction(() => window.qa.gated.length === 1);
          return [sending];
        };
        const release = () => page.evaluate(() => { window.qa.gateWrite = null; window.qa.gated.splice(0).forEach(go => go()); });
        const writesOf = text => page.evaluate(([id, text]) => window.qa.calls.some(c => c.cmd === 'pty_write' && c.args.id === id && c.args.data.includes(text)), [claude, text]);
        // Typing in the window during the paste, into an empty input, guarded and with a receipt.
        await showEmpty();
        let entersBefore = await enters();
        const [typing] = await inFlight('approved text', ['--input', (await readNow()).input.rev, '--receipt']);
        await page.locator(`.pane[data-id="${claude}"] .xterm-helper-textarea`).focus();
        await page.keyboard.type(' AND A HUMAN EDIT');
        await release();
        const typed = await typing;
        assert.deepEqual([typed.ok, typed.typed], [false, true], JSON.stringify(typed));
        assert.match(typed.error, /Something else was typed into claude while Loom was pasting, so it didn't press Enter/);
        assert.equal(await enters(), entersBefore, 'No Enter');
        assert.ok((await held()).includes('approved text') && (await held()).includes('AND A HUMAN EDIT'), `The joined draft stays for a person: ${await held()}`);
        const typedRecord = (await cli('receipt', typed.receipt)).data;
        assert.deepEqual([typedRecord.wrote.stage, typedRecord.wrote.uncertain, typedRecord.outcome], ['typed', null, 'none'], JSON.stringify(typedRecord));
        // Dictation during the paste, over a suggestion with --replace.
        await page.evaluate(() => { document.activeElement?.blur(); window.qa.dictation = 'and some dictated words'; });
        await showGhost();
        entersBefore = await enters();
        const [dictating] = await inFlight('second approved text', ['--replace']);
        await page.keyboard.down('F4');
        await page.waitForTimeout(150);
        await page.keyboard.up('F4');
        await page.waitForFunction(id => window.qa.calls.some(c => c.cmd === 'pty_write' && c.args.id === id && c.args.data.includes('dictated words')), claude);
        await release();
        const dictated = await dictating;
        assert.deepEqual([dictated.ok, dictated.typed], [false, true], JSON.stringify(dictated));
        assert.equal(await enters(), entersBefore, 'No Enter after dictation joined');
        assert.ok((await held()).includes('second approved text') && (await held()).includes('dictated words'), await held());
        // A file dropped after the paste landed, while Loom waits to see it: no Enter either.
        await showGhost();
        entersBefore = await enters();
        const [dropping] = await inFlight('third approved text', ['--input', (await readNow()).input.rev]);
        const box = await page.locator(`.pane[data-id="${claude}"]`).boundingBox();
        await page.evaluate(({ x, y }) => {
          window.qa.gateWrite = null;
          window.qa.gated.splice(0).forEach(go => go());
          setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths: ['C:\\notes\\dropped.txt'], position: { x, y } } }), 30);
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const dropped = await dropping;
        assert.deepEqual([dropped.ok, dropped.typed], [false, true], JSON.stringify(dropped));
        assert.ok(await writesOf('dropped.txt'), 'The drop reached the pane');
        assert.equal(await enters(), entersBefore, 'No Enter after the drop');
        assert.ok((await held()).includes('third approved text') && (await held()).includes('dropped.txt'), await held());
        // Sends queued behind each other aren't other writers: each submits once.
        await showEmpty();
        entersBefore = await enters();
        const queued = await Promise.all([cli('send', 'search-polish:1', 'queued one'), cli('send', 'search-polish:1', 'queued two')]);
        assert.deepEqual(queued.map(r => r.ok), [true, true], JSON.stringify(queued));
        assert.equal(await enters(), entersBefore + 2);
        assert.deepEqual((await page.evaluate(() => window.qa.submitted.slice(-2))).sort(), ['queued one', 'queued two']);
      }
      {
        // A failed write keeps its receipt and says what may have gone in. Only a
        // send that wrote nothing is gone, and only it is safe to send again.
        await showEmpty();
        const before = await cli('send', 'search-polish:1', '--receipt', '--input', 'not-a-revision', 'never typed');
        assert.deepEqual([before.ok, before.typed, before.receipt, before.uncertain], [false, false, undefined, undefined], JSON.stringify(before));
        // The paste's write fails: some of the text may be in.
        await page.evaluate(() => { window.qa.failWriteIf = d => d.includes('paste fails'); });
        const pasteFail = await cli('send', 'search-polish:1', '--receipt', 'paste fails here');
        assert.deepEqual([pasteFail.ok, pasteFail.typed, pasteFail.uncertain, typeof pasteFail.receipt], [false, true, 'type', 'string'], JSON.stringify(pasteFail));
        const pasteRecord = (await cli('receipt', pasteFail.receipt)).data;
        assert.deepEqual([pasteRecord.wrote.stage, pasteRecord.wrote.uncertain, pasteRecord.outcome], ['accepted', 'type', 'none'], JSON.stringify(pasteRecord));
        const pasteWait = await call('wait', ['--receipt', pasteFail.receipt], null, null, 3);
        assert.deepEqual([pasteWait.ok, pasteWait.timeout], [false, false], JSON.stringify(pasteWait));
        assert.match(pasteWait.error, /may have typed part of/);
        // Enter's write fails before the pane gets it: typed, Enter uncertain, the text waiting in the input.
        await showEmpty();
        await page.evaluate(() => { window.qa.failWriteIf = d => d === '\r'; });
        const submittedBefore = await page.evaluate(() => window.qa.submitted.length);
        const enterFail = await call('send', ['search-polish:1', '--receipt', 'enter fails'], null, 'enter-fail-1');
        assert.deepEqual([enterFail.ok, enterFail.typed, enterFail.uncertain], [false, true, 'submit'], JSON.stringify(enterFail));
        assert.match(enterFail.error, /writing Enter failed \(.*\), so it may or may not have gone in/);
        const enterRecord = (await cli('receipt', enterFail.receipt)).data;
        assert.deepEqual([enterRecord.wrote.stage, enterRecord.wrote.uncertain, enterRecord.wrote.submittedAt, enterRecord.key, enterRecord.outcome],
          ['typed', 'submit', null, 'enter-fail-1', 'pending'], JSON.stringify(enterRecord));
        assert.deepEqual([await held(), await page.evaluate(() => window.qa.submitted.length)], ['enter fails', submittedBefore], 'In the input, not submitted');
        // Retried with its key: the first answer, nothing typed again.
        const typedOnce = await typedCount('enter fails');
        const retried = await call('send', ['search-polish:1', '--receipt', 'enter fails'], null, 'enter-fail-1');
        assert.deepEqual([retried.replayed, retried.receipt, retried.uncertain], [true, enterFail.receipt, 'submit'], JSON.stringify(retried));
        assert.equal(await typedCount('enter fails'), typedOnce);
        // Enter reaches the pane and its answer is lost: uncertain the same, until the turn settles it.
        await page.evaluate(() => { window.qa.failWriteIf = null; window.qa.loseReplyIf = d => d === '\r'; });
        await showEmpty();
        const lost = await cli('send', 'search-polish:1', '--receipt', 'enter answer lost');
        assert.deepEqual([lost.ok, lost.typed, lost.uncertain], [false, true, 'submit'], JSON.stringify(lost));
        assert.equal(await submittedLast(), 'enter answer lost', 'The pane did take the Enter');
        await page.evaluate(() => { window.qa.loseReplyIf = null; });
        await out(claude, '\x07');
        const settled = (await cli('receipt', lost.receipt)).data;
        assert.deepEqual([settled.wrote.stage, settled.wrote.uncertain, settled.outcome], ['typed', 'submit', 'acknowledged'], JSON.stringify(settled));
        // Without a receipt, the failure still says the text went in and Enter is uncertain.
        await page.evaluate(() => { window.qa.failWriteIf = d => d === '\r'; });
        await showEmpty();
        const plain = await cli('send', 'search-polish:1', 'plain enter fails');
        assert.deepEqual([plain.ok, plain.typed, plain.uncertain, plain.receipt], [false, true, 'submit', undefined], JSON.stringify(plain));
        await page.evaluate(() => { window.qa.failWriteIf = null; window.qa.prompt = undefined; });
      }
      {
        // Follow-up review (2026-10-01 21:12). A writer whose continuation is already
        // queued can't slip between Loom's last check and its paste. Right-click paste
        // reads the clipboard and pastes in a promise continuation; here the clipboard
        // answers at a chosen microtask depth after the send's digest, swept from before
        // the send's turn starts to after its paste begins.
        await page.evaluate(() => {
          const qa = window.qa;
          qa.realDigest = crypto.subtle.digest;
          navigator.clipboard.readText = () => new Promise(resolve => { qa.clip = resolve; });
          crypto.subtle.digest = async (...args) => {
            const out = await qa.realDigest.apply(crypto.subtle, args);
            if (qa.clipDepth !== undefined) {
              let n = qa.clipDepth;
              qa.clipDepth = undefined;
              const step = () => (n-- > 0 ? queueMicrotask(step) : qa.clip(' HUMAN'));
              step();
            }
            return out;
          };
        });
        const rightClick = id => page.evaluate(id => document.querySelector(`.pane[data-id="${id}"] .pane-term`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), id);
        const humans = () => typedCount(' HUMAN');
        const tally = { refused: 0, held: 0 };
        for (const start of ['empty', 'suggestion']) {
          for (let depth = 0; depth < 40; depth++) {
            await (start === 'empty' ? showEmpty() : showGhost());
            const rev = (await readNow()).input.rev;
            const humansBefore = await humans();
            await rightClick(claude);
            await page.evaluate(depth => { window.qa.clipDepth = depth; }, depth);
            const sent = await cli('send', 'search-polish:1', '--input', rev, '--replace', '--receipt', 'approved text');
            const at = `${start} input, writer at microtask ${depth}: ${JSON.stringify(sent)}`;
            assert.equal(await humans(), humansBefore + 1, `The writer wrote: ${at}`);
            assert.equal(sent.ok, false, at);
            assert.ok(!(await page.evaluate(() => window.qa.submitted.some(s => s.includes('HUMAN')))), `Nothing joined was submitted: ${at}`);
            if (sent.typed) {
              tally.held++;
              assert.match(sent.error, /while Loom was pasting, so it didn't press Enter/, at);
              assert.equal((await cli('receipt', sent.receipt)).data.wrote.stage, 'typed', at);
            } else {
              tally.refused++;
              assert.equal(sent.receipt, undefined, at);
            }
          }
        }
        assert.ok(tally.refused > 0 && tally.held > 0, `The sweep spans the paste's start: ${JSON.stringify(tally)}`);
        console.log(`pre-paste writer sweep (80 runs): ${tally.refused} refused before typing, ${tally.held} held Enter`);
        await page.evaluate(() => { crypto.subtle.digest = window.qa.realDigest; delete navigator.clipboard.readText; });
        // A shell receipt waits for its prompt; typing in the window meanwhile stops it with nothing typed.
        const shell = (await cli('add', 'search-polish', '--cmd=')).data.id;
        const waiting = cli('send', shell, '--receipt', 'echo approved');
        await page.waitForTimeout(300);
        await page.locator(`.pane[data-id="${shell}"] .xterm-helper-textarea`).focus();
        await page.keyboard.type('rm');
        await out(shell, '\x1b]133;A\x07PS> \x1b]133;B\x07');
        const waited = await waiting;
        assert.deepEqual([waited.ok, waited.typed, waited.receipt], [false, false, undefined], JSON.stringify(waited));
        assert.match(waited.error, /while Loom waited to type, so it typed nothing/);
        assert.ok(!(await writes(shell)).some(d => d.includes('echo approved')), 'Nothing of the send was typed');
        assert.equal((await cli('close', shell, '--yes')).ok, true);
        // A failed Enter, then a turn that had nothing to do with it: the receipt is
        // acknowledged and still uncertain, never shown as submitted.
        assert.equal((await cli('show', 'search-polish:1')).ok, true);
        await showEmpty();
        await page.evaluate(() => { window.qa.failWriteIf = d => d === '\r'; });
        const unsent = await cli('send', 'search-polish:1', '--receipt', 'never reached the agent');
        assert.deepEqual([unsent.typed, unsent.uncertain], [true, 'submit'], JSON.stringify(unsent));
        await page.evaluate(() => { window.qa.failWriteIf = null; });
        await out(claude, '\x07');
        const acked = (await cli('receipt', unsent.receipt)).data;
        assert.deepEqual([acked.outcome, acked.wrote.stage, acked.wrote.uncertain, acked.wrote.submittedAt], ['acknowledged', 'typed', 'submit', null], JSON.stringify(acked));
        assert.ok(!(await page.evaluate(() => window.qa.submitted.some(s => s.includes('never reached')))), 'The agent never got it');
      }
      {
        // Codex 0.160 itself: its output captured live (src/fixtures/codex-composer.json),
        // replayed into the Codex pane, read through Loom's own cells and cursor.
        const fixture = JSON.parse(readFileSync('src/fixtures/codex-composer.json', 'utf8'));
        const codexPane = (await cli('panes')).data.find(p => p.agent === 'codex');
        assert.equal((await cli('restart', codexPane.id, '--yes')).ok, true);
        assert.equal((await cli('show', codexPane.id)).ok, true);
        assert.equal((await cli('zoom', codexPane.id)).data.zoomed, true);
        await page.waitForTimeout(300);
        const size = await page.evaluate(id => window.qa.calls.filter(c => c.cmd === 'pty_resize' && c.args.id === id).at(-1)?.args, codexPane.id);
        assert.ok(size && size.cols >= fixture.cols && size.rows >= fixture.rows, `The zoomed pane holds the ${fixture.cols}x${fixture.rows} capture: ${JSON.stringify(size)}`);
        const replay = async step => {
          await out(codexPane.id, '\x1bc' + fixture.raw[step]);
          return (await cli('read', codexPane.id)).data;
        };
        const empty = await replay('empty');
        assert.deepEqual([empty.input.kind, empty.input.text, empty.cursor], ['suggestion', 'Ask Codex to do anything', fixture.screens.empty.cursor], JSON.stringify(empty.input));
        const draft = await replay('draft');
        assert.deepEqual([draft.input.kind, draft.input.text, draft.cursor], ['draft', 'fix the sign-up form fields too', fixture.screens.draft.cursor], JSON.stringify(draft.input));
        const wrapped = await replay('wrapped');
        assert.deepEqual([wrapped.input.kind, wrapped.input.text], ['draft', 'fix the sign-up form fields too and keep each error message right under its field when the window\nis narrow, then add tests'], JSON.stringify(wrapped.input));
        assert.notEqual(empty.input.rev.split('.')[2], draft.input.rev.split('.')[2], 'A draft moves the revision; the placeholder does not count as one');
        // The guard reads it too: --replace types nothing over Codex's draft.
        const writesBefore = (await writes(codexPane.id)).length;
        const refused = await cli('send', codexPane.id, '--replace', 'over the draft');
        assert.deepEqual([refused.ok, refused.typed], [false, false], JSON.stringify(refused));
        assert.match(refused.error, /holds a draft someone typed/);
        assert.equal((await writes(codexPane.id)).length, writesBefore, 'Nothing typed');
        // Review 2026-10-02 19:08 (P1): a draft whose first line is blank, the cursor on it.
        await out(codexPane.id, '\x1bc\x1b[2J\x1b[H• Ran the tests\r\n\r\n\x1b[1m›\x1b[0m \r\n\r\n  third line\r\n\r\n  gpt-5 high · ~\\work\r\n  ? for shortcuts\x1b[3;3H\x1b[?25h');
        const blankFirst = (await cli('read', codexPane.id)).data;
        assert.deepEqual([blankFirst.input.kind, blankFirst.input.text, blankFirst.cursor], ['draft', '\n\nthird line', { x: 2, y: 2, hidden: false }], JSON.stringify(blankFirst.input));
        const writesBlank = (await writes(codexPane.id)).length;
        const overBlank = await cli('send', codexPane.id, '--replace', 'new task');
        assert.deepEqual([overBlank.ok, overBlank.typed], [false, false], JSON.stringify(overBlank));
        assert.match(overBlank.error, /holds a draft someone typed/);
        assert.equal((await writes(codexPane.id)).length, writesBlank, 'Nothing typed into the draft');
        await out(codexPane.id, '\x1b[?25l');
        assert.equal((await cli('read', codexPane.id)).data.input.kind, 'unknown', 'A hidden cursor leaves it unread');
        assert.equal((await cli('zoom', codexPane.id)).data.zoomed, false);
      }
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS loomctl input kinds and guarded sends, receipt records, worktree deletion plans and steps, no-break prompt, paste-to-Enter writers, receipts on failed writes, pre-paste writer sweep, unrelated turns after a failed Enter, Codex composer replay ${width}px`);
      // In memory only: after a restart, a receipt says it's unavailable rather than pending.
      await page.reload();
      await page.waitForFunction(() => window.qa?.calls.some(c => c.cmd === 'cli_ready'));
      const afterRestart = await cli('receipt', auditToken);
      assert.deepEqual([afterRestart.ok, afterRestart.unavailable], [false, true], JSON.stringify(afterRestart));
    }
    await page.goto(base + '?long-location');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.click('#dashboard-btn');
    await page.locator('#dashboard-counts button[data-group="active"]').click();
    for (const compact of [false, true]) {
      if (compact) await page.click('#dashboard-compact');
      for (const selecting of [false, true]) {
        if (selecting) await page.click('#dashboard-select');
        const name = `dashboard-long-location-${compact ? 'compact' : 'expanded'}${selecting ? '-selecting' : ''}`;
        await audit(name);
        const overflow = await page.locator('.dashboard-location').evaluateAll(locations => locations.filter(el => {
          const bounds = el.getBoundingClientRect();
          const row = el.closest('.dashboard-row').getBoundingClientRect();
          return bounds.right > row.right || bounds.left < row.left;
        }).map(el => el.textContent));
        assert.deepEqual(overflow, [], `${name}@${width}: location must fit inside its row, clear of the action buttons`);
        assert.ok(await page.locator('#dashboard').evaluate(el => el.scrollWidth <= el.clientWidth), `${name}@${width}: dashboard must not scroll sideways`);
      }
      await page.click('#dashboard-select');
    }
    await page.goto(base);
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await audit('workspace');
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'false');
    await page.click('#preferences-btn');
    await page.click('#keep-awake');
    await page.waitForFunction(() => window.qa.keepAwake === true && window.qa.saved.keepAwake === true);
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'true');
    await audit('keep-awake-on');
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.saved && window.qa.keepAwake === true);
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'true', 'Restore the native request on launch');
    await page.click('#preferences-btn');
    await page.evaluate(() => { window.qa.failAwake = true; });
    await page.click('#keep-awake');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Test power request failed'));
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'true', 'A failed release must remain shown as on');
    await audit('keep-awake-error');
    await page.evaluate(() => { window.qa.failAwake = false; });
    await page.click('#keep-awake');
    await page.waitForFunction(() => window.qa.keepAwake === false && window.qa.saved.keepAwake === false);
    await audit('keep-awake-off');
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.saved && window.qa.keepAwake === false);
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'false', 'Off survives relaunch');
    await page.click('#preferences-btn');
    await page.click('#keep-awake');
    await page.waitForFunction(() => window.qa.saved.keepAwake === true);
    await page.goto(base + '?restore&awake-error');
    await page.waitForFunction(() => window.qa.saved);
    assert.equal(await page.locator('#keep-awake').getAttribute('aria-pressed'), 'false', 'A failed startup request must not claim to keep the PC awake');
    assert.equal(await page.evaluate(() => window.qa.saved.keepAwake), false);
    // Task notices: a pane's bell, its menu open, and the Preferences rows (finished / failed / blocked) all fit and stay tappable.
    {
      const bell = page.locator('.pane .pane-head button.notify').first();
      await bell.click();
      await page.waitForSelector('#pane-menu:not(.hidden) .menu-item');
      await audit('notify-menu');
      await page.locator('#pane-menu .menu-item', { hasText: 'Off for this pane' }).click();
      assert.deepEqual(await bell.evaluate(b => [b.classList.contains('own'), b.classList.contains('off'), !!b.querySelector('.i-bell-off')]), [true, true, true], 'Its own off shows');
      await audit('notify-pane-off');
      await page.click('#preferences-btn');
      await audit('notices-preferences');
      for (const id of ['#notices', '#notice-finish', '#notice-fail', '#notice-blocked', '#notice-new']) {
        const r = await page.locator(id).boundingBox();
        assert.ok(r && r.width >= 40 && r.height >= 28, `${id}@${width}: too small to tap: ${JSON.stringify(r)}`);
      }
      await page.click('#notice-fail');
      assert.equal(await page.locator('#notice-fail').getAttribute('aria-pressed'), 'false');
      await page.waitForFunction(() => window.qa.saved?.notify?.kinds?.fail === false);
      await page.click('#notice-fail');
      await page.click('#preferences-btn');
      await bell.click();
      await page.locator('#pane-menu .menu-item', { hasText: 'Like every pane' }).click();
      assert.deepEqual(await bell.evaluate(b => [b.classList.contains('own'), b.classList.contains('off')]), [false, false]);
    }
    // The overview must observe every thread without consuming its notifications.
    await page.goto(base + '?dashboard');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.waitForTimeout(1800);
    await page.evaluate(async () => {
      const panes = [
        window.qa.panes.find(p => p.cwd.endsWith('search-polish') && !p.codexStateId),
        window.qa.panes.find(p => p.codexStateId),
        window.qa.panes.find(p => p.cwd.endsWith('review-keyboard-navigation')),
        window.qa.panes.find(p => p.cwd.endsWith('tools')),
      ];
      window.qa.dashboardPanes = panes;
      panes[0].onOut.onmessage('\x1b[2J\x1b[HReview complete. Please confirm the changes.\x1b]9;ready\x07');
      panes[1].onOut.onmessage('\x1b[2J\x1b[HImplementing thread navigation\r\nWorking (3s, esc to interrupt)');
      panes[2].onOut.onmessage('\x1b[2J\x1b[HWaiting for your review\x1b]9;ready\x07');
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${panes[3].id}`, payload: 1 });
    });
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '2 waiting');
    await page.click('#dashboard-btn');
    await page.waitForSelector('.dashboard-row');
    await page.waitForFunction(() => document.querySelector('.dashboard-message')?.textContent.includes('Review the'));
    assert.equal(await page.locator('.dashboard-row').count(), 4);
    assert.deepEqual(await page.locator('.dashboard-row').filter({ hasText: 'search-polish / claude' }).locator('.dashboard-message').evaluateAll(lines => lines.map(line => [line.querySelector('b').textContent, line.querySelector('span').textContent])),
      [['You', 'Review the claude changes'], ['Agent', 'The claude changes are ready']], 'Expanded rows show the conversation rather than terminal status lines');
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'Overview must not mark the selected terminal as seen');
    assert.deepEqual(await page.locator('.dashboard-row').evaluateAll(rows => rows.map(r => r.dataset.state)), ['waiting', 'waiting', 'busy', 'dead']);
    await audit('dashboard-all');
    await page.evaluate(() => window.qa.dashboardPanes[1].onOut.onmessage('\x1b[2J\x1b[HDone.\x1b]9;ready\x07'));
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '3 waiting');
    await page.locator('.dashboard-row').filter({ hasText: 'search-polish / codex' }).click();
    assert.equal(await page.locator('#waiting').textContent(), '3 waiting', 'Opening a Codex preview leaves it unread');
    await page.evaluate(() => { window.qa.ackStart = window.qa.calls.length; });
    for (let click = 0; click < 2; click++) {
      if (click) {
        await page.evaluate(() => window.qa.dashboardPanes[1].onOut.onmessage('\x1b]9;ready\x07'));
        await page.waitForFunction(() => document.querySelector('#waiting').textContent === '3 waiting');
      }
      await page.locator('#dashboard-preview-output .xterm-screen').click();
      assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'Clicking Codex acknowledges it, including when already focused');
      assert.equal(await page.locator('#dashboard-preview-status').getAttribute('data-state'), '', 'Preview status updates immediately on acknowledgement');
    }
    assert.equal(await page.evaluate(() => window.qa.calls.slice(window.qa.ackStart).some(c => c.cmd === 'pty_write')), false, 'Acknowledging a preview needs no terminal input');
    await audit('dashboard-codex-acknowledged');
    await page.click('#dashboard-preview-close');
    await page.evaluate(() => window.qa.dashboardPanes[1].onOut.onmessage('\x1b[2J\x1b[HImplementing thread navigation\r\nWorking (3s, esc to interrupt)'));
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-row')].some(r => r.textContent.includes('search-polish / codex') && r.dataset.state === 'busy'));
    assert.equal(await page.locator('#dashboard-counts').evaluate(bar => [...bar.children].every(button => button.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1)), true, 'Status filters stay aligned with the session list');
    assert.equal(await page.locator('.dashboard-group').count(), 0, 'All is a flat list without group sections');
    const previewClaude = () => page.locator('.dashboard-row').filter({ hasText: 'search-polish / claude' }).click();
    await page.evaluate(() => {
      const qa = window.qa;
      qa.previewNode = document.querySelector(`.pane[data-id="${qa.dashboardPanes[0].id}"]`);
      qa.previewTerminal = qa.previewNode.querySelector('.xterm');
      qa.previewParent = qa.previewNode.parentElement;
      qa.previewOrder = [...qa.previewParent.querySelectorAll(':scope > .pane')].map(p => p.dataset.id);
      qa.previewSpawnCount = qa.calls.filter(c => c.cmd === 'pty_spawn').length;
      qa.previewStart = qa.calls.length;
    });
    await previewClaude();
    await page.waitForSelector('#dashboard-preview[open]');
    await page.waitForFunction(() => window.qa.calls.slice(window.qa.previewStart).some(c => c.cmd === 'pty_resize' && c.args.id === window.qa.dashboardPanes[0].id));
    assert.equal(await page.evaluate(() => document.querySelector('#dashboard-preview-output > .pane') === window.qa.previewNode && window.qa.previewNode.querySelector('.xterm') === window.qa.previewTerminal), true, 'Preview uses the existing live pane and terminal');
    await page.locator('#dashboard-preview').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const modal = await page.locator('#dashboard-preview').boundingBox();
    assert.ok(Math.abs(modal.x + modal.width / 2 - width / 2) < 1, 'Preview is centered horizontally');
    assert.ok(Math.abs(modal.y + modal.height / 2 - page.viewportSize().height / 2) < 1, 'Preview is centered vertically');
    const previewFontSize = await page.evaluate(() => window.qa.saved.fontSize);
    await page.locator('#dashboard-preview-output .xterm-screen').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 });
    await page.waitForFunction(size => window.qa.saved.fontSize === size + 1, previewFontSize);
    await page.locator('#dashboard-preview-output .xterm-screen').dispatchEvent('wheel', { ctrlKey: true, deltaY: 100 });
    await page.waitForFunction(size => window.qa.saved.fontSize === size, previewFontSize);
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'Preview must not acknowledge a waiting agent');
    await audit('dashboard-preview');
    await page.mouse.click(modal.x + 4, modal.y + 4);
    assert.equal(await page.locator('#dashboard-preview').isVisible(), true, 'Clicking inside the dialog keeps it open');
    await page.mouse.click(modal.x / 2, modal.y + modal.height / 2);
    assert.equal(await page.locator('#dashboard-preview').isVisible(), false, 'Clicking the backdrop closes the preview');
    assert.equal(await page.evaluate(() => window.qa.previewNode.parentElement === window.qa.previewParent), true, 'Backdrop close restores the live pane');
    await previewClaude();
    await escape();
    assert.equal(await page.evaluate(() => window.qa.previewNode.parentElement === window.qa.previewParent), true, 'Closing restores the original grid');
    assert.deepEqual(await page.evaluate(() => [...window.qa.previewParent.querySelectorAll(':scope > .pane')].map(p => p.dataset.id)), await page.evaluate(() => window.qa.previewOrder), 'Pane order is preserved');
    assert.equal(await page.locator('.dashboard-row').filter({ hasText: 'search-polish / claude' }).evaluate(el => el === document.activeElement), true, 'Closing preview returns focus to its session');
    await previewClaude();
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'pty_spawn').length), await page.evaluate(() => window.qa.previewSpawnCount), 'Preview never starts a duplicate process');
    await page.locator('#dashboard-preview-output .xterm-screen').click();
    assert.equal(await page.locator('#waiting').textContent(), '1 waiting', 'Clicking the Claude preview acknowledges only that pane');
    await page.evaluate(() => window.qa.dashboardPanes[0].onOut.onmessage('\x1b]9;ready\x07'));
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '2 waiting');
    await page.evaluate(() => { window.qa.failWrite = true; });
    await page.keyboard.type('x');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Test terminal write failed'));
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'A rejected write must not consume the attention signal');
    await audit('dashboard-send-error');
    await page.evaluate(() => {
      window.qa.failWrite = false;
      window.qa.writeStart = window.qa.calls.length;
    });
    await page.keyboard.type('Please review');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '1 waiting');
    const writes = await page.evaluate(() => window.qa.calls.slice(window.qa.writeStart).filter(c => c.cmd === 'pty_write').map(c => c.args));
    assert.ok(writes.every(w => w.id === writes[0].id));
    assert.equal(writes[0].id, await page.evaluate(() => window.qa.dashboardPanes[0].id), 'Reply only reaches the selected agent');
    assert.equal(writes.map(w => w.data).join(''), 'Please review\r', 'Typing goes directly to the existing PTY');
    await escape();
    assert.equal(await page.locator('#dashboard-preview').isVisible(), true, 'Escape belongs to the focused terminal');
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'pty_write').at(-1).args.data), '\x1b');
    await page.evaluate(() => window.qa.dashboardPanes[0].onOut.onmessage('\r\n\x1b[32mLive terminal update\x1b[0m\r\n'));
    await audit('dashboard-message-sent');
    await page.click('#dashboard-preview-open');
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    assert.equal(await page.evaluate(() => window.qa.previewNode.parentElement === window.qa.previewParent && window.qa.previewNode.querySelector('.xterm') === window.qa.previewTerminal), true, 'Open thread restores the same terminal before navigating');
    await page.click('#dashboard-btn');
    await previewClaude();
    await page.evaluate(() => { window.qa.controlKill = true; window.qa.killStart = window.qa.calls.length; });
    await page.click('#dashboard-process');
    await audit('dashboard-stop-confirm');
    await escape();
    assert.equal(await page.evaluate(() => window.qa.calls.slice(window.qa.killStart).filter(c => c.cmd === 'pty_kill').length), 0);
    await page.click('#dashboard-process');
    await page.click('#confirm-action');
    await page.waitForFunction(() => document.querySelector('#dashboard-process').textContent === 'Relaunch');
    await audit('dashboard-stopped');
    await page.click('#dashboard-process');
    await page.waitForFunction(() => document.querySelector('#dashboard-process').textContent === 'Stop process');
    // Each launch has its own output channel; delayed output from the old
    // process must never reach the replacement terminal.
    await page.evaluate(() => {
      const id = window.qa.dashboardPanes[0].id;
      window.qa.dashboardPanes[0] = window.qa.panes.findLast(p => p.id === id);
    });
    assert.equal(await page.locator('#dashboard-preview').isVisible(), true);
    assert.equal(await page.locator('.pane').count(), 4, 'Relaunch keeps the existing pane');
    await audit('dashboard-relaunched');
    await escape();
    await page.evaluate(() => { window.qa.controlKill = false; window.qa.dashboardPanes[0].onOut.onmessage('\x1b]9;ready\x07'); });
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '2 waiting');
    await page.click('#dashboard-compact');
    await audit('dashboard-compact');
    assert.equal(await page.locator('.dashboard-message:visible').count(), 0, 'Compact rows hide the message excerpts');
    const compactPreview = page.locator('.dashboard-card').filter({ hasText: 'review-keyboard-navigation / claude' }).locator('.dashboard-preview-button');
    assert.equal(await compactPreview.textContent(), '', 'Compact preview uses only an icon');
    await compactPreview.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dashboard-preview[open]');
    assert.equal(await page.locator('#dashboard-preview-output > .pane').getAttribute('data-id'), await page.evaluate(() => window.qa.dashboardPanes[2].id), 'Preview also mounts a pane from a background thread');
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'Compact preview leaves the waiting alert unread');
    assert.equal(await page.locator('#dashboard').isVisible(), true, 'Preview stays in the overview');
    await audit('dashboard-compact-preview');
    await page.evaluate(async () => {
      const qa = window.qa;
      qa.writeStart = qa.calls.length;
      const bounds = document.querySelector('#dashboard-preview-output .xterm-screen').getBoundingClientRect();
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: {
        paths: ['C:\\my files\\review.txt'], position: { x: (bounds.left + 20) * devicePixelRatio, y: (bounds.top + 20) * devicePixelRatio },
      } });
    });
    await page.waitForFunction(() => window.qa.calls.slice(window.qa.writeStart).some(c => c.cmd === 'pty_write'));
    assert.deepEqual(await page.evaluate(() => window.qa.calls.slice(window.qa.writeStart).filter(c => c.cmd === 'pty_write').map(c => c.args)), [{ id: await page.evaluate(() => window.qa.dashboardPanes[2].id), data: '"C:\\my files\\review.txt"' }], 'File drops reach the previewed background pane');
    await page.evaluate(() => window.qa.dashboardPanes[2].onOut.onmessage('\x1b]9;ready\x07'));
    await page.waitForFunction(() => document.querySelector('#waiting').textContent === '2 waiting');
    await page.click('#dashboard-preview-close');
    // By key, not element: the Overview may rebuild its cards between finding the icon and reading the focus, and a
    // rebuild puts focus back on the same key (renderDashboard), so element identity would race it.
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.key), await compactPreview.getAttribute('data-key'), `Preview returns focus to the icon @${width}: focus is on ${await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}#${a?.id}.${a?.className} key=${a?.dataset?.key}`; })}`);
    await page.click('#dashboard-compact');
    assert.equal(await page.locator('.dashboard-preview-button').count(), 0, 'Expanded view restores its existing actions');
    await page.click('#dashboard-compact');
    await page.click('.dashboard-help summary');
    await audit('dashboard-status-help');
    await page.click('.dashboard-help summary');
    await page.click('#dashboard-counts button[data-state=waiting]');
    assert.equal(await page.locator('.dashboard-row').count(), 2);
    await audit('dashboard-waiting');
    await page.locator('.dashboard-row').first().focus();
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.dashboard-row').first().evaluate(el => el === document.activeElement), true, 'Live refresh preserves row focus');
    await page.click('#dashboard-counts button[data-state=all]');
    await page.selectOption('#dashboard-project', 'C:\\projects\\tools');
    assert.equal(await page.locator('.dashboard-row').count(), 1);
    assert.equal(await page.locator('#dashboard-next').isDisabled(), true, 'Next waiting must follow project filters');
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#dashboard').isVisible(), true, 'F3 must not jump to a filtered-out agent');
    await audit('dashboard-project');
    await page.selectOption('#dashboard-project', '');
    await page.fill('#dashboard-query', 'Implementing thread navigation');
    assert.equal(await page.locator('.dashboard-row').count(), 1, 'Search includes current terminal output');
    await audit('dashboard-search');
    await page.fill('#dashboard-query', 'no-such-agent');
    assert.equal(await page.locator('#dashboard-empty').isVisible(), true);
    await audit('dashboard-no-results');
    await page.click('#dashboard-reset');
    assert.equal(await page.locator('.dashboard-row').count(), 4);
    assert.equal(await page.locator('#dashboard-counts button[data-state=""]').isDisabled(), true, 'An empty status filter is disabled');
    await page.evaluate(() => window.qa.dashboardPanes[1].onOut.onmessage('\x1b]9;finished\x07'));
    await page.waitForFunction(() => document.querySelector('#dashboard-counts button[data-state=waiting] b').textContent === '3');
    await page.click('#dashboard-counts button[data-state=all]');
    await page.evaluate(() => { window.qa.writesBeforeDashboard = window.qa.calls.filter(c => c.cmd === 'pty_write').length; });
    await page.keyboard.press('F4');
    await page.keyboard.press('F5');
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('#find').isVisible(), false, 'Terminal shortcuts do not open controls over hidden panes');
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'pty_write').length), await page.evaluate(() => window.qa.writesBeforeDashboard));
    await page.locator('.dashboard-row').filter({ hasText: 'review-keyboard-navigation / claude' }).click();
    assert.equal(await page.locator('#dashboard-preview').isVisible(), false, 'Compact row opens its thread directly');
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    assert.equal(await page.locator('#wsname').textContent(), 'review-keyboard-navigation');
    assert.equal(await page.locator('#waiting').textContent(), '2 waiting', 'Only the opened agent is acknowledged');
    await audit('dashboard-open-agent');
    await page.keyboard.press('Control+Shift+d');
    await page.click('#dashboard-next');
    assert.equal(await page.locator('#waiting').textContent(), '1 waiting');
    await page.keyboard.press('Control+Shift+d');
    await page.waitForFunction(() => window.qa.saved.ui.dashboard === true);
    await page.goto(base + '?dashboard&restore');
    await page.waitForSelector('#dashboard:not(.hidden)');
    await audit('dashboard-restored');
    assert.equal(await page.locator('#dashboard-compact').getAttribute('aria-pressed'), 'true', 'Density preference survives restart');
    await page.waitForTimeout(1800);
    await page.click('#dashboard-counts button[data-state=""]');
    assert.equal(await page.locator('.dashboard-row').count(), 4);
    await audit('dashboard-idle');
    await page.click('#side-toggle');
    await audit('dashboard-navigation');
    await page.click('#preferences-btn');
    await audit('dashboard-preferences');
    await escape();
    await page.goto(base + '?dashboard&many');
    await page.waitForFunction(() => window.qa.panes.length === 40 && window.qa.saved);
    await page.click('#dashboard-btn');
    assert.equal(await page.locator('.dashboard-row').count(), 40);
    await page.fill('#dashboard-query', 'thread-39-');
    assert.equal(await page.locator('.dashboard-row').count(), 1);
    await audit('dashboard-many-threads');
    // Triage: reply from the list, then step through sessions inside the preview.
    await page.goto(base + '?dashboard');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
      const qa = window.qa;
      const [a, b] = [qa.panes.find(p => p.cwd.endsWith('search-polish') && !p.codexStateId), qa.panes.find(p => p.cwd.endsWith('review-keyboard-navigation'))];
      qa.replyPane = a.id;
      qa.menuPane = b.id;
      // b shows a Claude permission prompt; arrow keys move its highlight like the real one.
      qa.menuSel = 0;
      qa.drawMenu = () => b.onOut.onmessage('\x1b[2J\x1b[H Bash command\r\n\r\n   rm -rf build\r\n\r\n Do you want to proceed?\r\n'
        + ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)'].map((o, i) => `${i === qa.menuSel ? ' ❯ ' : '   '}${i + 1}. ${o}`).join('\r\n') + '\r\n');
      qa.echo = true;
      qa.onWrite = ({ id, data }) => {
        if (id === qa.menuPane && /^\x1b[[O][AB]$/.test(data)) ((qa.menuSel += data.endsWith('B') ? 1 : -1), qa.drawMenu());
        else if (id === qa.replyPane && qa.echo) a.onOut.onmessage(data);
      };
      a.onOut.onmessage('\x1b]9;ready\x07');
      qa.drawMenu();
      b.onOut.onmessage('\x1b]9;ready\x07');
    });
    await page.click('#dashboard-btn');
    await page.waitForSelector('.dashboard-usage .ctx', { timeout: 8000 });
    assert.equal(await page.locator('.dashboard-reply input').count(), 1, 'Only a waiting agent at its input gets a reply box');
    const menuCard = page.locator('.dashboard-card').filter({ hasText: 'review-keyboard-navigation / claude' });
    assert.deepEqual(await menuCard.locator('.dashboard-choices button').allTextContents(), ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)'], 'A menu on screen becomes its options');
    assert.match(await menuCard.locator('.dashboard-question').textContent(), /rm -rf build\nDo you want to proceed\?$/, 'The card shows what the agent asks');
    await audit('dashboard-menu');
    await page.focus('#dashboard-query');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.dashboard-row')].at(-1)), true, 'Arrow keys walk the rows');
    // Keys on a card: R goes to its reply box, Esc comes back, a digit picks that menu option.
    const keyCard = page.locator('.dashboard-card').filter({ hasText: 'search-polish / claude' });
    await keyCard.locator('.dashboard-row').focus();
    await page.keyboard.press('r');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.key?.startsWith('reply-')), true, 'R jumps to the reply box');
    await page.keyboard.type('rx1'); // Typing in the box is typing: none of it is a shortcut.
    assert.equal(await keyCard.locator('.dashboard-reply input').inputValue(), 'rx1');
    assert.equal(await page.locator('#dashboard-bulk').isVisible(), false, 'X typed in a reply box does not start selecting');
    await keyCard.locator('.dashboard-reply input').fill('');
    await page.keyboard.press('Escape');
    assert.equal(await keyCard.locator('.dashboard-row').evaluate(el => el === document.activeElement), true, 'Esc in the reply box returns to its card');
    assert.deepEqual(await menuCard.locator('.dashboard-choices button').evaluateAll(bs => bs.map(b => b.dataset.n)), ['1', '2', '3'], 'Each option carries the number key that picks it');
    await menuCard.locator('.dashboard-row').focus();
    await page.evaluate(() => { window.qa.digitStart = window.qa.calls.length; });
    await page.keyboard.press('1');
    await page.waitForFunction(() => !document.querySelector('.dashboard-choices'));
    assert.deepEqual(await page.evaluate(() => window.qa.calls.slice(window.qa.digitStart).filter(c => c.cmd === 'pty_write').map(c => [c.args.id === window.qa.menuPane, c.args.data])), [[true, '\r']], 'A digit on a card answers that option: 1 is already highlighted, so only Enter');
    await page.evaluate(() => { window.qa.menuSel = 0; window.qa.drawMenu(); window.qa.panes.find(p => p.id === window.qa.menuPane).onOut.onmessage('\x1b]9;ready\x07'); });
    await page.waitForSelector('.dashboard-choices button');
    const reply = page.locator('.dashboard-card').filter({ hasText: 'search-polish / claude' }).locator('.dashboard-reply input');
    await reply.fill('Yes, go ahead');
    await page.waitForTimeout(1200);
    assert.equal(await reply.inputValue(), 'Yes, go ahead', 'A draft survives live refreshes');
    await audit('dashboard-reply-draft');
    await page.evaluate(() => { window.qa.replyStart = window.qa.calls.length; });
    await reply.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.dashboard-reply input'));
    const replies = await page.evaluate(() => window.qa.calls.slice(window.qa.replyStart).filter(c => c.cmd === 'pty_write').map(c => c.args));
    assert.ok(replies.every(w => w.id === replies[0].id) && replies[0].id === await page.evaluate(() => window.qa.replyPane), 'A reply only reaches its agent');
    assert.ok(replies.some(w => w.data.includes('Yes, go ahead')) && replies.at(-1).data === '\r', 'A reply is typed, then submitted');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.dashboard-card')?.textContent.includes('review-keyboard-navigation')), true, 'Focus moves to the next waiting reply');
    await page.locator('.dashboard-row').first().click();
    await page.waitForSelector('#dashboard-preview[open]');
    const previewTitle = () => page.locator('#dashboard-preview-title').textContent();
    const firstPreview = await previewTitle();
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await previewTitle(), firstPreview, 'Right arrow previews the next session');
    assert.equal(await page.locator('#dashboard-preview-output > .pane').count(), 1, 'One pane is mounted at a time');
    await page.click('#dashboard-preview-prev');
    assert.equal(await previewTitle(), firstPreview);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#dashboard-preview-position').textContent(), '4 of 4', 'Stepping wraps');
    await page.keyboard.press('F3');
    assert.equal(await previewTitle(), 'review-keyboard-navigation / claude', 'F3 previews the next waiting session');
    await audit('dashboard-preview-stepped');
    await page.click('#dashboard-preview-close');
    assert.equal(await page.locator('.grid .pane').count(), 4, 'Stepping returns every pane to its thread');
    // Choosing walks the highlight one arrow at a time, then presses Enter.
    await page.evaluate(() => { window.qa.chooseStart = window.qa.calls.length; });
    await menuCard.locator('.dashboard-choices button').nth(2).click();
    await page.waitForFunction(() => !document.querySelector('.dashboard-choices'));
    assert.deepEqual(await page.evaluate(() => window.qa.calls.slice(window.qa.chooseStart).filter(c => c.cmd === 'pty_write').map(c => [c.args.id === window.qa.menuPane, c.args.data])),
      [[true, '\x1b[B'], [true, '\x1b[B'], [true, '\r']], 'Only that agent gets two arrows and Enter');
    // Text that never shows up on screen is not submitted.
    await page.evaluate(() => {
      window.qa.echo = false;
      window.qa.panes.find(p => p.id === window.qa.replyPane).onOut.onmessage('\x1b]9;ready\x07');
      window.qa.refuseStart = window.qa.calls.length;
    });
    await page.locator('.dashboard-reply input').fill('Skip the tests');
    await page.locator('.dashboard-reply input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#toast:not(.hidden)')?.textContent.includes("didn't show your text"));
    assert.equal(await page.evaluate(() => window.qa.calls.slice(window.qa.refuseStart).some(c => c.cmd === 'pty_write' && c.args.data === '\r')), false, 'No Enter without an echo');
    assert.equal(await page.locator('.dashboard-reply input').inputValue(), 'Skip the tests', 'The draft stays for another try');
    await audit('dashboard-reply-refused');
    // Custom groups span projects/states; membership is many-to-many and survives restart.
    await page.goto(base + '?dashboard');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.waitForTimeout(1800);
    await page.evaluate(async () => {
      const qa = window.qa;
      qa.panes[0].onOut.onmessage('\x1b]9;ready\x07');
      qa.panes.find(p => p.codexStateId).onOut.onmessage('\x1b[2J\x1b[HWorking (3s, esc to interrupt)');
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${qa.panes.find(p => p.cwd.endsWith('tools')).id}`, payload: 1 });
      qa.groupCallStart = qa.calls.length;
    });
    await page.click('#dashboard-btn');
    assert.equal(await page.locator('.dashboard-results #dashboard-new-group').count(), 1, 'Create group lives in the results row, not on a line of its own');
    if (width > 600) assert.ok(await page.evaluate(() => Math.abs(document.querySelector('#dashboard-new-group').getBoundingClientRect().top - document.querySelector('#dashboard-compact').getBoundingClientRect().top) < 4), 'Create group shares a line with Compact view');
    await page.click('#dashboard-counts button[data-state=waiting]');
    await page.selectOption('#dashboard-project', 'C:\\projects\\loom');
    await page.click('#dashboard-new-group');
    const members = page.locator('#agent-group-members input');
    assert.equal(await members.count(), 4, 'Group editor ignores project and status filters');
    await page.fill('#agent-group-name', 'Release <team>');
    for (const i of [0, 1, 3]) await members.nth(i).check();
    await audit('group-create');
    await page.click('#agent-group-form button[type=submit]');
    await page.click('#dashboard-reset');
    await page.waitForFunction(() => window.qa.saved.agentGroups.length === 1);
    const firstGroup = await page.evaluate(() => window.qa.saved.agentGroups[0].id);
    assert.equal(await page.locator('.dashboard-group').count(), 0, 'Creating a group does not split All into sections');
    const groupFilter = id => page.locator(`#dashboard-counts button[data-group="${id}"]`);
    await groupFilter(firstGroup).click();
    assert.equal(await page.locator(`.dashboard-card[data-group="${firstGroup}"]`).count(), 3);
    assert.deepEqual(await page.locator(`.dashboard-card[data-group="${firstGroup}"] .dashboard-row`).evaluateAll(rows => rows.map(r => r.dataset.state).sort()), ['busy', 'dead', 'waiting']);
    await audit('group-mixed-states');
    await groupFilter(firstGroup).click();
    assert.equal(await groupFilter(firstGroup).getAttribute('aria-pressed'), 'true');
    assert.equal(await groupFilter(firstGroup).locator('b').textContent(), '3');
    assert.equal(await page.locator('.dashboard-row').count(), 3, 'Group filter shows only its members, across projects and states');
    assert.deepEqual(await page.locator('.dashboard-group h2').allTextContents(), ['Release <team> (3)']);
    await audit('group-filter');
    await page.selectOption('#dashboard-project', 'C:\\projects\\tools');
    assert.equal(await page.locator('.dashboard-row').count(), 1);
    assert.equal(await page.locator('#dashboard-next').isDisabled(), true, 'Next waiting respects group and project filters');
    await audit('group-filter-project');
    await page.fill('#dashboard-query', 'no-matching-agent');
    assert.equal(await page.locator('.dashboard-row').count(), 0);
    await audit('group-filter-no-results');
    await page.click('#dashboard-reset');
    assert.equal(await page.locator('.dashboard-row').count(), 4);
    await groupFilter(firstGroup).click();
    await page.click('#dashboard-counts button[data-state=""]');
    assert.equal(await groupFilter(firstGroup).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.dashboard-row').count(), 1, 'Status filters replace group selection');
    assert.equal(await page.locator('.dashboard-group').count(), 0, 'Status views do not show group sections');
    await page.click('#dashboard-counts button[data-state=all]');
    await page.click('#dashboard-new-group');
    await page.fill('#agent-group-name', 'Another group with a long name that must remain readable on a phone');
    await page.click('#agent-group-form button[type=submit]');
    await page.waitForFunction(() => window.qa.saved.agentGroups.length === 2);
    const secondGroup = await page.evaluate(() => window.qa.saved.agentGroups[1].id);
    const editGroup = async id => { await groupFilter(id).click(); await page.locator(`[data-key="Edit-${id}"]`).click(); };
    const deleteGroup = async id => { await groupFilter(id).click(); await page.locator(`[data-key="Delete-${id}"]`).click(); };
    await groupFilter(secondGroup).click();
    await page.locator(`[data-key="Edit-${secondGroup}"]`).scrollIntoViewIfNeeded();
    await audit('group-empty');
    await groupFilter(secondGroup).click();
    assert.equal(await page.locator('.dashboard-row').count(), 0, 'An empty group can still be selected and edited');
    await audit('group-filter-empty');
    await editGroup(secondGroup);
    await page.fill('#agent-group-name', 'Review');
    await members.nth(0).check();
    await members.nth(2).check();
    await audit('group-edit');
    await page.click('#agent-group-form button[type=submit]');
    assert.equal(await groupFilter(secondGroup).locator('span').textContent(), 'Review', 'Renaming updates its filter');
    assert.equal(await page.locator('.dashboard-row').count(), 2, 'Editing keeps the group selected and refreshes its members');
    assert.equal(await page.locator('.dashboard-group').count(), 1, 'Other groups are hidden');
    await audit('group-filter-edited');
    await page.click('#dashboard-counts button[data-state=all]');
    assert.equal(await page.locator('.dashboard-row').count(), 4, 'All lists each agent once regardless of group memberships');
    assert.equal(await page.locator('.dashboard-group').count(), 0);
    await audit('group-all-flat');
    assert.equal(await page.locator('#dashboard-results').textContent(), '4 of 4 sessions', 'Counts count agents once');
    await page.locator('.dashboard-row').filter({ hasText: 'search-polish / claude' }).first().click();
    await page.locator('#dashboard-preview-output .xterm-screen').click();
    await page.click('#dashboard-preview-close');
    await page.evaluate(async () => {
      window.qa.panes.find(p => p.cwd.endsWith('review-keyboard-navigation')).onOut.onmessage('\x1b]9;ready\x07');
      await new Promise(resolve => setTimeout(resolve, 30));
      window.qa.panes[0].onOut.onmessage('\x1b]9;ready\x07');
    });
    await page.locator('.dashboard-row').filter({ hasText: 'search-polish / codex' }).click();
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#dashboard-preview-title').textContent(), 'review-keyboard-navigation / claude', 'F3 follows waiting age rather than group order');
    await page.locator('#dashboard-preview-output .xterm-screen').click();
    await page.click('#dashboard-preview-close');
    const groupReplies = page.locator('.dashboard-reply input');
    await groupReplies.last().fill('Shared draft');
    assert.deepEqual(await groupReplies.evaluateAll(inputs => inputs.map(input => input.value)), ['Shared draft']);
    await page.waitForTimeout(1200);
    assert.equal(await groupReplies.last().evaluate(el => el === document.activeElement), true, 'Refresh keeps focus in the same group');
    await audit('group-shared-agent');
    await editGroup(firstGroup);
    await page.fill('#agent-group-name', ' review ');
    await page.click('#agent-group-form button[type=submit]');
    assert.equal(await page.locator('#agent-group-name').evaluate(el => el.validity.customError), true);
    await page.fill('#agent-group-name', 'Release');
    await members.nth(1).uncheck();
    await page.click('#agent-group-form button[type=submit]');
    await page.waitForFunction(() => window.qa.saved.agentGroups[0].name === 'Release' && window.qa.saved.threads[0].panes[0].groupIds.length === 2);
    assert.equal(await page.locator('.dashboard-row').count(), 2, 'Removing a membership removes the agent from this group view');
    await page.click('#dashboard-counts button[data-state=all]');
    assert.equal(await page.locator('.dashboard-row').count(), 4);
    const memberships = await page.evaluate(() => window.qa.saved.threads.flatMap(t => t.panes.map(p => p.groupIds)));
    assert.deepEqual(memberships.map(ids => [...ids].sort()), [[firstGroup, secondGroup].sort(), [], [secondGroup], [firstGroup]]);
    assert.equal(await page.evaluate(() => window.qa.calls.slice(window.qa.groupCallStart).some(c => ['pty_kill', 'pty_spawn', 'pty_write'].includes(c.cmd))), false, 'Grouping never changes agent processes');
    await page.locator('.dashboard-row').filter({ hasText: 'search-polish / claude' }).click();
    assert.match(await page.locator('#dashboard-preview-position').textContent(), /of 4$/, 'Preview counts a shared agent once');
    await page.click('#dashboard-preview-close');
    await page.evaluate(() => {
      window.qa.groupSendStart = window.qa.calls.length;
      window.qa.onWrite = ({ id, data }) => window.qa.panes.find(p => p.id === id).onOut.onmessage(data);
      document.querySelectorAll('.dashboard-reply').forEach(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
    });
    await page.waitForFunction(() => !document.querySelector('.dashboard-reply'));
    assert.deepEqual(await page.evaluate(() => window.qa.calls.slice(window.qa.groupSendStart).filter(c => c.cmd === 'pty_write').map(c => c.args.data)), ['Shared draft', '\r'], 'An agent in multiple groups receives one reply');
    await page.goto(base + '?dashboard&restore');
    await page.waitForFunction(() => window.qa.saved && document.querySelector('.dashboard-row'));
    assert.deepEqual(await page.evaluate(() => window.qa.saved.threads.flatMap(t => t.panes.map(p => p.groupIds))), memberships);
    await audit('group-restored');
    await editGroup(firstGroup);
    await members.nth(0).uncheck();
    await page.click('#agent-group-form button[type=submit]');
    await groupFilter(secondGroup).click();
    assert.equal(await page.locator(`.dashboard-card[data-group="${secondGroup}"]`).count(), 2, 'Removing one membership preserves the other');
    await deleteGroup(secondGroup);
    await audit('group-delete-confirm');
    await escape();
    assert.equal(await page.locator(`[data-key="Edit-${secondGroup}"]`).count(), 1, 'Cancel keeps the group');
    await deleteGroup(firstGroup);
    await page.click('#confirm-action');
    await groupFilter(secondGroup).click();
    assert.equal(await page.locator(`.dashboard-card[data-group="${secondGroup}"]`).count(), 2, 'Deleting a group preserves other memberships');
    await groupFilter(secondGroup).click();
    await deleteGroup(secondGroup);
    await page.click('#confirm-action');
    await page.waitForFunction(() => window.qa.saved.agentGroups.length === 0);
    assert.equal(await page.locator('.dashboard-row').count(), 4, 'Deleting groups preserves all agents');
    assert.equal(await page.locator('#dashboard-counts button[data-state=all]').getAttribute('aria-pressed'), 'true', 'Deleting the selected group returns to All');
    assert.equal(await page.locator('#dashboard-counts button[data-group]').count(), 0);
    assert.equal(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'pty_kill')), false);
    await audit('groups-deleted');
    // A card's own "add to group": start a group from the menu, then toggle it on another card.
    const addTo = id => page.locator(`.dashboard-group-add[data-key="group-${id}"]`); // By pane: the cards re-sort as agents change state.
    const [first, , third] = await page.locator('.dashboard-card').evaluateAll(cards => cards.map(c => c.dataset.pane));
    const groupsOf = () => page.evaluate(() => window.qa.saved.threads.flatMap(t => t.panes.map(p => p.groupIds?.length || 0)));
    assert.equal(await page.locator('.dashboard-group-add').count(), 4, 'Every card can be added to a group');
    await addTo(first).click();
    assert.equal(await page.locator('#menu-list .menu-item').count(), 0, 'The menu starts empty when there are no groups');
    await page.fill('#menu-add', 'Quick group');
    await page.press('#menu-add', 'Enter');
    await page.waitForFunction(() => window.qa.saved.agentGroups.length === 1 && window.qa.saved.agentGroups[0].name === 'Quick group');
    assert.equal(await page.locator('#menu-list .menu-item.on').count(), 1, 'The new group holds the agent it was made from');
    assert.equal(await addTo(first).locator('b').textContent(), '1', 'The card counts its groups');
    assert.equal(await page.locator('#pane-menu').isVisible(), true, 'The menu stays up while cards refresh');
    // Cards re-sort as agents change state, and the open menu follows its card's
    // button: one that lands below the screen must not take the menu with it.
    const moveCard = (id, margin) => page.evaluate(([id, margin]) => {
      document.querySelector(`.dashboard-group-add[data-key="group-${id}"]`).closest('.dashboard-card').style.marginTop = margin;
      dispatchEvent(new Event('resize'));
    }, [id, margin]);
    await moveCard(first, '3000px');
    const movedMenu = await page.locator("#pane-menu").boundingBox();
    assert.ok(movedMenu.y >= 0 && movedMenu.y + movedMenu.height <= page.viewportSize().height, `The menu stays on screen when its card moves off it: ${JSON.stringify(movedMenu)}`);
    await moveCard(first, '');
    await audit('group-add-menu');
    await page.fill('#menu-add', 'quick GROUP');
    await page.press('#menu-add', 'Enter');
    assert.equal(await page.evaluate(() => window.qa.saved.agentGroups.length), 1, 'A name that exists, in any case, reuses the group');
    await page.locator('#menu-list .menu-item').first().click();
    await page.waitForFunction(() => window.qa.saved.threads.every(t => t.panes.every(p => !p.groupIds?.length)));
    assert.equal(await addTo(first).locator('b').count(), 0, 'Leaving the last group clears the count');
    await escape();
    assert.equal(await page.locator('#pane-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), `group-${first}`, 'The cards were rebuilt under the open menu; Escape still hands focus to that card\'s button');
    await addTo(third).click();
    await page.locator('#menu-list .menu-item').first().click();
    await page.waitForFunction(() => window.qa.saved.threads.flatMap(t => t.panes).filter(p => p.groupIds?.length).length === 1);
    assert.equal((await groupsOf()).reduce((a, b) => a + b), 1, 'Only the chosen card joins');
    await page.click('#dashboard-counts button[data-group]');
    assert.equal(await page.locator('.dashboard-row').count(), 1, 'The group view lists what was added from the card');
    await page.click('#dashboard-counts button[data-state=all]');
    // What a card says about its agent: its groups by name, and its thread's changes.
    assert.deepEqual(await page.locator('.dashboard-tag').allTextContents(), ['Quick group'], 'A card names the groups its agent is in');
    assert.equal(await page.locator(`.dashboard-card[data-pane="${third}"] .dashboard-tag`).count(), 1, 'The group name is on the card that joined');
    await page.waitForSelector('.dashboard-stat.add');
    assert.deepEqual(await page.locator('.dashboard-card').first().locator('.dashboard-stat').allTextContents(), ['+25', '−6'], 'A card shows the changes in its thread');
    await page.fill('#dashboard-query', 'quick group');
    assert.equal(await page.locator('.dashboard-row').count(), 1, 'Search finds an agent by its group name');
    await page.fill('#dashboard-query', '');
    // Two buttons per card must not cover the card's text, or make compact cards taller than they were.
    for (const compact of [false, true]) {
      if (compact) await page.click('#dashboard-compact');
      const covered = await page.evaluate(() => [...document.querySelectorAll('.dashboard-card')].filter(card => {
        const a = card.querySelector('.dashboard-card-actions').getBoundingClientRect(), r = card.querySelector('.dashboard-row').getBoundingClientRect();
        return a.left < r.right - 1 && a.right > r.left + 1 && a.top < r.bottom - 1 && a.bottom > r.top + 1;
      }).length);
      assert.equal(covered, 0, `Card actions stay clear of the card text (${compact ? 'compact' : 'expanded'}) @${width}`);
      if (compact || width > 600) assert.ok(await page.locator('.dashboard-card').first().evaluate(el => el.getBoundingClientRect().height <= el.querySelector('.dashboard-row').getBoundingClientRect().height + 2), `The card's buttons never make it taller than its text (${compact ? 'compact' : 'expanded'}) @${width}`);
      await audit(`group-add-${compact ? 'compact' : 'expanded'}`);
    }
    await page.click('#dashboard-compact');
    // Selecting: tick cards, group them together, answer the waiting ones with one message.
    await page.goto(base + '?dashboard');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
      const qa = window.qa;
      const a = qa.panes.find(p => p.cwd.endsWith('search-polish') && !p.codexStateId), b = qa.panes.find(p => p.cwd.endsWith('review-keyboard-navigation')), c = qa.panes.find(p => p.codexStateId);
      qa.bulkIds = [a.id, b.id];
      qa.onWrite = ({ id, data }) => qa.panes.find(p => p.id === id)?.onOut.onmessage(data); // Every agent echoes what it is sent.
      a.onOut.onmessage('\x1b]9;ready\x07');
      b.onOut.onmessage('\x1b]9;ready\x07');
      c.onOut.onmessage('\x1b[2J\x1b[HWorking (3s, esc to interrupt)');
    });
    await page.click('#dashboard-btn');
    await page.waitForFunction(() => document.querySelectorAll('.dashboard-reply input').length === 2);
    assert.equal(await page.locator('#dashboard-bulk').isVisible(), false, 'The selection bar stays away until you start selecting');
    assert.equal(await page.locator('.dashboard-select:visible').count(), 0, 'Cards have no checkboxes until then');
    await page.click('#dashboard-select');
    assert.equal(await page.locator('.dashboard-select:visible').count(), 4);
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '0 selected');
    assert.equal(await page.locator('#dashboard-bulk-send').isDisabled(), true, 'Nothing ticked, nobody to answer');
    await audit('dashboard-selecting');
    const tick = text => page.locator('.dashboard-card').filter({ hasText: text }).locator('.dashboard-select');
    await tick('search-polish / claude').check();
    await tick('review-keyboard-navigation / claude').check();
    await tick('search-polish / codex').check();
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '3 selected');
    assert.equal(await page.locator('#dashboard-bulk-send').textContent(), 'Send to 2', 'The working agent is left out of the count');
    assert.match(await page.locator('#dashboard-bulk-note').textContent(), /^Left out: 1 working\. A message goes to agents that are waiting or idle\./, 'The bar says who was left out and why, even once text is typed');
    await audit('dashboard-selected');
    // Group them in one go. The menu opens on the bar without covering the button that opened it.
    await page.click('#dashboard-bulk-group');
    await page.fill('#menu-add', 'Batch');
    await page.press('#menu-add', 'Enter');
    await page.waitForFunction(() => window.qa.saved.agentGroups.length === 1 && window.qa.saved.threads.flatMap(t => t.panes).filter(p => p.groupIds?.length === 1).length === 3);
    assert.equal(await page.locator('#menu-list .menu-item.on').count(), 1, 'The group is lit when all of the selection is in it');
    const [menuBox, buttonBox] = await Promise.all([page.locator('#pane-menu').boundingBox(), page.locator('#dashboard-bulk-group').boundingBox()]);
    assert.ok(menuBox.y + menuBox.height <= buttonBox.y + 1 || menuBox.y >= buttonBox.y + buttonBox.height - 1 || menuBox.x + menuBox.width <= buttonBox.x + 1 || menuBox.x >= buttonBox.x + buttonBox.width - 1, `The menu does not cover the button that opened it @${width}: ${JSON.stringify({ menuBox, buttonBox })}`);
    await audit('dashboard-bulk-group');
    await escape();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dashboard-bulk-group', 'Esc returns to the bar');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '3 selected', 'Grouping keeps the selection');
    // Answer the waiting ones with one message.
    await page.evaluate(() => { window.qa.bulkStart = window.qa.calls.length; });
    await page.fill('#dashboard-bulk-input', 'Run the tests');
    await page.press('#dashboard-bulk-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#toast:not(.hidden)')?.textContent === 'Sent to 2 agents');
    const bulkWrites = await page.evaluate(() => window.qa.calls.slice(window.qa.bulkStart).filter(c => c.cmd === 'pty_write').map(c => [c.args.id, c.args.data]));
    const bulkIds = await page.evaluate(() => window.qa.bulkIds);
    assert.deepEqual(bulkIds.map(id => bulkWrites.filter(w => w[0] === id).map(w => w[1])), [['Run the tests', '\r'], ['Run the tests', '\r']], 'Each waiting agent gets the text, then Enter');
    assert.equal(bulkWrites.every(w => bulkIds.includes(w[0])), true, 'The working agent is not written to');
    assert.equal(await page.locator('#dashboard-bulk-input').inputValue(), '', 'A message that went everywhere is cleared');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dashboard-bulk-input', 'Focus stays in the bar');
    // X unticks the focused card, Esc leaves selecting, and the selection only ever holds what you can see.
    const cardCodex = page.locator('.dashboard-card').filter({ hasText: 'search-polish / codex' }).locator('.dashboard-row');
    await cardCodex.focus();
    await page.keyboard.press('x');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '2 selected', 'X unticks the focused card');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dashboard-bulk').isVisible(), false, 'Esc leaves selecting');
    assert.equal(await page.locator('.dashboard-select:checked').count(), 0, 'and clears the ticks');
    await page.keyboard.press('x');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '1 selected', 'X on a card starts selecting');
    await page.click('#dashboard-bulk-all');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '4 selected');
    assert.equal(await page.locator('#dashboard-bulk-all').textContent(), 'Select none');
    await page.fill('#dashboard-query', 'codex');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '1 selected', 'Cards filtered out are no longer selected');
    await page.fill('#dashboard-query', '');
    assert.equal(await page.locator('#dashboard-bulk-count').textContent(), '1 selected', 'and do not come back');
    await page.click('#dashboard-bulk-done');
    assert.equal(await page.locator('#dashboard-bulk').isVisible(), false);
    // An idle agent takes a bulk message too.
    await page.click('#dashboard-select');
    await tick('fix-settings / claude').check();
    assert.equal(await page.locator('.dashboard-row').filter({ hasText: 'fix-settings / claude' }).getAttribute('data-state'), '', 'The agent ticked here is idle');
    assert.equal(await page.locator('#dashboard-bulk-send').textContent(), 'Send to 1', 'Idle agents can take the message');
    assert.equal(await page.locator('#dashboard-bulk-note').textContent(), '', 'Nothing is left out');
    await page.evaluate(() => { window.qa.idleStart = window.qa.calls.length; });
    await page.fill('#dashboard-bulk-input', 'Any update?');
    await page.press('#dashboard-bulk-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#toast:not(.hidden)')?.textContent === 'Sent to 1 agent');
    assert.deepEqual(await page.evaluate(() => { const id = window.qa.panes.find(p => p.cwd.endsWith('tools')).id; return window.qa.calls.slice(window.qa.idleStart).filter(c => c.cmd === 'pty_write').map(c => [c.args.id === id, c.args.data]); }), [[true, 'Any update?'], [true, '\r']], 'The idle agent gets the text, then Enter, and nobody else does');
    await page.click('#dashboard-bulk-done');
    await page.goto(base + '?dashboard&many');
    await page.waitForFunction(() => window.qa.saved);
    await page.click('#dashboard-btn');
    await page.click('#dashboard-new-group');
    assert.equal(await members.count(), 40);
    await audit('group-many-agents');
    assert.equal(await page.locator('#agent-group-form button[type=submit]').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
    }), true, 'Save stays visible while the member list scrolls');
    assert.equal(await page.locator('#agent-group-members').evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('#agent-group .new-actions').getBoundingClientRect().top), true, 'Agent list must not overlap the footer');
    await page.click('#agent-group-cancel');
    await page.goto(base + '?empty');
    await page.waitForFunction(() => window.qa.saved);
    await page.click('#dashboard-btn');
    await page.click('#dashboard-new-group');
    await audit('group-no-agents');
    await page.fill('#agent-group-name', 'Future agents');
    await page.click('#agent-group-form button[type=submit]');
    await page.locator('#dashboard-counts button[data-group]').click();
    assert.equal(await page.locator('.dashboard-group h2').textContent(), 'Future agents (0)');
    // Agent overlay: off by default. On, it lists working and waiting agents while Loom is in the background.
    await page.goto(base + '?dashboard');
    await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    await page.waitForTimeout(1800);
    const overlayCalls = () => page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'overlay').map(c => c.args.show));
    assert.deepEqual(await overlayCalls(), [], 'The overlay is off by default');
    await page.click('#preferences-btn');
    await page.click('#overlay-pref');
    await page.waitForFunction(() => window.qa.saved.overlay === 'background');
    assert.equal(await page.locator('#overlay-pref').textContent(), 'in background');
    assert.deepEqual(await overlayCalls(), [false], 'Turning it on builds the overlay hidden');
    await audit('overlay-preference');
    await escape();
    await page.evaluate(() => {
      const qa = window.qa;
      qa.overlayRows = [];
      window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'overlay-rows', handler: window.__TAURI_INTERNALS__.transformCallback(e => qa.overlayRows.push(e.payload)) });
      qa.focused = false; // Loom goes to the background.
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://blur' });
      const p = qa.panes.find(p => p.cwd.endsWith('review-keyboard-navigation'));
      qa.overlayPane = p.id;
      // A permission prompt: the overlay says what it asks.
      p.onOut.onmessage('\x1b[2J\x1b[H Bash command\r\n\r\n   rm -rf build\r\n\r\n Do you want to proceed?\r\n \u276f 1. Yes\r\n   2. No (esc)\r\n\x1b]9;ready\x07');
    });
    await page.waitForFunction(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show === true);
    // The ring's output reads as work until xterm parses it, so the first rows may say working.
    await page.waitForFunction(() => window.qa.overlayRows.at(-1)?.rows[0]?.waiting);
    const sentRows = await page.evaluate(() => window.qa.overlayRows.at(-1));
    assert.deepEqual(sentRows.rows.map(r => [r.name, r.agent, r.waiting, r.time, r.ask]), [['review-keyboard-navigation', 'claude', true, 'now', 'Bash command · rm -rf build']], 'The overlay lists the waiting agent and what it asks');
    assert.ok(sentRows.vars['--panel'], 'The overlay gets the theme colours');
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-cap', payload: 300 }));
    await page.waitForFunction(() => window.qa.saved.overlayCap === 300);
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-pick', payload: window.qa.overlayPane }));
    await page.waitForSelector('#dashboard-preview[open]');
    assert.equal(await page.locator('#dashboard-preview-title').textContent(), 'review-keyboard-navigation / claude', 'A click previews that agent in the overview');
    assert.ok(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'plugin:window|set_focus')), 'A click brings Loom to the front');
    assert.equal(await page.locator('#waiting').textContent(), '1 waiting', 'Previewing keeps the alert');
    await audit('overlay-pick');
    await page.evaluate(() => ((window.qa.focused = true), window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://focus' })));
    await page.waitForFunction(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show === false);
    await page.click('#dashboard-preview-close');
    await page.evaluate(() => ((window.qa.focused = false), window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://blur' })));
    await page.waitForFunction(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show === true);
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-dismiss' }));
    await page.waitForFunction(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show === false);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show), false, 'Hidden stays hidden while Loom is away');
    await page.evaluate(() => ((window.qa.focused = true), window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://focus' })));
    // Always: up over Loom itself, and with nothing to list it says so instead of vanishing.
    await page.click('#preferences-btn');
    await page.click('#overlay-pref');
    await page.waitForFunction(() => window.qa.saved.overlay === 'always');
    await page.waitForFunction(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show === true);
    assert.equal(await page.evaluate(() => window.qa.overlayRows.at(-1).rows.length), 1, 'Always lists agents while Loom is in front');
    await page.click('#overlay-pref');
    await page.waitForFunction(() => window.qa.saved.overlay === 'off');
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'overlay').at(-1).args.show), null, 'Turning it off closes the window');
    await escape();
    // The overlay page itself: waiting and working in their own sections, the window as tall as the list.
    const overlayPage = await context.newPage();
    await overlayPage.setViewportSize({ width: 300, height: 240 });
    await overlayPage.goto(base + '/overlay.html');
    const row = (name, i, waiting, ask = '') => ({ id: `pane-${i}`, name, agent: i % 3 ? 'claude' : 'codex', waiting, time: i ? `${i}m` : 'now', ask });
    const few = { rows: [row('search-polish', 0, true, 'Bash command · rm -rf build'), row('fix-settings · 2', 1, false), row('usageOverlay', 2, false)], cap: 420, vars: {}, scheme: 'dark' };
    const lastSize = () => overlayPage.evaluate(() => JSON.parse(JSON.stringify(window.qa.calls.filter(c => c.cmd === 'plugin:window|set_size').at(-1)?.args.value ?? null))?.Logical);
    // The window follows: apply the size the page asked for, as the real window would.
    const follow = async () => { const size = await lastSize(); await overlayPage.setViewportSize({ width: 300, height: Math.round(size.height) }); return size.height; };
    await overlayPage.waitForFunction(state => {
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-rows', payload: state }); // Again until it renders: the page may not be listening yet.
      return document.querySelectorAll('.row').length > 0;
    }, few);
    assert.deepEqual(await overlayPage.locator('h2').allTextContents(), ['Waiting1', 'Working2'], 'Waiting and working are separate sections');
    assert.equal(await overlayPage.locator('.row.waiting .ask').textContent(), 'Bash command · rm -rf build', 'A waiting row says what it asks');
    const natural = await overlayPage.evaluate(() => Math.ceil(document.querySelector('header').getBoundingClientRect().height + document.querySelector('#rail').getBoundingClientRect().height + 2));
    assert.equal(Math.round((await lastSize()).height), natural, 'The window fits its list');
    await follow();
    assert.equal(await overlayPage.locator('#list').evaluate(el => el.scrollHeight <= el.clientHeight), true, 'A fitted list needs no scrolling');
    assert.equal(await overlayPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overlay: horizontal overflow');
    await overlayPage.evaluate(() => {
      window.qa.picked = [];
      window.qa.caps = [];
      const on = (event, list) => window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event, handler: window.__TAURI_INTERNALS__.transformCallback(e => list.push(e.payload)) });
      on('overlay-pick', window.qa.picked);
      on('overlay-cap', window.qa.caps);
    });
    await overlayPage.locator('.row').nth(1).click();
    await overlayPage.waitForFunction(() => window.qa.picked.length === 1);
    assert.deepEqual(await overlayPage.evaluate(() => window.qa.picked), ['pane-1'], 'A click reports that agent');
    await overlayPage.mouse.move(0, 0);
    await overlayPage.screenshot({ path: `${out}/overlay-${width}.png`, animations: 'disabled' });
    // A long list stops at the cap and scrolls.
    const many = { ...few, cap: 200, rows: [...few.rows, ...['a', 'b', 'c', 'd', 'e'].map((n, i) => row(n, i + 3, false))] };
    await overlayPage.evaluate(state => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-rows', payload: state }), many);
    await overlayPage.waitForFunction(() => document.querySelectorAll('.row').length === 8);
    assert.equal(Math.round(await follow()), 200, 'A long list stops at the cap');
    assert.equal(await overlayPage.locator('#list').evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), true, 'Past the cap, the list scrolls');
    await overlayPage.screenshot({ path: `${out}/overlay-capped-${width}.png`, animations: 'disabled' });
    // Dragging the height sets the cap once you let go.
    await overlayPage.setViewportSize({ width: 300, height: 160 });
    await overlayPage.waitForFunction(() => window.qa.caps.length === 1);
    assert.deepEqual(await overlayPage.evaluate(() => window.qa.caps), [160], 'A dragged height becomes the cap');
    await overlayPage.setViewportSize({ width: 220, height: 110 });
    assert.equal(await overlayPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overlay at its minimum size: horizontal overflow');
    await overlayPage.screenshot({ path: `${out}/overlay-min-${width}.png`, animations: 'disabled' });
    await overlayPage.setViewportSize({ width: 300, height: 240 });
    await overlayPage.evaluate(state => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'overlay-rows', payload: state }), { ...few, rows: [] });
    await overlayPage.waitForSelector('.empty');
    assert.equal(await overlayPage.locator('.empty').textContent(), 'No agents are working or waiting.', 'Always mode with nothing to list says so');
    await follow();
    await overlayPage.screenshot({ path: `${out}/overlay-empty-${width}.png`, animations: 'disabled' });
    checks += 4;
    await overlayPage.close();
    await page.goto(base + '?dashboard&needs-session');
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    await page.click('#dashboard-btn');
    await page.locator('.dashboard-row').filter({ hasText: 'search-polish / codex' }).click();
    assert.equal(await page.locator('#dashboard-process').textContent(), 'Choose session');
    await page.click('#dashboard-process');
    await page.waitForSelector('#session-picker[open]');
    await audit('dashboard-choose-session');
    await page.getByRole('button', { name: 'Saved Codex conversation', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#dashboard-process').textContent === 'Stop process');
    assert.equal(await page.locator('#dashboard-preview').isVisible(), true);
    await audit('dashboard-session-resumed');
    await escape();
    await page.goto(base + '?empty');
    await page.waitForFunction(() => window.qa.saved);
    await page.click('#dashboard-btn');
    await audit('dashboard-empty');
    assert.match(await page.locator('#dashboard-empty').textContent(), /Create a thread/);
    assert.equal(await page.locator('#dashboard-next').isDisabled(), true);
    assert.equal(await page.locator('#dashboard-back').isDisabled(), true);
    await page.click('#new-thread');
    await audit('dashboard-new-thread');
    await escape();
    assert.deepEqual(errors, [], 'No overview runtime errors');
    if (process.env.UI_DASHBOARD_ONLY) {
      console.log(`PASS dashboard ${width}px`);
      await context.close();
      continue;
    }
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    // Full-screen agents put their status line in the last terminal row.
    await page.evaluate(() => window.qa.panes.forEach(pane => {
      const { rows } = window.qa.calls.filter(c => ['pty_spawn', 'pty_resize'].includes(c.cmd) && c.args.id === pane.id).at(-1).args;
      pane.onOut.onmessage(`\x1b[${rows};1H\x1b[30;43mLast row: gjpqy\x1b[0m`);
    }));
    await page.waitForTimeout(100);
    await audit('terminal-last-row');
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    // Codex must finish even if its OSC notification is missing. Output silence
    // alone is not completion: long-running tools can leave the status visible.
    const codexOutput = text => page.evaluate(text => window.qa.panes.find(p => p.argv.join(' ').includes('codex')).onOut.onmessage(text), text);
    const codexRow = page.locator('.agent').filter({ has: page.locator('.agent-name', { hasText: /^codex$/ }) });
    await codexOutput('\x1b[2J\x1b[H' + 'Earlier output\r\n'.repeat(100) + 'Working (3s • esc to ');
    await codexOutput('interrupt)\r\n');
    await page.waitForFunction(() => [...document.querySelectorAll('.agent')].some(el => el.querySelector('.agent-name')?.textContent === 'codex' && el.dataset.state === 'busy'));
    await page.waitForTimeout(1600);
    assert.equal(await codexRow.getAttribute('data-state'), 'busy', 'A quiet working Codex is still busy');
    const statusPane = page.locator('.grid:not(.hidden) .pane').nth(1);
    const statusScreen = statusPane.locator('.xterm-screen');
    await statusScreen.scrollIntoViewIfNeeded();
    const slider = statusPane.locator('.xterm .scrollbar.vertical .slider');
    const scrollBefore = await slider.evaluate(el => parseFloat(el.style.top));
    const terminalBounds = await statusScreen.boundingBox();
    await page.mouse.move(terminalBounds.x + 30, terminalBounds.y + 40);
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(250);
    assert.ok(await slider.evaluate(el => parseFloat(el.style.top)) < scrollBefore, 'The test must scroll into terminal history');
    await codexOutput('\r');
    await page.waitForTimeout(100);
    assert.equal(await codexRow.getAttribute('data-state'), 'busy', 'Scrolling away from the live Working line must not clear busy');
    await codexOutput('\x1b[2J\x1b[HCompleted the changes.\r\nWorked for 24m 59s\r\n\r\n❯ Ask Codex to do anything');
    await page.waitForFunction(() => [...document.querySelectorAll('.agent')].some(el => el.querySelector('.agent-name')?.textContent === 'codex' && el.dataset.state === ''), null, { timeout: 1500 });
    await codexOutput('\x1b[2;3H·\x1b[4;9H✦');
    await page.waitForTimeout(100);
    assert.equal(await codexRow.getAttribute('data-state'), '', 'Codex returns to Ready without a completion notification');
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(100);
    await audit('codex-idle-without-notification');
    if (process.env.UI_CODEX_STATUS_ONLY) {
      await context.close();
      continue;
    }
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    assert.ok(await page.locator('#tabs .tab.panes').evaluate(tab => tab.getBoundingClientRect().width >= 80), 'The sidebar must not squeeze the pane tab out of view');
    // Codex uses Alt+Up to answer queued questions. It must reach the PTY.
    const codexPane = page.locator('.grid:not(.hidden) .pane').nth(1);
    await codexPane.locator('.pane-title').click();
    await codexPane.locator('.xterm-helper-textarea').focus();
    await page.evaluate(() => {
      window.qa.keyStart = window.qa.calls.length;
      window.qa.keyboardWheels = [];
      document.addEventListener('wheel', e => window.qa.keyboardWheels.push([e.deltaY, e.altKey, e.shiftKey]), true);
    });
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowDown');
    assert.deepEqual(await page.evaluate(() => window.qa.calls.slice(window.qa.keyStart).filter(c => c.cmd === 'pty_write').map(c => c.args.data)), ['\x1b[1;3A', '\x1b[1;3B'], 'Plain Alt+arrows must reach Codex unchanged');
    assert.equal(await page.evaluate(() => window.qa.keyboardWheels.length), 0, 'Codex shortcuts must not scroll Loom');
    // Normal history uses xterm's scroll API. Agent-owned full-screen views
    // need wheel reports with the shortcut modifiers removed.
    await page.evaluate(() => window.qa.panes.find(p => p.argv.join(' ').includes('codex')).onOut.onmessage('\x1b[?1049h\x1b[?1000h\x1b[?1006h'));
    await page.waitForTimeout(100);
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    assert.deepEqual(await page.evaluate(() => window.qa.keyboardWheels), [[-3, false, false], [3, false, false]], 'Alt+Shift+arrows must scroll without forwarding modifiers');
    await page.evaluate(() => window.qa.panes.find(p => p.argv.join(' ').includes('codex')).onOut.onmessage('\x1b[?1000l\x1b[?1006l\x1b[?1049l'));
    for (const zoomed of [false, true]) {
      if (zoomed) await page.keyboard.press('F2');
      for (const entry of ['toolbar', 'sidebar']) {
        if (entry === 'sidebar' && width <= 760) await page.click('#side-toggle');
        await (entry === 'toolbar' ? page.locator('#add-pane') : page.locator('.thread.on .thread-add')).click();
        await page.locator('.menu-item').filter({ hasText: /^powershell/ }).click();
        assert.equal(await page.locator('.grid:not(.hidden)').evaluate(el => el.classList.contains('zooming')), zoomed, 'Adding a pane must preserve fullscreen');
        await page.waitForFunction(() => document.activeElement.closest('.pane')?.dataset.id === window.qa.panes.at(-1).id);
        const paneAdded = page.locator('.grid:not(.hidden) .pane').last();
        assert.equal(await paneAdded.evaluate(el => el.classList.contains('zoom')), zoomed);
        assert.equal(await page.locator('.grid:not(.hidden) .pane:visible').count(), zoomed ? 1 : entry === 'toolbar' ? 3 : 4);
        const bounds = await paneAdded.boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 901, 'The new pane must be scrolled into view');
        await page.keyboard.type('pane-focus');
        assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'pty_write').slice(-10).every(c => c.args.id === window.qa.panes.at(-1).id)), true, 'Typing goes to the new pane');
        await audit(`add-pane-${entry}-${zoomed ? 'fullscreen' : 'normal'}`);
      }
      await page.goto(base);
      await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
    }
    for (const mode of ['', '?usage-weekly', '?usage-local', '?usage-error']) {
      if (mode) {
        await page.goto(base + mode);
        await page.waitForFunction(() => window.qa.saved && document.querySelector('#codex-plan svg'));
      }
      const failed = mode.includes('error');
      assert.equal(await page.locator('#plan .ico').count(), 1);
      assert.equal(await page.locator('#codex-plan .ico').count(), 1);
      assert.equal((await page.locator('#codex-plan').textContent()).trim(), failed ? '—' : mode.includes('weekly') ? '94%' : '42%', 'Codex chip shows the most-used limit, matching usageoverlayv2');
      if (mode.includes('weekly')) assert.match(await page.locator('#codex-plan').getAttribute('class'), /sev-critical/);
      for (const [id, name, url] of [['plan', 'Claude', 'https://claude.ai/settings/usage'], ['codex-plan', 'Codex', 'https://chatgpt.com/codex/settings/usage']]) {
        await page.click('#' + id);
        const site = page.locator('.plan-site');
        assert.equal(await site.getAttribute('href'), url);
        assert.equal(await site.evaluate(el => el === document.activeElement), true, 'Usage page link receives keyboard focus');
        if (id === 'codex-plan' && !mode) {
          assert.match(await page.locator('#pane-menu').textContent(), /Banked resets: 3/);
          assert.match(await page.locator('#pane-menu').textContent(), /Expires/);
          assert.match(await page.locator('#pane-menu').textContent(), /Expiry unavailable/);
        }
        if (id === 'codex-plan' && mode.includes('local')) {
          assert.match(await page.locator('#pane-menu').textContent(), /local session usage/);
          assert.doesNotMatch(await page.locator('#pane-menu').textContent(), /Banked resets/);
        }
        await audit(`${name}-usage-${mode || 'live'}`.replace('?', ''));
        await page.keyboard.press('Enter');
        assert.ok(await page.evaluate(url => window.qa.calls.some(c => c.cmd === 'plugin:opener|open_url' && c.args.url === url), url));
        await escape();
      }
    }
    // Plan usage off: no chips and no calls to either usage endpoint, relaunch included.
    const planCalls = () => page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'plan_usage' || c.cmd === 'codex_plan_usage').length);
    const chipsShown = () => page.evaluate(() => ['plan', 'codex-plan'].filter(id => getComputedStyle(document.getElementById(id)).display !== 'none').length);
    await page.click('#preferences-btn');
    await page.click('#plan-usage');
    assert.equal(await chipsShown(), 0, 'Plan usage off hides both chips');
    await audit('plan-usage-off');
    await page.waitForFunction(() => window.qa.saved?.planUsage === false);
    await page.goto(base + '?restore');
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    assert.equal(await planCalls(), 0, 'Plan usage off makes no usage calls at launch');
    assert.equal(await chipsShown(), 0);
    await page.click('#preferences-btn');
    await page.click('#plan-usage');
    await page.waitForFunction(() => document.querySelector('#codex-plan svg') && document.querySelector('#plan svg'));
    assert.equal(await planCalls(), 2, 'Turning it back on fetches both right away');
    assert.equal(await chipsShown(), 2);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    // Click the rendered terminal link, including its wrapped form on phones.
    const imagePath = 'node_modules\\.cache\\ui-check\\theme-picker-0-768.png';
    let linkRow = 0;
    // `line` clicks that many rows below the first, for text that spans rows.
    async function clickTerminalPath(path, line = 0) {
      const pane = page.locator('.grid:not(.hidden) .pane').first();
      const id = await pane.getAttribute('data-id');
      const row = linkRow++;
      await page.evaluate(({ id, path, row }) => window.qa.panes.find(p => p.id === id).onOut.onmessage('\x1b[2J\x1b[H' + '\r\n'.repeat(row) + path + '\r\n'), { id, path, row });
      await page.waitForTimeout(150);
      const size = await page.evaluate(id => window.qa.calls.filter(c => ['pty_spawn', 'pty_resize'].includes(c.cmd) && c.args.id === id).at(-1).args, id);
      const r = await pane.locator('.xterm-screen').boundingBox();
      const top = r.y + r.height / size.rows * (row + line + 0.5);
      await page.mouse.move(r.x + 1, top);
      await page.mouse.move(r.x + r.width / size.cols * 5, top);
      await page.waitForTimeout(150);
      await page.mouse.click(r.x + r.width / size.cols * 5, top);
    }
    await clickTerminalPath(imagePath);
    await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
    assert.deepEqual(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'read_image').at(-1).args), { dir: 'C:\\projects\\loom\\search-polish', path: imagePath });
    assert.equal(await page.locator('#diff-full').isVisible(), false);
    await audit('image-preview');
    const bounds = await page.locator('#diff-body img').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900, 'Image fits the preview');
    await page.click('#diff-close');
    const matches = ['loom', 'porcelain', 'screenshots with spaces'].map(folder => `C:\\projects\\loom\\search-polish\\node_modules\\.cache\\ui-check\\${folder}\\dashboard-message-sent-375.png`);
    await page.evaluate(matches => window.qa.imageMatches = matches, matches);
    for (const [i, path] of matches.entries()) {
      await clickTerminalPath('dashboard-message-sent-375.png');
      await page.waitForSelector('.image-choices button');
      assert.equal(await page.locator('.image-choices button').count(), matches.length);
      await audit('image-choices-' + i);
      const choice = page.locator('.image-choices button').nth(i);
      if (i === 1) {
        await choice.focus();
        await page.keyboard.press('Enter');
      } else await choice.click();
      await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
      assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'read_image').at(-1).args.path), path);
      await page.waitForFunction(path => window.qa.saved.threads[0].tabs.some(t => t.source.file === path), path);
      assert.equal(await page.locator('#tabs .tab:not(.panes)').count(), 1, 'Selection reuses the image tab');
      await audit('image-choice-open-' + i);
      await page.click('#diff-close');
    }
    for (const homePath of ['~\\AppData\\Local\\Temp\\opencode\\g375.png', '~/AppData/Local/Temp/opencode/g375b.png']) {
      await clickTerminalPath(homePath);
      await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
      const actualPath = await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'read_image').at(-1).args.path);
      assert.equal(actualPath.replaceAll('/', '\\'), 'C:\\Users\\test\\' + homePath.slice(2).replaceAll('/', '\\'));
      await audit('image-preview-home-' + (homePath.includes('g375b') ? 'slash' : 'backslash'));
      await page.click('#diff-close');
    }
    // Claude Code breaks a path longer than its box onto indented rows of its
    // own; clicking a continuation row still opens the whole path.
    const cols = await page.evaluate(() => {
      const id = document.querySelector('.grid:not(.hidden) .pane').dataset.id;
      return window.qa.calls.filter(c => ['pty_spawn', 'pty_resize'].includes(c.cmd) && c.args.id === id).at(-1).args.cols;
    });
    const deep = '~\\AppData\\Local\\Temp\\claude\\' + 'scratchpad-'.repeat(Math.ceil(2 * cols / 11)) + '\\shots\\fight-3boss-1280.png';
    await clickTerminalPath('● Reading ' + deep.slice(0, cols - 10) + '\r\n  ' + deep.slice(cols - 10, 2 * cols - 12) + '\r\n  ' + deep.slice(2 * cols - 12), 1);
    await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
    assert.equal((await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'read_image').at(-1).args.path)).replaceAll('/', '\\'), 'C:\\Users\\test\\' + deep.slice(2));
    await audit('image-preview-claude-wrap');
    await page.click('#diff-close');
    // Alternate-screen rows can retain their old length after the window shrinks.
    const activeId = await page.locator('.grid:not(.hidden) .pane').first().getAttribute('data-id');
    await page.evaluate(id => window.qa.panes.find(p => p.id === id).onOut.onmessage('\x1b[?1049h'), activeId);
    await page.setViewportSize({ width: width + 160, height: 900 });
    await page.waitForTimeout(250);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    const scratchImage = 'C:\\Users\\ayoub\\AppData\\Local\\Temp\\claude\\C--Users-ayoub-Videos-claude-fun-game-website\\f26b5a3e-41bf-40bf-822a-e80df8a49ddb\\scratchpad\\shots\\nat_big_spirit.png';
    linkRow = 0;
    await clickTerminalPath(scratchImage, 1);
    await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'read_image').at(-1).args.path), scratchImage, 'Resizing must not insert spaces into the image path');
    await audit('image-preview-resized-path');
    await page.click('#diff-close');
    await page.evaluate(id => window.qa.panes.find(p => p.id === id).onOut.onmessage('\x1b[?1049l'), activeId);
    await page.evaluate(() => window.qa.failImage = true);
    await clickTerminalPath('"C:\\My Pictures\\missing image.png"');
    await page.waitForFunction(() => document.querySelector('#diff-body').textContent.includes('Image file not found')).catch(async e => {
      console.error(await page.evaluate(() => ({ calls: window.qa.calls.filter(c => ['read_image', 'open_vscode', 'pty_resize'].includes(c.cmd)), text: document.querySelector('#diff-body').textContent })));
      await page.screenshot({ path: `${out}/image-link-failure-${width}.png` });
      throw e;
    });
    await audit('image-preview-error');
    await page.click('#diff-close');
    const editorCalls = await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'open_vscode').length);
    for (const path of ['src/main.ts:12', '~\\src\\main.ts:12:3', 'C:\\Users\\test\\src\\main.ts:12', '/C:/Users/test/src/main.ts:473']) {
      await clickTerminalPath(path);
      assert.equal(await page.locator('.grid:not(.hidden) .pane').first().locator('.xterm').evaluate(el => el.classList.contains('xterm-cursor-pointer')), false, 'Ordinary file paths are not links');
      assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'open_vscode').length), editorCalls, 'Clicking a file path must not launch VS Code');
      assert.equal(await page.locator('#diff').isVisible(), false, 'Clicking a file path leaves the terminal visible');
    }
    await audit('terminal-file-paths');
    if (process.env.UI_IMAGE_ONLY) {
      await context.close();
      continue;
    }
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    // Exercise every palette through the UI, including light -> dark -> default.
    if (!process.env.UI_THEME) {
      const openThemes = async () => { await page.click('#preferences-btn'); await page.click('#theme'); };
      await openThemes();
      const palettes = await page.locator('.theme-card').evaluateAll(rows => rows.map(row => ({
        label: row.querySelector('.theme-caption').firstChild.textContent,
        bg: row.querySelector('.theme-preview').style.getPropertyValue('--bg'),
        accent: row.querySelector('.theme-preview').style.getPropertyValue('--accent'),
      })));
      assert.equal(palettes.length, 39);
      assert.deepEqual(palettes.find(p => p.label === 'loom classic'), { label: 'loom classic', bg: '#0a0f1b', accent: '#d97757' }, 'The original navy and copper palette stays available');
      await escape();
      for (const [i, palette] of [...palettes, palettes[0]].entries()) {
        await openThemes();
        const card = page.locator('#menu-list').getByRole('button', { name: `${palette.label},`, exact: false });
        await card.focus();
        await page.keyboard.press(i % 2 ? 'Space' : 'Enter');
        await page.waitForFunction(label => window.qa.saved.theme === label, palette.label);
        const colors = await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement);
          return Object.fromEntries(['--bg', '--accent', 'color-scheme'].map(k => [k, css.getPropertyValue(k).trim()]));
        });
        assert.equal(colors['--bg'], palette.bg);
        assert.equal(colors['--accent'], palette.accent);
        assert.equal(colors['color-scheme'], ['paper', 'porcelain', 'latte', 'solarized light', 'polar', 'sakura'].includes(palette.label) ? 'light' : 'dark');
        const lowContrast = await page.evaluate(classic => {
          const css = getComputedStyle(document.documentElement);
          const luminance = key => {
            const hex = css.getPropertyValue('--' + key).trim();
            const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
              .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return rgb.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          };
          // Loom classic and Graphite retain their original colors by design.
          const roles = classic ? ['text', 'muted'] : ['text', 'muted', 'faint', 'accent', 'ok', 'err', 'warn', 'blue', 'magenta', 'cyan'];
          return ['bg', 'panel', 'raise'].flatMap(bg =>
            roles.filter(fg => {
              const [a, b] = [luminance(bg), luminance(fg)].sort((x, y) => x - y);
              return (b + 0.05) / (a + 0.05) < 4.5;
            }).map(fg => `${fg} on ${bg}`));
        }, ['loom classic', 'graphite'].includes(palette.label));
        assert.deepEqual(lowContrast, [], palette.label + ' text contrast');
        await audit(`theme-${i}`);
        await openThemes();
        assert.equal(await page.locator('.theme-card[aria-pressed=true]').count(), 1);
        assert.equal(await page.locator('#menu-list').getByRole('button', { name: `${palette.label},`, exact: false }).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.theme-preview').first().evaluate(el => el.style.getPropertyValue('--bg')), palettes[0].bg, 'Default preview must not inherit the selected theme');
        await audit(`theme-picker-${i}`);
        await escape();
      }
      await openThemes();
      await page.getByRole('button', { name: 'porcelain, light theme', exact: true }).click();
      await page.waitForFunction(() => window.qa.saved.theme === 'porcelain');
      await page.goto(base + '?restore');
      await page.waitForFunction(() => window.qa.saved?.theme === 'porcelain');
      assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'light');
      await openThemes();
      await page.getByRole('button', { name: 'loom, dark theme', exact: true }).click();
      await page.waitForFunction(() => window.qa.saved.theme === 'loom');
      await page.goto(base);
      await page.waitForFunction(() => window.qa.panes.length === 4 && window.qa.saved);
      await page.waitForTimeout(250);
    }
    // Language and prefix sit beside Speak, showing what the next dictation will use.
    for (const id of ['lang', 'prefix', ...(width > 760 ? ['layout'] : [])]) {
      assert.equal(await page.locator('#strip #' + id).isVisible(), true, id + ' must be visible in the thread strip');
    }
    // Stacked panes have no grid layout to change, so the narrow strip leaves it out.
    if (width <= 760) assert.equal(await page.locator('#layout').isVisible(), false, 'The layout button hides where panes stack');
    assert.match(await page.locator('#prefix').textContent(), /\/prompt/, 'The prefix in use is shown without opening anything');
    assert.equal(await page.locator('#switch-thread').count(), 0);
    if (width <= 760) await page.click('#side-toggle');
    await audit('sidebar-hierarchy');
    const target = page.locator('.thread').filter({ has: page.locator('.thread-select', { hasText: 'review-keyboard-navigation' }) });
    await target.locator('.fold').click();
    for (const command of ['opencode', 'powershell']) {
      if (width <= 760 && !await page.locator('#side').isVisible()) await page.click('#side-toggle');
      await target.locator('.thread-add').focus();
      await page.keyboard.press('Enter');
      await audit('thread-add-' + command);
      if (command === 'powershell' && width <= 760) {
        for (const pane of await page.locator('.grid:not(.hidden) .pane').all()) {
          await pane.scrollIntoViewIfNeeded();
          await page.waitForFunction(el => {
            const screen = el.querySelector('.xterm-screen'), host = el.querySelector('.pane-term');
            return !screen || screen.getBoundingClientRect().right <= host.getBoundingClientRect().right + 0.5;
          }, await pane.elementHandle(), { timeout: 2000 }).catch(() => assert.fail(`A stacked pane refits when it scrolls into view @${width}`));
        }
      }
      if (command === 'opencode') assert.equal(await page.locator('#wsname').textContent(), 'search-polish', 'Opening the picker does not switch threads');
      assert.equal(await page.locator('.thread-add').count(), 3);
      await page.locator('.menu-item').filter({ hasText: new RegExp('^' + command) }).locator('span').first().click();
      await page.waitForFunction(n => window.qa.saved.threads[1].panes.length === n, command === 'opencode' ? 2 : 3);
      assert.equal(await page.locator('#wsname').textContent(), 'review-keyboard-navigation');
      assert.equal(await target.locator('.fold').getAttribute('aria-expanded'), 'true');
    }
    assert.deepEqual(await page.evaluate(() => window.qa.saved.threads.map(t => t.panes.map(p => p.cmd))), [['claude', 'codex'], ['claude', 'opencode', ''], ['claude']]);
    assert.ok(await page.evaluate(() => window.qa.panes.slice(-2).every(p => p.cwd.endsWith('review-keyboard-navigation'))), 'Spawn in the selected thread folder');
    if (width <= 760) await page.click('#side-toggle');
    // Its thread is folded now that another one is current: the pip opens the same pane.
    await page.locator('.pip[title^="codex"]').first().click();
    await page.locator('.grid:not(.hidden) .xterm-helper-textarea').last().focus();
    await page.keyboard.type('x');
    await page.evaluate(() => {
      const codex = window.qa.panes.find(p => p.argv.join(' ').includes('codex'));
      codex.onOut.onmessage('Working (26s • esc to ');
      codex.onOut.onmessage('interrupt)\r\n');
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.agent')].find(el => el.querySelector('.agent-name')?.textContent === 'codex')?.dataset.state === 'busy');
    if (width <= 760) await page.click('#side-toggle');
    await page.evaluate(() => window.qa.panes.forEach((p, i) => p.onOut.onmessage('\x1b]0;' + (i === 5 ? 'Terminal\x07\x1b]133;C' : ['◐', '⠙', '✳'][i % 3] + ' Agent session') + '\x07Working (3s • esc to interrupt)\r\n')));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=busy]').length === 6);
    assert.equal(await page.locator('.agent-title').filter({ hasText: /[◐⠙✳]/ }).count(), 0, 'Provider titles do not duplicate the spinner');
    // Folded threads show their agents as pips; every pip carries the working state.
    assert.equal(await page.locator('.pip[data-state=busy]').count(), 6, 'Every folded agent shows as working on its pip');
    // The spinner is a strip of frames, one per line; the spin clock's --spin on #threads picks
    // the line. Set it by hand inside one task, so a clock tick can't land between set and read.
    const frames = await page.locator('.agent-title:visible').evaluateAll(labels => [0, 1].map(frame => {
      document.querySelector('#threads').style.setProperty('--spin', String(frame));
      return labels.map(label => {
        const strip = label.parentElement.querySelector('.agent-spin > span');
        const line = Math.round(-new DOMMatrix(getComputedStyle(strip).transform).m42 / (strip.offsetHeight / 10));
        return strip.textContent.split('\n')[line];
      });
    }));
    assert.ok(frames[0].length && frames[0].every(frame => frame === '⠋') && frames[1].every(frame => frame === '⠙'), `Every listed agent and CLI shows the braille spinner before its session title: ${JSON.stringify(frames)}`);
    await audit('all-agents-working'); // before the waits below: Claude reads as ready 1.5 s after its output stops
    // The clock steps while Loom is in front, and stops behind another app and under reduced
    // motion. No CSS animation runs: one keeps the window redrawing at the display's rate.
    const spin = () => page.evaluate(() => document.querySelector('#threads').style.getPropertyValue('--spin'));
    const spinning = async () => { const a = await spin(); await page.waitForTimeout(400); return a !== await spin(); };
    assert.ok(await spinning(), 'The spin clock steps while agents work');
    // An infinite animation never finishes, so the wait is capped and the list below names it.
    await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, 6000))]));
    assert.deepEqual(await page.evaluate(() => document.getAnimations().map(a => a.animationName)), [], 'Working agents run no CSS animation once the start flourishes end');
    await page.evaluate(() => (window.qa.focused = false));
    await page.waitForTimeout(1300); // readFocus polls once a second
    assert.equal(await spinning(), false, 'The spinner holds still while Loom is behind another app');
    await page.evaluate(() => (window.qa.focused = true));
    await page.waitForTimeout(1300);
    assert.ok(await spinning(), 'The spinner resumes when Loom comes back to the front');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await spinning(), false, 'Reduced motion stops the spinner');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x1b]133;D\x07')));
    await page.waitForFunction(() => !document.querySelector('.agent[data-state=busy]'));
    // Codex's idle prompt animates: output without its working line must not read as busy.
    await page.evaluate(() => window.qa.panes.filter(p => p.argv.join(' ').includes('codex')).forEach(p => { p.onOut.onmessage('\x1b[2;3H·\x1b[4;9H✦'); p.onOut.onmessage('\x1b[2;3H \x1b[5;1H·'); }));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.agent[data-state=busy]').count(), 0, 'Idle codex redraws must not show as working');
    assert.equal(await spinning(), false, 'Ready agents stop the spin clock');
    assert.ok(await page.locator('.agent-title').evaluateAll(labels => labels.every(label => getComputedStyle(label, '::before').content === '"· "')), 'Ready agents show the plain separator');
    await audit('all-agents-ready');
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x07')));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 6);
    assert.deepEqual(await page.evaluate(() => document.querySelector('#waiting').getAnimations({ subtree: true }).map(a => [a.animationName, a.effect.getTiming().iterations])), [['beacon', 3]], 'The waiting beacon pulses three times, not forever');
    await audit('all-agents-waiting');
    // Sound and taskbar notifications can be enabled independently.
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    const flashes = () => page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'plugin:window|request_user_attention' && c.args.value?.type === 'Informational').length);
    await page.evaluate(async () => {
      window.qa.focused = false; // The native window, not document.hasFocus().
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://blur' });
      window.qa.panes[0].onOut.onmessage('\x07');
    });
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 1);
    assert.equal(await page.evaluate(() => window.qa.beeps), 1, 'A wake chimes by default');
    assert.equal(await flashes(), 1, 'A wake while unfocused flashes the taskbar by default');
    await page.click('#preferences-btn');
    await audit('notifications-both');
    await page.click('#notification-sound');
    await page.waitForFunction(() => window.qa.saved.soundEnabled === false && window.qa.saved.taskbarEnabled === true);
    assert.equal(await page.locator('#notification-sound').getAttribute('aria-pressed'), 'false');
    await audit('notifications-taskbar-only');
    await page.evaluate(() => window.qa.panes[1].onOut.onmessage('\x07'));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 2);
    assert.equal(await page.evaluate(() => window.qa.beeps), 1, 'Disabling sound must stop chimes');
    assert.equal(await flashes(), 2, 'Disabling sound must leave taskbar flashing enabled');
    await page.click('#notification-taskbar');
    await page.waitForFunction(() => window.qa.saved.soundEnabled === false && window.qa.saved.taskbarEnabled === false);
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'plugin:window|request_user_attention').at(-1).args.value), null, 'Disabling taskbar flashing clears an active flash');
    await audit('notifications-off');
    await page.evaluate(() => window.qa.panes[2].onOut.onmessage('\x07'));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 3);
    assert.equal(await page.evaluate(() => window.qa.beeps), 1);
    assert.equal(await flashes(), 2);
    await page.click('#notification-sound');
    await page.waitForFunction(() => window.qa.saved.soundEnabled === true && window.qa.saved.taskbarEnabled === false);
    await audit('notifications-sound-only');
    await page.evaluate(() => window.qa.panes[3].onOut.onmessage('\x07'));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 4);
    assert.equal(await page.evaluate(() => window.qa.beeps), 2, 'Sound can be enabled without taskbar flashing');
    assert.equal(await flashes(), 2);
    await page.goto(base + '?restore');
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    assert.equal(await page.locator('#notification-sound').getAttribute('aria-pressed'), 'true', 'Sound preference survives relaunch');
    assert.equal(await page.locator('#notification-taskbar').getAttribute('aria-pressed'), 'false', 'Taskbar preference survives relaunch independently');
    await page.click('#preferences-btn');
    await page.click('#notification-sound');
    await page.click('#notification-taskbar');
    await page.waitForFunction(() => window.qa.saved.soundEnabled === false && window.qa.saved.taskbarEnabled === true);
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.saved);
    assert.equal(await page.locator('#notification-sound').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#notification-taskbar').getAttribute('aria-pressed'), 'true');
    for (const silent of [true, false]) {
      await page.evaluate(silent => {
        const saved = JSON.parse(localStorage.getItem('qa-state'));
        delete saved.soundEnabled;
        delete saved.taskbarEnabled;
        saved.silent = silent;
        localStorage.setItem('qa-state', JSON.stringify(saved));
      }, silent);
      await page.goto(base + '?restore');
      await page.waitForFunction(() => window.qa.saved);
      assert.equal(await page.locator('#notification-sound').getAttribute('aria-pressed'), String(!silent), 'Migrate legacy sound setting');
      assert.equal(await page.locator('#notification-taskbar').getAttribute('aria-pressed'), String(!silent), 'Migrate legacy taskbar setting');
      assert.equal(await page.evaluate(() => 'silent' in window.qa.saved), false, 'Save only the independent preferences');
    }
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    if (width <= 760) await page.click('#side-toggle');
    assert.ok(await page.locator('.thread-top button').evaluateAll((buttons, min) => buttons.every(b => b.getBoundingClientRect().width >= min && b.getBoundingClientRect().height >= min), width <= 760 ? 32 : 24));
    const sidebarCollisions = () => page.locator('#side').evaluate(side => {
      const failures = [];
      for (const row of side.querySelectorAll('.thread-top')) {
        const name = row.querySelector('.thread-select').getBoundingClientRect();
        if (!name.width) continue;
        const tools = row.querySelector('.thread-tools').getBoundingClientRect();
        const meta = row.querySelector('.thread-meta').getBoundingClientRect();
        if (row.closest('.thread').classList.contains('listed')) {
          if (name.right > meta.left || meta.right > tools.left || Math.abs(name.top - tools.top) > 1) failures.push('expanded header overlaps');
        } else if (name.right > tools.left || meta.top < name.bottom) failures.push('collapsed header overlaps');
      }
      for (const row of side.querySelectorAll('.agent')) {
        if (!row.getBoundingClientRect().height) continue;
        const name = row.querySelector('.agent-name').getBoundingClientRect();
        const title = row.querySelector('.agent-title').getBoundingClientRect();
        if (name.right > title.left || title.top >= name.bottom || row.getBoundingClientRect().height > parseFloat(getComputedStyle(row).getPropertyValue('--tap'))) failures.push('agent row must stay compact on one line, no taller than a tap target');
      }
      return failures;
    });
    assert.deepEqual(await sidebarCollisions(), []);
    await page.locator('.thread-top').first().hover();
    await audit('sidebar-compact-hover');
    const currentThread = page.locator('.thread.on');
    await currentThread.locator('.fold').click();
    assert.equal(await currentThread.locator('.agents').isVisible(), false);
    assert.equal(await currentThread.locator('.pips').isVisible(), true);
    assert.deepEqual(await sidebarCollisions(), []);
    await audit('thread-collapsed');
    await currentThread.locator('.fold').click();
    assert.equal(await currentThread.locator('.agents').isVisible(), true);
    assert.equal(await currentThread.locator('.pips').isVisible(), false);
    assert.deepEqual(await sidebarCollisions(), []);
    await audit('thread-expanded');
    if (width > 760) {
      await page.evaluate(() => document.documentElement.style.setProperty('--side-w', '240px'));
      assert.deepEqual(await sidebarCollisions(), [], 'Existing saved sidebar widths must still work');
      await audit('sidebar-saved-width');
      await page.evaluate(() => document.documentElement.style.removeProperty('--side-w'));
    }
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
    // The project header's own "+" opens the dialog preset to that repo, in worktree mode, without folding the project.
    await page.locator('.repo').nth(1).hover();
    await audit('project-add-hover');
    await page.locator('.repo').nth(1).locator('button').click();
    assert.equal(await page.locator('#new-repo').inputValue(), 'C:\\projects\\tools');
    assert.equal(await page.locator('input[name="thread-mode"]:checked').inputValue(), 'worktree');
    assert.equal(await page.locator('#new-go').textContent(), 'Create worktree');
    await audit('project-add-dialog');
    await page.click('#new-cancel');
    if (width <= 760) await page.click('#side-toggle'); // cancel is outside the sidebar overlay, which closes it
    assert.equal(await page.locator('.repo').nth(1).getAttribute('aria-expanded'), 'true');
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
    // Ctrl+K, even from inside a terminal: every agent, the ones still waiting first.
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#thread-picker[open]');
    const rank = { waiting: 0, busy: 1, '': 2, dead: 3 };
    const states = await page.locator('.picker-row').evaluateAll(rows => rows.map(r => r.dataset.state));
    assert.equal(states.length, 4, 'Ctrl+K lists every agent, not only the waiting ones');
    assert.equal(states.filter(s => s === 'waiting').length, 3);
    assert.deepEqual(states, [...states].sort((a, b) => rank[a] - rank[b]), 'Waiting agents lead the list');
    await audit('go-to-agent');
    await escape();
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
        await page.click('#theme');
      } else {
        await page.click('#' + id);
      }
      await audit(id + '-menu');
      if (id !== 'theme') {
        await page.locator('.menu-item').nth(1).locator('span').first().click();
        // save() is throttled to one write per 300 ms, so the pick lands a moment later.
        await page.waitForFunction(key => window.qa.saved[key] === 1, id, { timeout: 5000 }).catch(() => assert.fail(id + ' selection must be saved'));
        await audit(id + '-selected');
      }
      await escape();
    }
    if (width > 760) {
      await page.click('#layout');
      assert.match(await page.locator('#layout').textContent(), /grid/);
      await escape();
      await audit('layout-grid');
      await page.click('#layout');
      assert.match(await page.locator('#layout').textContent(), /rows/);
      await escape();
      await page.waitForFunction(() => [...document.querySelectorAll('.grid:not(.hidden) .pane')].every(pane => {
        const screen = pane.querySelector('.xterm-screen');
        return !screen || screen.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom - 4;
      }), null, { timeout: 1500 });
      await audit('layout-rows');
    }
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
    // Deleting a worktree names what exists nowhere else before it goes.
    const deleteDetail = async () => {
      await page.click('#wsmore');
      await page.locator('.menu-item').filter({ hasText: /^Delete worktree and branch/ }).click();
      await page.waitForSelector('#confirm[open]');
      return page.textContent('#confirm-detail');
    };
    await page.evaluate(() => { window.qa.unmerged = '2'; window.qa.ignored = '!! .env\0!! node_modules/\0'; });
    const risky = await deleteDetail();
    assert.match(risky, /3 uncommitted files will be deleted/);
    assert.match(risky, /2 ignored files or folders will be deleted: \.env, node_modules\//);
    assert.match(risky, /2 commits exist only on loom\//);
    await audit('confirm-delete-worktree');
    await page.click('#confirm button[value=cancel]');
    await page.evaluate(() => { window.qa.unmerged = '0'; window.qa.clean = true; delete window.qa.ignored; });
    assert.doesNotMatch(await deleteDetail(), /⚠/);
    await page.click('#confirm button[value=cancel]');
    // A clean tree's only copy of a file can be an ignored one: the dialog names it.
    await page.evaluate(() => { window.qa.ignored = '!! notes/private.md\0'; });
    assert.match(await deleteDetail(), /1 ignored file or folder will be deleted: notes\/private\.md/);
    // It changes while the dialog is open: confirming then closes nothing.
    const openThread = await page.textContent('#wsname');
    await page.evaluate(() => { window.qa.ignored = '!! notes/private.md\0!! notes/second.md\0'; });
    await page.click('#confirm-action');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#wsname'), openThread, 'The thread is still open');
    await page.evaluate(() => { delete window.qa.unmerged; window.qa.clean = false; delete window.qa.ignored; });
    assert.ok(!(await page.evaluate(() => window.qa.calls.some(c => c.cmd === 'git_run' && c.args.args[1] === 'remove'))), 'Cancel must not remove anything');
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
    await page.click('#changes-close'); // under 760px the panel covers the diff
    // The overview ruler: one mark per run of changed rows, the removal above the addition.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#diff-ruler i')].map(m => [m.className, parseFloat(m.style.top) < 100])), [['del', true], ['add', true]]);
    assert.ok(await page.evaluate(() => { const [d, a] = document.querySelectorAll('#diff-ruler i'); return d.getBoundingClientRect().top < a.getBoundingClientRect().top; }), 'Ruler marks keep row order');
    await page.evaluate(() => window.qa.longDiff = true);
    await page.click('#diff-full');
    await page.waitForFunction(() => document.querySelector('#diff-body').textContent.includes('context line one') && window.qa.saved.ui.diffFull);
    await audit('diff-full');
    assert.ok(await page.evaluate(() => {
      const body = document.querySelector('#diff-body');
      const ruler = document.querySelector('#diff-ruler').getBoundingClientRect();
      return body.scrollHeight > body.clientHeight && body.getBoundingClientRect().right <= ruler.left;
    }), 'Diff markers must have their own strip outside the scrollbar');
    const scroll = await page.locator('#diff-body').boundingBox();
    await page.mouse.move(scroll.x + scroll.width - 7, scroll.y + 30);
    await page.mouse.down();
    await page.mouse.move(scroll.x + scroll.width - 7, scroll.y + scroll.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#diff-body').scrollTop > 0);
    await audit('diff-scrolled');
    await page.evaluate(() => window.qa.longDiff = false);
    await page.click('#diff-full');
    await page.waitForFunction(() => !document.querySelector('#diff-body').textContent.includes('context line one'));
    // Once the file has no changes left, its diff tab closes on the next re-read.
    await page.evaluate(() => { window.qa.clean = true; });
    await page.click('#changes-btn');
    await page.click('#panel-files');
    await page.click('#panel-changes');
    await page.waitForFunction(() => !document.querySelector('#tabs .tab[title="main.ts (diff)"]') && document.querySelector('#diff').classList.contains('hidden'));
    await page.evaluate(() => { window.qa.clean = false; });
    await page.click('#panel-files');
    await page.click('#panel-changes');
    await page.waitForSelector('#changes-body .file');
    await page.click('#changes-close');
    await page.click('#changes-btn');
    await page.click('#panel-files');
    await page.waitForFunction(() => document.querySelectorAll('#changes-body .dir').length === 1 && window.qa.saved.ui.panel === 'files');
    assert.equal(await page.locator('#commit-msg').isVisible(), false, 'Files tab hides the commit box');
    await audit('files');
    await page.locator('#changes-body .dir').click();
    await page.waitForFunction(() => document.querySelectorAll('#changes-body .file').length === 4);
    await page.locator('#changes-body .dir').filter({ hasText: 'ui' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#changes-body .file').length === 5);
    const indent = await page.locator('#changes-body .file').filter({ hasText: 'menu.ts' }).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
    assert.ok(indent >= 36, `A file two folders deep must sit indented, got ${indent}px`);
    await audit('files-open');
    await page.locator('#changes-body .changes-h a').filter({ hasText: 'Collapse all' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#changes-body .dir').length === 1 && document.querySelectorAll('#changes-body .file').length === 2);
    await page.locator('#changes-body .dir').click();
    await page.locator('#changes-body .dir').filter({ hasText: 'ui' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#changes-body .file').length === 5);
    await page.locator('#changes-body .file').filter({ hasText: 'main.ts' }).click();
    await page.waitForFunction(() => document.querySelector('#diff-body').textContent.includes('answer = 42') && document.querySelector('#diff-body').textContent.includes('src/main.ts'));
    assert.equal(await page.locator('#diff-full').isVisible(), false, 'A file tab has no hunk mode');
    assert.equal(await page.locator('#tabs .tab.on > span').textContent(), 'main.ts');
    await audit('file-tab');
    await page.locator('#changes-body .file').filter({ hasText: 'preview.png' }).click();
    await page.waitForFunction(() => document.querySelector('#diff-body img')?.naturalWidth === 1600);
    await page.click('#changes-close');
    await audit('file-image-preview');
    await page.click('#changes-btn');
    await page.click('#panel-changes');
    await page.waitForSelector('#changes-body .changes-h');
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
    // The open list repaints once per frame, however many panes changed.
    await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 1, null, { timeout: 1000 }).catch(() => {});
    assert.equal(await page.locator('.picker-row').count(), 1, 'An exited pane must leave the waiting list within a frame');
    await escape();
    await page.keyboard.press('F3');
    assert.equal(await page.locator('#waiting').isVisible(), false);
    await page.click('#new-thread');
    await audit('new-checkout');
    await page.check('input[value=worktree]');
    await page.fill('#new-name', 'keyboard-pass');
    await audit('new-worktree');
    const unthemedOptions = await page.locator('#new select').evaluateAll(selects => {
      const css = getComputedStyle(document.documentElement);
      const rgb = token => {
        const hex = css.getPropertyValue(token).trim();
        return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      };
      return selects.flatMap(select => [select, ...select.options]).filter(el => {
        const style = getComputedStyle(el);
        return style.backgroundColor !== rgb('--panel') || style.color !== rgb('--text');
      }).map(el => el.id || el.textContent);
    });
    assert.deepEqual(unthemedOptions, [], 'Native selects and their options must use opaque theme colors');
    await page.locator('#new-agent').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await audit('new-agent-dropdown');
    await escape();
    assert.equal(await page.locator('#new').evaluate(dialog => dialog.open), true, 'Escape closes the dropdown before the dialog');
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
    // Right-click pastes into a Claude pane whether or not Claude Code has mouse tracking on, and the click never reaches the pty.
    await page.evaluate(() => { navigator.clipboard.readText = async () => 'pasted text'; });
    const claudePane = page.locator('.grid:not(.hidden) .pane').first();
    const pasted = () => page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'pty_write' && c.args.data.includes('pasted text')).length);
    await claudePane.locator('.pane-term').click({ button: 'right' });
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'pty_write' && c.args.data.includes('pasted text')), null, { timeout: 5000 })
      .catch(() => assert.fail('Right-click must paste into a Claude pane without mouse tracking'));
    const before = await pasted();
    await page.evaluate(id => window.qa.panes.find(p => p.id === id).onOut.onmessage('\x1b[?1000h'), await claudePane.getAttribute('data-id'));
    await claudePane.locator('.pane-term').click({ button: 'right' });
    await page.waitForFunction(n => window.qa.calls.filter(c => c.cmd === 'pty_write' && c.args.data.includes('pasted text')).length === n + 1, before, { timeout: 5000 })
      .catch(() => assert.fail('Right-click must paste once into a Claude pane with mouse tracking on'));
    assert.ok(await page.evaluate(() => !window.qa.calls.some(c => c.cmd === 'pty_write' && /\x1b\[(M|<)/.test(c.args.data))), 'The right click must not reach the agent as a mouse report');
    if (width <= 760) await page.click('#side-toggle');
    const source = await page.locator('.thread-select').filter({ hasText: 'search-polish' }).boundingBox();
    const targetBounds = await page.locator('.thread').filter({ has: page.locator('.thread-select', { hasText: 'review-keyboard-navigation' }) }).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, targetBounds.y + targetBounds.height - 8, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => window.qa.saved.threads[0].name === 'review-keyboard-navigation', null, { timeout: 5000 })
      .catch(() => assert.fail('Thread-name buttons must still support drag-to-reorder'));
    // Agent rows drag within their thread; the pane grid and saved order follow.
    const agentRows = page.locator('.thread').filter({ has: page.locator('.thread-select', { hasText: 'search-polish' }) }).locator('.agent');
    const codex = await agentRows.nth(1).boundingBox();
    const claude = await agentRows.nth(0).boundingBox();
    await page.mouse.move(codex.x + codex.width / 2, codex.y + codex.height / 2);
    await page.mouse.down();
    await page.mouse.move(codex.x + codex.width / 2, claude.y + 3, { steps: 10 });
    await audit('agent-drag');
    await page.mouse.up();
    await page.waitForFunction(() => window.qa.saved.threads.find(t => t.name === 'search-polish').panes.map(p => p.cmd).join() === 'codex,claude,claude,claude', null, { timeout: 5000 })
      .catch(() => assert.fail('Agent rows must drag-to-reorder within their thread'));
    assert.equal(await agentRows.first().locator('.agent-name').textContent(), 'codex');
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
      window.qa.sessions.push([codex[0].id, '11111111-2222-4333-8444-555555555555'], [codex[1].id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    });
    await page.waitForFunction(() => window.qa.saved.threads[0].panes.every(p => p.sessionId));
    const codexStateIds = await page.evaluate(() => window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex')).map(p => p.codexStateId));
    assert.equal(new Set(codexStateIds).size, 2, 'Concurrent Codex panes must have separate SQLite directories');
    assert.ok(codexStateIds.every(Boolean));
    await page.goto(base + '?restore');
    await page.waitForFunction(() => window.qa.panes.length === 4);
    assert.deepEqual(await page.evaluate(() => window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex')).map(p => p.codexStateId)), codexStateIds, 'Restored panes must reuse their persistent SQLite directories');
    const restored = await page.evaluate(() => window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex')).map(p => p.argv.at(-1)));
    assert.ok(restored.some(c => c.includes('resume 11111111-2222-4333-8444-555555555555')));
    assert.ok(restored.some(c => c.includes('resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')));
    assert.ok(restored.every(c => !c.includes('--last') && !c.includes('||')));
    await page.goto(base + '?stale-codex');
    await page.waitForSelector('.resume-notice');
    assert.equal(await page.evaluate(() => window.qa.panes.some(p => p.argv.at(-1).startsWith('codex'))), false, 'A missing session must not enter the failing resume loop');
    await audit('missing-codex-recovery');
    await page.locator('.resume-notice button').filter({ hasText: 'Choose session' }).click();
    await page.waitForSelector('#session-list button');
    await audit('codex-session-picker');
    await page.locator('#session-list button').click();
    await page.waitForFunction(() => window.qa.panes.some(p => p.argv.at(-1).includes('resume valid-session')));
    await page.goto(base + '?stale-codex');
    await page.waitForSelector('.resume-notice');
    await page.locator('.resume-notice button').filter({ hasText: 'Start new' }).click();
    await page.waitForFunction(() => window.qa.panes.some(p => p.argv.at(-1).startsWith('codex')));
    assert.ok(await page.evaluate(() => window.qa.panes.filter(p => p.argv.at(-1).startsWith('codex')).every(p => !p.argv.at(-1).includes('resume'))));
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
    await page.goto(base + '?legacy-opencode2');
    await page.waitForSelector('.resume-notice');
    await page.locator('.resume-notice button').filter({ hasText: 'Choose session' }).first().click();
    await page.waitForSelector('#session-list button');
    assert.equal(await page.evaluate(() => window.qa.calls.filter(c => c.cmd === 'opencode_sessions').at(-1).args.command), 'opencode2');
    await audit('opencode2-session-picker');
    await page.locator('#session-list button').first().click();
    await page.waitForFunction(() => window.qa.panes.some(p => p.argv.at(-1) === 'opencode2 --session ses_first'));
    await page.click('#dashboard-btn');
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'last_messages' && c.args.panes.some(p => p[1] === 'opencode2' && p[3] === 'ses_first')));
    await audit('opencode2-overview');
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
    await page.waitForFunction(() => window.qa.saved?.ui.thread === 2 && window.qa.saved.ui.sideOpen === false && window.qa.saved.ui.changesOpen === false && window.qa.saved.threads[2].tab === 0);
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
      const paneId = window.qa.calls.filter(c => c.cmd === 'take_sessions').at(-1).args.ids[0];
      window.qa.sessions.push([paneId, 'last-turn-before-close']);
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://close-requested', payload: null });
    });
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'plugin:window|destroy'));
    assert.ok(await page.evaluate(() => window.qa.saved.threads.flatMap(t => t.panes).some(p => p.sessionId === 'last-turn-before-close')), 'Close must capture the final notification before saving');
    assert.ok(await page.evaluate(() => {
      const calls = window.qa.calls.map(c => c.cmd);
      return calls.indexOf('pty_shutdown') >= 0 && calls.indexOf('pty_shutdown') < calls.indexOf('plugin:window|destroy');
    }), 'Native cleanup must run before the window is destroyed');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log(`PASS ${width}px`);
    await context.close();
  }
  console.log(`PASS ${checks} rendered states. Screenshots: ${out}`);
} finally { await browser.close(); }
