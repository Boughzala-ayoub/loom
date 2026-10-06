// The phone page from dist/ in headless Chrome, with only /api mocked: every
// view at 320 to 1280 px (and 901, just past the two-column breakpoint) must
// fit its width, and the regressions from the phone remote review stay fixed:
// late git replies, a cut-off answer to a change, Activity drafts, the startup
// list, Cancel, and sends or hunk actions that complete after you moved on.
// Notifications on this phone: the real service worker gets a push through
// the DevTools protocol (headless Chrome can't reach a push service, so only
// the subscription is made up) and a tap opens the agent.
// Run `npm run build` first. Screenshots go to
// node_modules/.cache/remote-ui-check. Set PLAYWRIGHT_MODULE to an installed
// playwright module path if it isn't local.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const out = resolve('node_modules/.cache/remote-ui-check');
mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    // remote.rs serves these two from outside dist/.
    const file = path === '/sw.js' ? resolve('src-tauri/src/remote-sw.js') : path === '/icon.png' || path === '/badge.png' ? resolve(`src-tauri/icons${path}`)
      : resolve('dist', path === '/' ? 'remote.html' : path.slice(1));
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.statusCode = 404; res.end('missing'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
assert.equal((await fetch(base)).status, 200, 'the page must be served');
console.log('HTTP 200, bundle', readFileSync('dist/remote.html', 'utf8').match(/assets\/remote-[^" ]+\.js/)[0]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(what, f, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(25)) if (await f()) return;
  assert.fail(`timed out: ${what}`);
}
function thread(id, name, agent = 'claude') {
  return { id, name, repo: `C:/projects/${name}`, dir: `C:/projects/${name}`, branch: `loom/${name}`, state: 'idle', layout: 'cols', zoomed: null, front: id === 'a', changed: { add: 2, del: 1, files: 3 },
    panes: [{ id: `${id}1`, ref: `${name}:1`, threadId: id, agent, state: 'idle', title: 'A long agent task title for the phone', lastOutput: '2026-10-06T10:00:00.000Z', model: 'sonnet[1m]', notify: 'inherit', context: { usedTokens: 20000, windowTokens: 200000, remainingPercent: 90 } }] };
}
const file = (path, x = ' ', y = 'M') => ({ path, x, y, add: 2, del: 1 });
const own = id => (id === 'a' ? 'alpha' : 'beta');
const status = id => ({ thread: id, name: id === 'a' ? 'Alpha' : 'Beta', branch: `loom/${id}`, upstream: `origin/loom/${id}`, ahead: 1, behind: 1, midway: 'rebase',
  staged: [file('staged.txt', 'M', ' ')], unstaged: [file(`${own(id)}.txt`), file('conflict.txt', 'U', 'U')], untracked: [file('new.txt', '?', '?')],
  commits: [{ sha: 'abc1234', subject: 'A recent commit message with a useful description' }] });
const patch = name => `diff --git a/${name} b/${name}\nindex 1234567..7654321 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old ${name}\n+new ${name}\n`;

/** A page whose /api answers like Loom. `hold` keeps a `git <thread> <action>` reply until state.held[it]() runs. */
// RFC 8291's example public key: any P-256 point does for a subscription that is made up.
const PUSH_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
async function context(width, token = true, push = false) {
  const state = { calls: [], changedTitle: false, startups: [{ label: 'Claude', cmd: 'claude' }, { label: 'Codex', cmd: 'codex' }], hold: new Set(), held: {}, corruptSend: false, refuseSend: false, errors: [], push: { on: false, sub: null }, booted: 1, updated: false };
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  if (token) await ctx.addInitScript(() => localStorage.setItem('loom-token', 'fixture-token'));
  if (push) {
    await ctx.grantPermissions(['notifications'], { origin: base });
    // Headless Chrome can't reach a push service: the subscription is made up, the worker is real.
    await ctx.addInitScript(() => {
      let sub = null;
      PushManager.prototype.subscribe = async function (o) {
        sub = { endpoint: 'https://push.example/sub/1', options: { applicationServerKey: new Uint8Array(o.applicationServerKey).buffer },
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; }, async unsubscribe() { sub = null; return true; } };
        return sub;
      };
      PushManager.prototype.getSubscription = async function () { return sub; };
    });
  }
  await ctx.route('**/api/**', async route => {
    const req = route.request(), c = req.postDataJSON();
    state.calls.push(c);
    if (req.url().endsWith('/pair')) return route.fulfill({ json: { ok: true, token: 'fixture-token' } });
    if (req.url().endsWith('/api/push')) {
      if (c.off) state.push = { on: false, sub: null };
      if (c.subscription) state.push = { on: true, sub: c.subscription };
      return route.fulfill({ json: { ok: true, key: PUSH_KEY, on: state.push.on } });
    }
    if (typeof c.cmd !== 'string' || !Array.isArray(c.argv) || !c.argv.every(v => typeof v === 'string')) return route.fulfill({ status: 400, json: { ok: false, error: 'Send a command, its words, and optionally stdin and a key.' } });
    if (c.cmd === 'send' || c.cmd === 'submit') {
      if (state.hold.delete('submit')) await new Promise(r => (state.held.submit = r));
      // The change ran, then the connection broke in the middle of its answer.
      if (state.corruptSend) { state.corruptSend = false; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":' }); }
      if (state.refuseSend) { state.refuseSend = false; return route.fulfill({ json: { ok: false, error: 'That pane is busy.' } }); }
    }
    let data;
    const threads = [thread('a', 'Alpha'), thread('b', 'Beta', 'codex')];
    if (state.changedTitle) threads[1].panes[0].title = 'Another agent has changed its title';
    switch (c.cmd) {
      case 'status': data = { phone: false, agents: state.startups.map(s => s.label), booted: state.booted, updated: state.updated }; break;
      // The restarted Loom answers a moment later, started anew.
      case 'relaunch': setTimeout(() => state.booted++, 1500); data = { stopping: [] }; break;
      case 'threads': data = threads; break;
      case 'messages': data = threads.map(t => ({ pane: t.panes[0].id, user: 'Please review the changes and check the real behavior.', agent: 'The review is ready. This is a sample response.' })); break;
      case 'menu': data = { question: ['May I change this file?'], options: ['Yes, go ahead', 'No, keep it'], keys: ['1', '2'], rev: 'menu-1' }; break;
      case 'read': data = { text: 'sample screen', cols: 120, rows: [{ runs: [{ x: 0, text: 'sample screen' }] }] }; break;
      case 'theme': data = ['loom', 'nord', 'light'].map((name, i) => ({ name, scheme: i === 2 ? 'light' : 'dark', current: i === 0, vars: {} })); break;
      case 'set': data = { sound: 'on', taskbar: 'on', overlay: 'background', awake: 'off', 'plan-usage': 'on', font: '13' }; break;
      case 'notify': data = { all: 'on', kinds: { finish: true, fail: true, blocked: true }, newPanes: 'inherit' }; break;
      case 'remote': data = { phones: 1, address: 'https://pc.tailnet.example', port: 7420 }; break;
      case 'trash': data = [{ at: 'C:/Users/test/loom/trash/old-project', branch: 'old-branch' }]; break;
      case 'usage': data = Object.fromEntries(['claude', 'codex'].map(k => [k, { tier: 'pro', fetchedAt: new Date().toISOString(), limits: [{ label: 'session', percent: 35, severity: '', resetsAt: new Date(Date.now() + 3600000).toISOString() }] }])); break;
      case 'context': data = { ctx: 20000, est: 0, buckets: [{ label: 'Messages', tokens: 10000 }, { label: 'Tools', tokens: 10000 }], series: [10000, 15000, 20000], drops: [] }; break;
      case 'startups':
        if (c.argv[0] === 'add') state.startups.push({ label: c.argv[1], cmd: c.argv.slice(2).join(' ') });
        if (c.argv[0] === 'remove') state.startups = state.startups.filter(s => s.label !== c.argv[1]);
        data = state.startups; break;
      case 'close-plan': data = { rev: 'plan', lost: { tracked: 1, commits: 1 } }; break;
      case 'git': {
        const [id, action = 'status'] = c.argv;
        const held = `${id} ${action}`;
        if (state.hold.delete(held)) await new Promise(r => (state.held[held] = r));
        if (action === 'diff') data = { diff: patch(`${own(id)}.txt`) };
        else if (action === 'show') data = { diff: `commit abc1234\nAuthor: Tester <test@example.com>\nDate: Tue Oct 6 10:00:00 2026 +0100\n\n    A sample commit\n\n ${own(id)}.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n${patch(`${own(id)}.txt`)}` };
        else if (action === 'files') data = { files: [`${own(id)}.txt`, 'src/deep/path.txt'] };
        else if (action === 'file') data = { text: `${own(id)} one\ntwo\nthree\n` };
        else if (action === 'branches') data = { current: `loom/${id}`, branches: [`loom/${id}`, 'feature/next'] };
        else if (action === 'stashes') data = { stashes: [{ ref: 'stash@{0}', message: `WIP on loom/${id}: abc1234 A saved change` }] };
        else data = status(id);
        break;
      }
      default: data = {};
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => state.errors.push(e.message));
  return { ctx, page, state };
}
const sheetButton = (page, text) => page.locator('#sheet').getByRole('button', { name: text, exact: true });
async function close(page) { if (await page.locator('#sheet').isVisible()) await sheetButton(page, 'Cancel').click(); }
async function goto(page, hash, ready) { await page.goto(base + '/' + hash); await page.locator(ready).first().waitFor(); }
const git = (state, action) => state.calls.filter(c => c.cmd === 'git' && c.argv[1] === action);

// --- Every view fits its width -------------------------------------------------------
let checks = 0;
const overflow = [];
async function fits(page, width, name) {
  await page.waitForTimeout(80);
  const dim = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  if (dim.scroll > dim.width) overflow.push({ width, name, ...dim });
  checks++;
  if (width === 375 || width === 901) await page.screenshot({ path: resolve(out, `${width}-${name}.png`), fullPage: true });
}
try {
  for (const width of (process.env.REMOTE_WIDTHS || '320,375,768,901,1024,1280').split(',').map(Number)) {
    const { ctx, page } = await context(width, false);
    await goto(page, '', '#pairing form'); await fits(page, width, 'pairing'); await ctx.close();
    const { ctx: c2, page: p, state } = await context(width);
    await goto(p, '', '#list .agent'); await fits(p, width, 'threads');
    await p.locator('#list .thread-top .icon-btn').first().click(); await fits(p, width, 'thread-menu');
    await sheetButton(p, 'Rename').click(); await fits(p, width, 'rename'); await close(p);
    await p.locator('#list .seg button').filter({ hasText: 'Activity' }).click(); await p.locator('#list .card').first().waitFor(); await fits(p, width, 'activity');
    await goto(p, '#/pane/a1', '#screen .line'); await fits(p, width, 'pane-question'); await p.click('#keys-btn'); await fits(p, width, 'keyboard');
    await p.locator('#keys [data-key=fn]').click(); await fits(p, width, 'function-keys'); await p.click('#more'); await p.locator('#sheet.on').waitFor(); await fits(p, width, 'pane-menu'); await close(p);
    await goto(p, '#/new', '#new form'); await fits(p, width, 'new-thread'); await p.locator('#new [data-kind=checkout]').click(); await fits(p, width, 'new-folder');
    await goto(p, '#/changes/a', '#changes .file'); await fits(p, width, 'changes'); await p.locator('#changes .picker').click(); await fits(p, width, 'thread-picker'); await close(p);
    await p.locator('#changes .file .icon-btn').first().click(); await fits(p, width, 'file-menu'); await sheetButton(p, 'Discard changes').click(); await fits(p, width, 'discard-confirm'); await close(p);
    await p.locator('#changes .file').filter({ hasText: 'conflict.txt' }).first().locator('.icon-btn').click(); await fits(p, width, 'conflict-menu'); await close(p);
    await p.locator('#changes [aria-label="Git actions"]').click(); await fits(p, width, 'git-menu'); await sheetButton(p, 'Switch branch').click(); await p.locator('#sheet .item').first().waitFor(); await fits(p, width, 'branches'); await sheetButton(p, 'New branch…').click(); await fits(p, width, 'branch-form'); await close(p);
    await p.locator('#changes [aria-label="Git actions"]').click(); await sheetButton(p, 'Restore a stash').click(); await p.locator('#sheet .pair').waitFor(); await fits(p, width, 'stashes'); await close(p);
    await p.locator('#changes .commit-row .icon-btn').first().click(); await fits(p, width, 'commit-menu'); await close(p);
    for (const sec of ['unstaged', 'staged', 'untracked']) { await goto(p, `#/diff/a/${sec}/alpha.txt`, '#diff .hunk'); await fits(p, width, `diff-${sec}`); }
    await goto(p, '#/commit/a/abc1234', '#diff .commit-head'); await fits(p, width, 'commit');
    await goto(p, '#/files/a', '#files .list-row'); await fits(p, width, 'files'); await goto(p, '#/file/a/alpha.txt', '#diff .r'); await fits(p, width, 'file');
    await goto(p, '#/usage', '#usage .provider'); await fits(p, width, 'usage'); await goto(p, '#/context/a1', '#context .bars'); await fits(p, width, 'context');
    await goto(p, '#/settings', '#settings .group'); await fits(p, width, 'settings'); await p.locator('#settings .setting').filter({ hasText: 'Theme' }).locator('button').click(); await fits(p, width, 'themes'); await close(p);
    await p.getByRole('button', { name: 'Unpair all', exact: true }).click(); await fits(p, width, 'unpair-confirm'); await close(p);
    assert.deepEqual(state.errors, [], `${width}: errors in the page`);
    await c2.close();
  }
  assert.deepEqual(overflow, [], 'no view may be wider than the window');
  console.log(`PASS ${checks} views fit their width`);

  // --- A late git reply stays with its own thread -------------------------------------
  for (const width of [375, 1024]) {
    const { ctx, page, state } = await context(width);
    await goto(page, '#/changes/b', '#changes .file');
    state.hold.add('a status');
    await page.evaluate(() => (location.hash = '#/changes/a'));
    await until('Alpha asks for its status', () => state.held['a status']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a status']();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#changes .picker b').innerText(), 'Beta');
    assert.equal(await page.locator('#changes .file').filter({ hasText: 'alpha.txt' }).count(), 0, "Alpha's late status must not draw under Beta");
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).locator('.icon-btn').click();
    await sheetButton(page, 'Stage').click();
    await until('the stage', () => git(state, 'stage').length);
    assert.deepEqual(git(state, 'stage')[0].argv, ['b', 'stage', '--unstaged', 'beta.txt']);

    // A diff: Alpha's late patch must not take Beta's diff screen and its hunk buttons.
    state.hold.add('a diff');
    await page.evaluate(() => (location.hash = '#/diff/a/unstaged/alpha.txt'));
    await until('Alpha asks for its diff', () => state.held['a diff']);
    await page.evaluate(() => (location.hash = '#/diff/b/unstaged/beta.txt'));
    await page.locator('#diff .hunk').first().waitFor();
    state.held['a diff']();
    await page.waitForTimeout(400);
    assert.ok(!(await page.locator('#diff').innerText()).includes('alpha'), "Alpha's late diff must not draw under Beta");
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until('the hunk', () => git(state, 'apply').length);
    const hunk = git(state, 'apply')[0];
    assert.deepEqual(hunk.argv, ['b', 'apply', '-', '--cached']);
    assert.match(hunk.stdin, /beta\.txt/);

    // A change asked in one thread draws nothing once another thread is on show.
    await goto(page, '#/changes/a', '#changes .file');
    state.hold.add('a fetch');
    await page.locator('#changes [aria-label="Git actions"]').click();
    await sheetButton(page, 'Fetch').click();
    await until('Alpha fetches', () => state.held['a fetch']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a fetch']();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#changes .file').filter({ hasText: 'alpha.txt' }).count(), 0, "Alpha's fetch must not draw under Beta");
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS late git replies stay with their thread: status, diff, hunk and change');

  // --- Cancel answers nothing ------------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/changes/a', '#changes .file');
    await page.locator('#changes [aria-label="Git actions"]').click();
    await sheetButton(page, 'Switch branch').click();
    await sheetButton(page, 'New branch…').click();
    await sheetButton(page, 'Cancel').click();
    await goto(page, '', '#list .agent');
    await page.locator('#list .thread-top .icon-btn').first().click();
    await sheetButton(page, 'Rename').click();
    await sheetButton(page, 'Cancel').click();
    await page.waitForTimeout(500);
    assert.deepEqual(git(state, 'switch'), [], 'Cancel must not switch branches');
    assert.deepEqual(state.calls.filter(c => c.cmd === 'rename'), [], 'Cancel must not rename');
    assert.equal(await page.locator('#toast.error').isVisible(), false);
    await ctx.close();
  }
  console.log('PASS Cancel sends nothing: new branch and rename');

  // --- A cut-off answer to a change is asked again with its key -------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    state.corruptSend = true;
    await page.fill('#prompt textarea', 'Please do this once');
    await page.click('#prompt button.primary');
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor({ timeout: 8000 });
    let sent = state.calls.filter(c => c.cmd === 'submit');
    assert.equal(sent.length, 2, 'one retry after the cut-off answer');
    assert.ok(sent[0].key && sent[0].key === sent[1].key, 'the retry carries the first key');
    assert.equal(await page.inputValue('#prompt textarea'), '');
    // Loom refusing is an answer: shown, never retried.
    state.refuseSend = true;
    await page.fill('#prompt textarea', 'Refuse this');
    await page.click('#prompt button.primary');
    await page.locator('#toast.error').filter({ hasText: 'That pane is busy.' }).waitFor();
    await page.waitForTimeout(2000);
    sent = state.calls.filter(c => c.cmd === 'submit');
    assert.equal(sent.length, 3, 'a refusal is not retried');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a cut-off answer retries with its key; a refusal does not');

  // --- The startup list follows Settings -------------------------------------------------
  {
    const { ctx, page } = await context(375);
    const options = async () => {
      await page.evaluate(() => (location.hash = '#/new'));
      await page.locator('#new select[name=agent]').waitFor();
      return page.locator('#new select[name=agent] option').allTextContents();
    };
    const settings = () => goto(page, '#/settings', '#settings input[aria-label=Name]');
    await settings();
    await page.fill('#settings input[aria-label=Name]', 'New Agent');
    await page.fill('#settings input[aria-label=Command]', 'newagent');
    await page.locator('#settings form button.primary').click();
    await page.getByRole('button', { name: 'Remove New Agent' }).waitFor();
    await page.getByRole('button', { name: 'Remove Codex' }).click();
    await page.getByRole('button', { name: 'Remove Codex' }).waitFor({ state: 'detached' });
    assert.deepEqual(await options(), ['Claude', 'New Agent'], 'New Thread offers what Settings lists');
    await page.evaluate(() => (location.hash = '#/'));
    await page.locator('#list .thread-top .icon-btn').first().click();
    assert.deepEqual(await page.locator('#sheet select[aria-label=Agent] option').allTextContents(), ['Claude', 'New Agent'], 'Add Agent too');
    await close(page);
    await settings();
    for (const name of ['Claude', 'New Agent']) {
      await page.getByRole('button', { name: `Remove ${name}` }).click();
      await page.getByRole('button', { name: `Remove ${name}` }).waitFor({ state: 'detached' });
    }
    assert.deepEqual(await options(), [], 'an emptied list offers nothing');
    await ctx.close();
  }
  console.log('PASS New Thread and Add Agent offer the startups Settings lists, down to none');

  // --- An Activity reply survives the cards being rebuilt --------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const reply = page.locator('#list .reply input[aria-label="Reply to Alpha:1"]');
    await reply.fill('Please keep this unsent reply');
    await reply.evaluate(i => { i.focus(); i.setSelectionRange(7, 11); });
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    const after = await reply.evaluate(i => ({ value: i.value, focused: document.activeElement === i, start: i.selectionStart, end: i.selectionEnd }));
    assert.deepEqual(after, { value: 'Please keep this unsent reply', focused: true, start: 7, end: 11 }, 'the draft, its focus and its selection survive');
    await reply.press('Enter');
    await until('the reply', () => state.calls.some(c => c.cmd === 'submit'));
    assert.equal(state.calls.find(c => c.cmd === 'submit').stdin, 'Please keep this unsent reply');
    await until('the box empties', async () => (await reply.inputValue()) === '');
    state.changedTitle = false;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await reply.inputValue(), '', 'a sent reply is no draft');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS an Activity reply keeps its text, focus and selection across a rebuild');

  // --- A reply that completes late clears only itself ------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const reply = page.locator('#list .reply input[aria-label="Reply to Alpha:1"]');
    await reply.fill('First reply');
    state.hold.add('submit');
    await reply.press('Enter');
    await until('the first reply is on its way', () => state.held.submit);
    await reply.fill('New draft while first reply is sending');
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    state.held.submit();
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(state.calls.find(c => c.cmd === 'submit').stdin, 'First reply');
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'the first reply must not take the newer draft with it');
    state.changedTitle = false;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'the newer draft survives the next rebuild');
    // Refused, it stays too.
    state.refuseSend = true;
    await reply.press('Enter');
    await page.locator('#toast.error').filter({ hasText: 'That pane is busy.' }).waitFor();
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'a refused reply stays a draft');

    // The agent's own message box: the same.
    await goto(page, '#/pane/a1', '#screen .line');
    await page.fill('#prompt textarea', 'First message');
    state.hold.add('submit');
    await page.click('#prompt button.primary');
    await until('the first message is on its way', () => state.held.submit);
    await page.fill('#prompt textarea', 'Next message');
    state.held.submit();
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#prompt textarea'), 'Next message', 'the first message must not take the next one with it');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a send that completes late clears only what it sent: Activity reply and message box');

  // --- A hunk action that completes after you left redraws nothing ------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/diff/a/unstaged/alpha.txt', '#diff .hunk');
    // On the same screen it reloads the diff, as before.
    const reads = git(state, 'diff').length;
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until('the diff reloads', () => git(state, 'diff').length === reads + 1);
    await page.locator('#diff .hunk').first().waitFor();
    // Left for Beta's file, it leaves that alone.
    state.hold.add('a apply');
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until("Alpha's hunk is on its way", () => state.held['a apply']);
    await page.evaluate(() => (location.hash = '#/file/b/beta.txt'));
    await until("Beta's file", async () => (await page.locator('#diff').innerText()).includes('beta one'));
    const before = git(state, 'diff').length;
    state.held['a apply']();
    await page.locator('#toast').filter({ hasText: 'Staged the hunk' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(git(state, 'diff').length, before, 'no reload of the diff that was left');
    assert.equal(await page.locator('#diff .who b').innerText(), 'beta.txt');
    assert.ok(!(await page.locator('#diff').innerText()).includes('alpha'), "Alpha's patch must not appear under beta.txt");
    assert.equal(await page.locator('#diff .hunk').count(), 0, 'no hunk buttons on a file');
    // Stage this file, then off to Beta's changes: it must not go Back from there.
    await goto(page, '#/diff/a/untracked/new.txt', '#diff .hunk');
    state.hold.add('a stage');
    await page.locator('#diff button').filter({ hasText: 'Stage this file' }).click();
    await until('the file is on its way', () => state.held['a stage']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a stage']();
    await page.locator('#toast').filter({ hasText: 'Staged' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => location.hash), '#/changes/b', 'a late Stage this file must not go Back from another screen');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a hunk or file action that completes after you left redraws and navigates nothing');
  // --- Notifications on this phone ----------------------------------------------------------
  {
    const { ctx, page, state } = await context(375, true, true);
    await goto(page, '#/settings', '#settings .group');
    const toggle = page.getByRole('switch', { name: 'Notifications on this phone' });
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await until('the subscription reaches Loom', () => state.push.sub);
    assert.deepEqual(state.push.sub, { endpoint: 'https://push.example/sub/1', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
    await page.getByRole('button', { name: 'Send a test', exact: true }).click();
    await until('the test', () => state.calls.some(c => c.cmd === 'remote' && c.argv.join(' ') === 'push test'));
    assert.equal(await toggle.isChecked(), true);
    for (const width of [320, 375, 768, 901, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await fits(page, width, 'settings-notifications-on');
    }
    await page.setViewportSize({ width: 375, height: 800 });
    assert.match(await page.evaluate(() => navigator.serviceWorker.ready.then(r => r.active.scriptURL)), /\/sw\.js$/);

    // A push, delivered to the worker as Chrome's push service would.
    const cdp = await ctx.newCDPSession(page);
    const regs = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => regs.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    await until('the worker registration', () => regs.some(r => r.scopeURL === `${base}/`));
    const registrationId = regs.find(r => r.scopeURL === `${base}/`).registrationId;
    const deliver = m => cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId, data: JSON.stringify(m) });
    const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data.url })));
    // From before Loom restarted: the pane id is gone, its ref still finds Beta.
    await deliver({ title: 'Beta:1 · Codex finished · 4 min', body: 'All tests pass.', url: '/#/pane/gone-id/Beta%3A1', tag: 'b1', at: Date.now() });
    await until('the notification shows', async () => (await shown()).length === 1);
    assert.deepEqual(await shown(), [{ title: 'Beta:1 · Codex finished · 4 min', body: 'All tests pass.', tag: 'b1', url: '/#/pane/gone-id/Beta%3A1' }]);
    // Loom's mark in the status bar, Loom's logo beside the text.
    assert.deepEqual(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => [new URL(n.badge).pathname, new URL(n.icon).pathname])), [['/badge.png', '/icon.png']]);
    assert.equal((await fetch(`${base}/badge.png`)).status, 200);

    // A tap: the worker sends the open page to the agent.
    await page.evaluate(() => (location.hash = '#/settings'));
    const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
    await sw.evaluate(async () => {
      const [n] = await self.registration.getNotifications();
      // ponytail: a made-up click can't waitUntil (it throws), but the handler's own work still runs.
      try { self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); } catch { /* see above */ }
    });
    await page.waitForFunction(() => location.hash === '#/pane/gone-id/Beta%3A1');
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    assert.deepEqual(await shown(), [], 'the tapped one closes');

    // Seen since it came: Alpha isn't waiting, so its old notification goes; a new one stays.
    await deliver({ title: 'Alpha:1 · Claude finished', body: 'Done.', url: '/#/pane/a1/Alpha%3A1', tag: 'a1', at: Date.now() - 20000 });
    await deliver({ title: 'Beta:1 · Codex asks', body: 'May I?', url: '/#/pane/b1/Beta%3A1', tag: 'b1', at: Date.now() });
    await until('the seen one closes', async () => (await shown()).map(n => n.tag).join() === 'b1', 6000);
    await page.waitForTimeout(2500);
    assert.deepEqual((await shown()).map(n => n.tag), ['b1'], 'a new one stays');

    // Off: Loom and the browser both let go.
    await goto(page, '#/settings', '#settings .group');
    await toggle.click();
    await until('Loom stops them', () => !state.push.on);
    await page.getByRole('button', { name: 'Send a test', exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS notifications on this phone: subscribe, a push shows, a tap opens the agent, seen ones close, off');
  // --- Restarting Loom from the phone ---------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    state.updated = true;
    await goto(page, '#/settings', '#settings .group');
    const restart = page.getByRole('button', { name: 'Restart to update', exact: true });
    await restart.waitFor();
    await fits(page, 375, 'settings-update-waiting');
    await restart.click();
    await page.locator('#sheet.on').filter({ hasText: 'the new version if you just updated' }).waitFor();
    const reloaded = page.waitForEvent('load', { timeout: 20000 });
    await sheetButton(page, 'Restart').click();
    await page.locator('#offline').filter({ hasText: 'Loom is restarting on the PC' }).waitFor();
    await fits(page, 375, 'restarting');
    state.updated = false; // the new Loom has no update waiting
    await reloaded;
    assert.deepEqual(state.calls.filter(c => c.cmd === 'relaunch').map(c => c.argv), [['--yes']]);
    await page.getByRole('button', { name: 'Restart', exact: true }).waitFor();
    assert.equal(await page.locator('#offline').isVisible(), false, 'back: no banner');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS restarting Loom from the phone: the update hint, a confirm, a banner while it restarts, a reload when it is back');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
