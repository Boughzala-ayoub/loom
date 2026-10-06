// The phone remote against the real app: loomctl remote on/pair/revoke, the
// HTTP server's refusals, and the phone page in headless Chrome at 320 to
// 1280 px, driving a cmd.exe pane, creating and closing threads. Needs a
// release build with --features tauri/custom-protocol (loom.exe and
// loomctl.exe beside it, or LOOM_TEST_EXE). A temporary profile and Git
// folder; restores the shared files a test Loom rewrites. The test Loom's
// window shows on the desktop while it runs, and is resized once.
// Set PLAYWRIGHT_MODULE to an installed playwright module path if it isn't local.
// REMOTE_CHECK_DIST=1 gives the browser the page from dist/ instead of
// loom.exe's copy, to try a page change without rebuilding loom.exe. Run the
// final check without it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe');
const ctl = join(dirname(exe), 'loomctl.exe');
assert.ok(existsSync(ctl), `loomctl.exe must sit beside ${exe}`);
const out = resolve('node_modules/.cache/remote-check');
const fromDist = process.env.REMOTE_CHECK_DIST === '1';
mkdirSync(out, { recursive: true });
const data = join(process.env.APPDATA, 'dev.ayoub.loom');
const plugin = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins/loom.js');
const shared = [join(data, 'claude-hooks.json'), join(data, 'shell-init.ps1'), plugin]
  .map((file, i) => ({ file, backup: join(out, `${i}-${basename(file)}.backup`), had: existsSync(file) }));
for (const s of shared) if (s.had) copyFileSync(s.file, s.backup);

const dir = mkdtempSync(join(tmpdir(), 'loom-remote-check-'));
// Worktrees go under ~\loom\<repo>, so the repo's name is this run's own.
const repoName = `loom-remote-check-${process.pid}`;
const repo = join(dir, repoName);
mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
spawnSync('git', ['-C', repo, '-c', 'user.email=check@loom', '-c', 'user.name=check', 'commit', '-q', '--allow-empty', '-m', 'start']);
const plain = join(dir, 'plain');
mkdirSync(plain);
const profile = join(dir, 'workspace.json');
writeFileSync(profile, JSON.stringify({ silent: true, ui: { thread: 0 }, threads: [{ repo, dir: repo, branch: '', name: 'alpha', panes: [{ cmd: 'cmd' }] }] }));

