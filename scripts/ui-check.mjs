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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
try {
  for (const width of (process.env.UI_WIDTHS || '320,375,768,1024,1280').split(',').map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const setup = (theme) => {
      const repo = 'C:\\projects\\loom';
      const thread = (name, panes) => ({ repo, dir: `${repo}\\${name}`, branch: `loom/${name}`, name, panes: panes.map(cmd => ({ cmd })) });
      const toolsRepo = 'C:\\projects\\tools';
      let state = { repos: [repo, toolsRepo], threads: [thread('search-polish', ['claude', 'codex']), thread('review-keyboard-navigation', ['claude']), { ...thread('fix-settings', ['claude']), repo: toolsRepo, dir: toolsRepo }] };
      state.theme = theme;
      if (location.search.includes('memory')) state.threads[2].panes.push({ cmd: 'claude' });
      if (location.search.includes('resume')) state.threads[0].panes = [{ cmd: 'codex' }, { cmd: 'codex' }];
      if (location.search.includes('legacy')) state.threads[0].panes = [{ cmd: 'opencode', sid: 'old-placeholder-a' }, { cmd: 'opencode', sid: 'old-placeholder-b' }];
      if (location.search.includes('restore')) state = JSON.parse(localStorage.getItem('qa-state'));
      const qa = window.qa = { calls: [], panes: [], saved: null, failCreate: false, wakes: [], sessions: [], failSessions: false };
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
          args.onOut.onmessage('\x1b]0;Review workspace navigation\x07\x1b[34m❯ loom\x1b[0m\r\n\r\nReady to work on this thread.\r\nChanges stay in its own worktree.\r\n\r\n\x1b[32m+ Ready\x1b[0m  \x1b[33m~ Pending\x1b[0m  \x1b[31m- Removed\x1b[0m\r\n\x1b[34mBlue\x1b[0m  \x1b[35mMagenta\x1b[0m  \x1b[36mCyan\x1b[0m\r\n');
          return location.search.includes('restore') ? new Promise(resolve => setTimeout(resolve, qa.panes.length * 30)) : undefined;
        }
        if (cmd === 'take_wakes') return qa.wakes.splice(0);
        if (cmd === 'take_sessions') {
          const mine = qa.sessions.filter(([id]) => args.ids.includes(id));
          qa.sessions = qa.sessions.filter(s => !mine.includes(s));
          return mine;
        }
        if (cmd === 'read_file') return 'export const answer = 42;\n// ' + args.path + '\n';
        if (cmd === 'read_image') {
          if (qa.failImage) throw new Error('Image file not found');
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
        if (cmd === 'git_run') {
          const a = args.args;
          if (a.includes('MERGE_HEAD') || a.includes('REVERT_HEAD') || a[0] === 'rebase') throw new Error('No operation in progress');
          if (a[0] === 'worktree' && a[1] === 'add' && qa.failCreate) throw new Error('Could not create worktree: branch is locked');
          if (a[0] === 'status') return qa.clean ? '' : ' M src/main.ts\0M  src/styles.css\0?? notes.txt\0';
          if (a.includes('--numstat')) return '18\t4\tsrc/main.ts\n7\t2\tsrc/styles.css\n';
          if (a[0] === 'ls-files') return 'README.md\0preview.png\0src/main.ts\0src/styles.css\0src/ui/menu.ts\0';
          if (a[0] === 'diff' || a[0] === 'show') return (a.includes('-U999999') ? ' context line one\n context line two\n' : '') + 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old navigation\n+const description = "A long line of source code that should remain readable when reviewing changes inside a narrow workspace window.";\n';
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
    await context.addInitScript({ content: mocks + '\n(' + setup.toString() + ')(' + JSON.stringify(process.env.UI_THEME || 'loom') + ');' });
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
        const misplacedPaneActions = [...document.querySelectorAll('.pane-head')].filter(head => {
          const bounds = head.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return false;
          const close = head.querySelector('button[title="Close pane"]').getBoundingClientRect();
          const zoom = head.querySelector('button[title="Zoom (F2)"]').getBoundingClientRect();
          return Math.abs(bounds.right - close.right - 4) > 1 || Math.abs(close.left - zoom.right - 6) > 1;
        }).map(head => head.querySelector('.pane-title').textContent);
        return { width: root.clientWidth, scroll: root.scrollWidth, offenders, misplacedPaneActions };
      });
      assert.equal(result.width, width);
      assert.ok(result.scroll <= width, `${name}@${width}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.offenders, [], `${name}@${width}: clipped controls`);
      assert.deepEqual(result.misplacedPaneActions, [], `${name}@${width}: fullscreen and close must stay together at the right edge`);
      await page.screenshot({ path: `${out}/${name}-${width}.png` });
      checks++;
    }
    const escape = () => page.keyboard.press('Escape');
    await audit('workspace');
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
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    // Click the rendered terminal link, including its wrapped form on phones.
    const imagePath = 'node_modules\\.cache\\ui-check\\theme-picker-0-768.png';
    let linkRow = 0;
    async function clickTerminalPath(path) {
      const pane = page.locator('.grid:not(.hidden) .pane').first();
      const id = await pane.getAttribute('data-id');
      const row = linkRow++;
      await page.evaluate(({ id, path, row }) => window.qa.panes.find(p => p.id === id).onOut.onmessage('\x1b[2J\x1b[H' + '\r\n'.repeat(row) + path + '\r\n'), { id, path, row });
      await page.waitForTimeout(150);
      const size = await page.evaluate(id => window.qa.calls.filter(c => ['pty_spawn', 'pty_resize'].includes(c.cmd) && c.args.id === id).at(-1).args, id);
      const r = await pane.locator('.xterm-screen').boundingBox();
      const top = r.y + r.height / size.rows * (row + 0.5);
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
    await page.evaluate(() => window.qa.failImage = true);
    await clickTerminalPath('"C:\\My Pictures\\missing image.png"');
    await page.waitForFunction(() => document.querySelector('#diff-body').textContent.includes('Image file not found')).catch(async e => {
      console.error(await page.evaluate(() => ({ calls: window.qa.calls.filter(c => ['read_image', 'open_vscode', 'pty_resize'].includes(c.cmd)), text: document.querySelector('#diff-body').textContent })));
      await page.screenshot({ path: `${out}/image-link-failure-${width}.png` });
      throw e;
    });
    await audit('image-preview-error');
    await page.click('#diff-close');
    await clickTerminalPath('src/main.ts:12');
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'open_vscode' && c.args.goto.endsWith('src/main.ts:12')));
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
      assert.equal(palettes.length, 38);
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
          // Loom and Graphite retain their original colors by design.
          const roles = classic ? ['text', 'muted'] : ['text', 'muted', 'faint', 'accent', 'ok', 'err', 'warn', 'blue', 'magenta', 'cyan'];
          return ['bg', 'panel', 'raise'].flatMap(bg =>
            roles.filter(fg => {
              const [a, b] = [luminance(bg), luminance(fg)].sort((x, y) => x - y);
              return (b + 0.05) / (a + 0.05) < 4.5;
            }).map(fg => `${fg} on ${bg}`));
        }, ['loom', 'graphite'].includes(palette.label));
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
    for (const id of ['lang', 'prefix', 'layout']) {
      assert.equal(await page.locator('#bar #' + id).isVisible(), true, id + ' must be visible in the top bar');
    }
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
    await page.evaluate(() => window.qa.panes.forEach((p, i) => p.onOut.onmessage('\x1b]0;' + (i === 5 ? 'Terminal\x07\x1b]133;C' : ['◐', '⠙', '✳'][i % 3] + ' Agent session') + '\x07Working (3s • esc to interrupt)\r\n')));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=busy]').length === 6);
    assert.equal(await page.locator('.agent-title').filter({ hasText: /[◐⠙✳]/ }).count(), 0, 'Provider titles do not duplicate the spinner');
    const frames = await page.locator('.agent-title').evaluateAll(labels => [0, 100].map(time => labels.map(label => {
      const animation = label.getAnimations({ subtree: true }).find(a => a.animationName === 'agent-spin');
      if (!animation) return null;
      animation.pause();
      animation.currentTime = time;
      return getComputedStyle(label, '::before').content;
    })));
    assert.ok(frames[0].every(frame => frame?.includes('· ⠋')) && frames[1].every(frame => frame?.includes('· ⠙')), 'Every agent and CLI animates the braille spinner after its name');
    await audit('all-agents-working');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(await page.locator('.agent-title').evaluateAll(labels => labels.every(label => getComputedStyle(label, '::before').animationName === 'none')), 'Reduced motion stops the spinner');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x1b]133;D\x07')));
    await page.waitForFunction(() => !document.querySelector('.agent[data-state=busy]'));
    // Codex's idle prompt animates: output without its working line must not read as busy.
    await page.evaluate(() => window.qa.panes.filter(p => p.argv.join(' ').includes('codex')).forEach(p => { p.onOut.onmessage('\x1b[2;3H·\x1b[4;9H✦'); p.onOut.onmessage('\x1b[2;3H \x1b[5;1H·'); }));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.agent[data-state=busy]').count(), 0, 'Idle codex redraws must not show as working');
    assert.ok(await page.locator('.agent-title').evaluateAll(labels => labels.every(label => getComputedStyle(label, '::before').animationName === 'none')), 'Ready agents stop animating');
    await audit('all-agents-ready');
    await page.evaluate(() => window.qa.panes.forEach(p => p.onOut.onmessage('\x07')));
    await page.waitForFunction(() => document.querySelectorAll('.agent[data-state=waiting]').length === 6);
    await audit('all-agents-waiting');
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pane').length === 4 && window.qa.saved);
    if (width <= 760) await page.click('#side-toggle');
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
        // save() is throttled to one write per 300 ms, so the pick lands a moment later.
        await page.waitForFunction(key => window.qa.saved[key] === 1, id, { timeout: 5000 }).catch(() => assert.fail(id + ' selection must be saved'));
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
    await page.click('#changes-close'); // under 760px the panel covers the diff
    // The overview ruler: one mark per run of changed rows, the removal above the addition.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#diff-ruler i')].map(m => [m.className, parseFloat(m.style.top) < 100])), [['del', true], ['add', true]]);
    assert.ok(await page.evaluate(() => { const [d, a] = document.querySelectorAll('#diff-ruler i'); return d.getBoundingClientRect().top < a.getBoundingClientRect().top; }), 'Ruler marks keep row order');
    await page.click('#diff-full');
    await page.waitForFunction(() => document.querySelector('#diff-body').textContent.includes('context line one') && window.qa.saved.ui.diffFull);
    await audit('diff-full');
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
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://close-requested', payload: null });
    });
    await page.waitForFunction(() => window.qa.calls.some(c => c.cmd === 'plugin:window|destroy'));
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log(`PASS ${width}px`);
    await context.close();
  }
  console.log(`PASS ${checks} rendered states. Screenshots: ${out}`);
} finally { await browser.close(); }