const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
};
function loomctl(...args) {
  const env = { ...process.env };
  delete env.LOOM_PIPE; // this check may itself run in a Loom pane
  const r = spawnSync(ctl, ['--profile', profile, ...args], { encoding: 'utf8', env, timeout: 60000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), json };
}
const ok = (...args) => {
  const r = loomctl(...args);
  assert.equal(r.code, 0, `loomctl ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
};
let child;
async function launch() {
  child = spawn(exe, [profile], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (loomctl('status').code === 0) return;
    await pause(300);
  }
  assert.fail('Loom must start and answer loomctl');
}
const kill = () => spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });

let browser;
try {
  await launch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const api = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Off until turned on; on, it answers on 127.0.0.1 only.
  let r = ok('--json', 'remote');
  assert.equal(r.json.on, false);
  assert.match(loomctl('remote', 'pair').err, /off/, 'No pairing while the remote is off');
  r = ok('--json', 'remote', 'on', '--port', String(port));
  assert.equal(r.json.listening, true);
  assert.equal(r.json.port, port);
  assert.match(ok('remote').out, /On, at 127\.0\.0\.1:\d+\. 0 phones paired/);
  assert.equal(JSON.parse(readFileSync(profile.replace(/\.json$/, '.remote.json'), 'utf8')).on, true, 'The setting sits beside the profile');
  console.log('PASS remote on, off by default, and its setting saved beside the profile');

  // The server: the page for anyone who reaches it, commands only for a paired phone.
  let res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /id="pairing"/, 'GET / is the phone page, not the desktop page');
  const script = html.match(/src="(\/assets\/remote-[^"]+\.js)"/)[1];
  if (!fromDist) assert.equal(script, readFileSync('dist/remote.html', 'utf8').match(/src="(\/assets\/remote-[^"]+\.js)"/)[1], 'loom.exe must embed the current frontend bundle');
  res = await fetch(base + script, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('cache-control'), /immutable/);
  for (const path of ['/assets/nope.js', '/assets/..%2Findex.html', '/index.html', '/assets/']) {
    assert.equal((await fetch(base + path)).status, 404, `${path} must not be served`);
  }
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [] })).status, 401, 'No token, no commands');
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [] }, { Authorization: 'Bearer 00' })).status, 401, 'A made-up token, no commands');
  res = await api('/api/pair', { code: '000000' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /No pairing code is open/);
  let code = ok('--json', 'remote', 'pair').json.pairing;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.match((await (await api('/api/pair', { code: wrong })).json()).error, /Wrong code/);
  res = await api('/api/pair', { code });
  assert.equal(res.status, 200);
  const token = (await res.json()).token;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await api('/api/pair', { code })).status, 403, 'A code pairs one phone');
  const auth = { Authorization: `Bearer ${token}` };
  res = await api('/api/cli', { cmd: 'status', argv: [] }, auth);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.threads, 1);
  assert.equal((await api('/api/cli', { cmd: 'status', argv: 'x' }, auth)).status, 400, 'Words must be a list');
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [], stdin: 5 }, auth)).status, 400, 'stdin must be text');
  assert.match(ok('remote').out, /1 phone paired/);
  assert.ok(!readFileSync(profile.replace(/\.json$/, '.remote.json'), 'utf8').includes(token), 'Only a hash of the token is saved');
  code = ok('--json', 'remote', 'pair').json.pairing;
  for (let i = 0; i < 5; i++) await api('/api/pair', { code: code === '000000' ? '111111' : '000000' });
  assert.equal((await api('/api/pair', { code })).status, 403, 'Five wrong guesses use the code up');
  console.log('PASS the page, its bundle, gzip, refusals without a token, and pairing');

  // The phone page, at every width.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pageErrors = [];
  const context = async (width, stored) => {
    const c = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: width < 900, hasTouch: width < 900 });
    if (stored) await c.addInitScript(t => localStorage.setItem('loom-token', t), stored);
    if (fromDist) await c.route(`${base}/**`, route => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/' && !path.startsWith('/assets/')) return route.continue();
      return route.fulfill({ path: join('dist', path === '/' ? 'remote.html' : path) });
    });
    const page = await c.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => pageErrors.push(e.message));
    return page;
  };
  const fits = async (page, what) => {
    assert.deepEqual(pageErrors, [], `${what}: errors in the page`);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `${what}: the page is ${scroll} px wide in a ${client} px window`);
    // Fingers through a phone: every visible control is at least 44 px tall.
    const small = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')]
      .filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.outerHTML.slice(0, 80)));
    assert.deepEqual(small, [], `${what}: controls under 44 px`);
    await page.screenshot({ path: join(out, `${what.replace(/\W+/g, '-')}.png`) });
  };

  // Pairing through the page itself.
  let page = await context(375);
  await page.goto(base);
  await page.locator('#pairing').waitFor();
  await fits(page, '375 pairing');
  code = ok('--json', 'remote', 'pair').json.pairing;
  await page.fill('#pairing input', code);
  await page.click('#pairing button');
  await page.locator('#rows .row').first().waitFor();
  const phoneToken = await page.evaluate(() => localStorage.getItem('loom-token'));
  assert.match(phoneToken, /^[0-9a-f]{64}$/);
  await page.context().close();
  console.log('PASS pairing from the page');

  for (const width of [320, 375, 768, 1024, 1280]) {
    page = await context(width, phoneToken);
    await page.goto(base);
    const row = page.locator('#rows .row', { hasText: 'alpha:1' });
    await row.waitFor();
    await fits(page, `${width} list`);
    await row.click();
    await page.locator('#screen .line').first().waitFor();
    assert.equal(await page.locator('#pane-name').textContent(), 'alpha:1 · shell');
    const said = `phone-says-hi-${width}`;
    await page.fill('#prompt textarea', `echo ${said}`);
    await page.click('#prompt button');
    await page.waitForFunction(s => document.querySelector('#screen').textContent.split(s).length > 2, said, { timeout: 15000 });
    await fits(page, `${width} pane`);
    await page.click('#more');
    await page.locator('#actions').waitFor();
    await fits(page, `${width} actions`);
    await page.locator('#actions button', { hasText: 'Older lines' }).click();
    await page.locator('#notice', { hasText: 'Older lines' }).waitFor();
    await page.locator('#notice button', { hasText: 'Back to live' }).click();
    await page.locator('#notice', { hasText: 'Older lines' }).waitFor({ state: 'hidden' });
    if (width >= 900) assert.ok(await page.locator('#list').isVisible(), 'Wide: the list stays beside the pane');
    else {
      assert.ok(!(await page.locator('#list').isVisible()), 'Phone: one view at a time');
      await page.click('#back');
      await row.waitFor();
    }
    await page.click('#new-btn');
    await page.locator('#new form').waitFor();
    await fits(page, `${width} new thread`);
    await page.context().close();
    console.log(`PASS ${width} px: list, pane, send, actions, older lines, new-thread form`);
  }

  // Creating and closing threads from the phone.
  page = await context(375, phoneToken);
  await page.goto(base + '#/new');
  await page.locator('#new form').waitFor();
  await page.selectOption('#new select[name=project]', repo);
  await page.fill('#new input[name=name]', 'phone-wt');
  await page.selectOption('#new select[name=agent]', 'cmd');
  await page.click('#new button.primary');
  await page.waitForFunction(() => document.querySelector('#pane-name')?.textContent.endsWith('· shell') && location.hash.startsWith('#/pane/'), null, { timeout: 60000 });
  let threads = ok('--json', 'threads').json;
  const wt = threads.find(t => t.branch === 'loom/phone-wt');
  assert.ok(wt, `A worktree thread on loom/phone-wt: ${JSON.stringify(threads.map(t => t.branch))}`);
  await page.click('#more');
  await page.locator('#actions button', { hasText: 'Close the thread' }).click();
  await page.locator('#rows .row', { hasText: 'alpha:1' }).waitFor();
  for (let i = 0; i < 20 && ok('--json', 'threads').json.length !== 1; i++) await pause(250);
  assert.equal(ok('--json', 'threads').json.length, 1, 'Closing the thread from the phone closes it');
  await page.goto(base + '#/new');
  await page.selectOption('#new select[name=project]', '');
  await page.fill('#new input[name=folder]', plain);
  await page.click('#new [data-kind=checkout]');
  assert.ok(!(await page.locator('#name-field').isVisible()), 'This folder needs no name');
  await page.selectOption('#new select[name=agent]', 'cmd');
  await page.click('#new button.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/pane/'), null, { timeout: 60000 });
  threads = ok('--json', 'threads').json;
  assert.ok(threads.some(t => t.dir === plain), 'This folder opens as a thread');
  ok('close-thread', threads.find(t => t.dir === plain).id, '--yes');
  console.log('PASS a worktree thread and a folder thread from the phone, and closing a thread');

  // Fitting Loom to the phone narrows the pane, and back.
  await page.goto(base);
  await page.locator('#rows .row', { hasText: 'alpha:1' }).click();
  await page.locator('#screen .line').first().waitFor();
  const cols = () => ok('--json', 'read', 'alpha:1').json.cols;
  const wide = cols();
  await page.click('#more');
  await page.locator('#actions button', { hasText: 'Fit Loom to phone' }).click();
  await page.locator('#toast', { hasText: 'fits the phone' }).waitFor();
  for (let i = 0; i < 20 && cols() >= wide; i++) await pause(250);
  const narrow = cols();
  assert.ok(narrow < wide && narrow <= 60, `Phone size narrows the pane: ${wide} to ${narrow} columns`);
  assert.equal(ok('--json', 'status').json.phone, true);
  // The page reads the narrower screen and drops its "wider than this screen" notice.
  await page.locator('#notice').waitFor({ state: 'hidden' });
  await fits(page, '375 pane fitted');
  await page.click('#more');
  await page.locator('#actions button', { hasText: 'Desktop size on the PC' }).click();
  await page.locator('#toast', { hasText: 'desktop size' }).waitFor();
  assert.equal(ok('--json', 'status').json.phone, false);
  console.log(`PASS fitting Loom to the phone: ${wide} to ${narrow} columns, and back`);

  // Revoked, the page asks to pair again.
  ok('remote', 'revoke');
  await page.locator('#pairing').waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('loom-token')), null);
  await page.context().close();
  console.log('PASS revoke unpairs the phone');

  // It starts again with Loom, and off lets the port go.
  kill();
  await pause(1500);
  await launch();
  for (let i = 0; i < 20 && (await fetch(base + '/').then(r => r.status).catch(() => 0)) !== 200; i++) await pause(250);
  assert.equal((await fetch(base + '/')).status, 200, 'A Loom restarted with the remote on listens again');
  ok('remote', 'off');
  assert.equal(await fetch(base + '/').then(() => 'answered').catch(() => 'refused'), 'refused');
  assert.match(ok('remote').out, /^Off/);
  console.log('PASS the remote comes back with Loom, and off closes the port');
} finally {
  await browser?.close().catch(() => {});
  if (child) kill();
  for (const s of shared) {
    if (s.had) copyFileSync(s.backup, s.file);
    else rmSync(s.file, { force: true });
  }
  await pause(1000);
  spawnSync('git', ['-C', repo, 'worktree', 'prune']);
  for (const target of [join(homedir(), 'loom', repoName), dir]) {
    for (let i = 0; ; i++) {
      try { rmSync(target, { recursive: true, force: true }); break; } catch (e) {
        if (i === 10) { console.log('Could not remove', target, e.code); break; }
        await pause(1000);
      }
    }
  }
}
