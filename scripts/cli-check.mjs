// loomctl against the real app: every command through the control pipe, and
// the window checked over CDP for what each one did. Needs a release build with
// --features tauri/custom-protocol (loom.exe and loomctl.exe beside it, or
// LOOM_TEST_EXE). A temporary profile and two temporary Git folders; cmd.exe
// panes only, no agents. Restores the shared files a test Loom rewrites.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe');
const ctl = join(dirname(exe), 'loomctl.exe');
assert.ok(existsSync(ctl), `loomctl.exe must sit beside ${exe}`);
const out = resolve('node_modules/.cache/cli-check');
mkdirSync(out, { recursive: true });
const data = join(process.env.APPDATA, 'dev.ayoub.loom');
const plugin = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins/loom.js');
const shared = [join(data, 'claude-hooks.json'), join(data, 'shell-init.ps1'), plugin]
  .map((file, i) => ({ file, backup: join(out, `${i}-${basename(file)}.backup`), had: existsSync(file) }));
for (const s of shared) if (s.had) copyFileSync(s.file, s.backup);

const dir = mkdtempSync(join(tmpdir(), 'loom-cli-check-'));
const repoA = join(dir, 'alpha');
const repoB = join(dir, 'beta');
for (const r of [repoA, repoB]) {
  mkdirSync(r);
  spawnSync('git', ['init', '-q', r]);
}
const profile = join(dir, 'workspace.json');
writeFileSync(profile, JSON.stringify({ silent: true, ui: { thread: 0 }, threads: [{ repo: repoA, dir: repoA, branch: '', name: 'alpha', panes: [{ cmd: 'cmd' }] }] }));
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(exe, [profile], { stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
const pause = ms => new Promise(r => setTimeout(r, ms));

/** loomctl for this profile: exit code, stdout, stderr, and --json's data. */
function loomctl(...args) {
  const env = { ...process.env };
  delete env.LOOM_PIPE; // this check may itself run in a Loom pane
  const r = spawnSync(ctl, ['--profile', profile, ...args], { encoding: 'utf8', env, timeout: 60000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json };
}
const ok = (...args) => {
  const r = loomctl(...args);
  assert.equal(r.code, 0, `loomctl ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
};

let browser;
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { ready = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false); if (!ready) await pause(100); }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const bundle = readFileSync('dist/index.html', 'utf8').match(/src="([^"]*\/main-[^"]+\.js)"/)[1];
  assert.equal(await page.locator('script[type="module"][src]').first().getAttribute('src'), bundle, 'The native app must embed the current frontend bundle');
  const panesShown = () => page.evaluate(() => document.querySelectorAll('.grid:not(.hidden) .pane').length);

  // Reading.
  let r = ok('--json', 'status');
  assert.equal(r.json.threads, 1);
  assert.equal(r.json.panes, 1);
  r = ok('status');
  assert.match(r.out, /1 thread, 1 pane/);
  r = ok('--json', 'threads');
  assert.equal(r.json[0].name, 'alpha');
  assert.equal(r.json[0].front, true);
  r = ok('help');
  assert.match(r.out, /send <pane> <text\.\.\.>/);
  console.log('PASS status, threads and help read the running Loom');

  // Typing: a command runs in the pane and its output reads back; loomctl works from inside a pane too.
  ok('wait', 'alpha:1', '--state', 'idle', '--timeout', '20');
  ok('send', 'alpha:1', 'echo loomctl-says-hi');
  await pause(800);
  r = ok('read', 'alpha:1');
  assert.match(r.out, /^loomctl-says-hi$/m, `The pane shows the command's output:\n${r.out}`);
  ok('send', 'alpha:1', 'loomctl status');
  let inside = '';
  for (let i = 0; i < 40 && !/1 thread, 1 pane/.test(inside); i++) { await pause(250); inside = ok('read', 'alpha:1', '--lines', '30').out; }
  assert.match(inside, /1 thread, 1 pane/, `loomctl inside a pane reaches its own Loom:\n${inside}`);
  r = ok('--json', 'read', 'alpha:1', '--lines', '5');
  assert.equal(r.json.ref, 'alpha:1');
  ok('send', 'alpha:1', 'rem typed-not-sent', '--no-enter');
  await pause(500);
  assert.match(ok('read', 'alpha:1').out, /rem typed-not-sent$/m, 'send --no-enter leaves the text at the prompt');
  ok('keys', 'alpha:1', 'ctrl-c');
  console.log('PASS send, send --no-enter, keys and read, and loomctl from inside a pane');

  // Panes and threads, as the window shows them.
  r = ok('--json', 'add', 'alpha', '--agent', 'cmd');
  assert.equal(r.json.ref, 'alpha:2');
  await page.waitForFunction(() => document.querySelectorAll('.grid:not(.hidden) .pane').length === 2);
  ok('layout', 'rows');
  assert.equal(ok('--json', 'threads').json[0].layout, 'rows');
  assert.match(await page.locator('#layout').textContent(), /rows/i, 'The layout button follows');
  ok('zoom', 'alpha:2');
  assert.equal(await page.evaluate(() => document.querySelector('.grid:not(.hidden)').classList.contains('zooming')), true, 'The zoomed pane fills the thread');
  ok('zoom', 'alpha:2');
  ok('wait', 'alpha:2', '--state', 'idle', '--timeout', '20');
  r = loomctl('close', 'alpha:2');
  assert.equal(r.code, 0, `A shell pane closes without --yes: ${r.err}`);
  await page.waitForFunction(() => document.querySelectorAll('.grid:not(.hidden) .pane').length === 1);
  r = ok('--json', 'new', repoB, '--agent', 'cmd', '--panes', '2');
  assert.equal(r.json.name, 'beta');
  assert.equal(r.json.panes.length, 2);
  await page.waitForFunction(() => document.querySelector('#wsname')?.textContent === 'beta');
  assert.equal(await panesShown(), 2);
  ok('rename', 'beta', 'beta renamed');
  await page.waitForFunction(() => document.querySelector('#wsname')?.textContent === 'beta renamed');
  ok('show', 'alpha');
  await page.waitForFunction(() => document.querySelector('#wsname')?.textContent === 'alpha');
  ok('show', 'beta renamed:2');
  await page.waitForFunction(() => document.querySelector('#wsname')?.textContent === 'beta renamed');
  assert.equal(ok('--json', 'status').json.front.ref, 'beta renamed:2', 'show puts the named pane in front');
  r = loomctl('close-thread', 'beta renamed');
  assert.equal(r.code, 1);
  assert.match(r.err, /--yes/, 'Closing a thread with panes asks for --yes');
  ok('close-thread', 'beta renamed', '--yes');
  await page.waitForFunction(() => document.querySelectorAll('.thread').length === 1);
  console.log('PASS add, layout, zoom, close, new, rename, show and close-thread, each visible in the window');

  // Stop and restart keep the pane.
  ok('stop', 'alpha:1', '--yes');
  assert.equal(ok('--json', 'panes').json[0].state, 'exited');
  ok('restart', 'alpha:1');
  ok('wait', 'alpha:1', '--state', 'idle', '--timeout', '20');
  console.log('PASS stop and restart');

  // The views and settings.
  ok('overview', 'open');
  await page.waitForFunction(() => document.body.classList.contains('dashboard-open') || !document.querySelector('#dashboard')?.classList.contains('hidden'));
  ok('overview', 'close');
  ok('theme', 'loom classic');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#0a0f1b');
  ok('theme', 'loom');
  ok('set', 'sound', 'off');
  assert.equal(ok('--json', 'set').json.sound, 'off');
  ok('set', 'sound', 'on');
  console.log('PASS overview, theme and settings');

  // Failures say so, with the right exit codes.
  r = loomctl('nonsense');
  assert.equal(r.code, 1);
  assert.match(r.err, /Unknown command/);
  r = loomctl('send', 'alpha:9', 'x');
  assert.equal(r.code, 1);
  assert.match(r.err, /has 1 pane/);
  r = loomctl('wait-any', '--state', 'waiting', '--timeout', '1');
  assert.equal(r.code, 3, `A wait that runs out exits 3: ${r.err}`);
  r = spawnSync(ctl, ['--profile', join(dir, 'no-such-workspace.json'), 'status'], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'No Loom for that workspace exits 2');
  assert.match(r.stderr, /isn't running/);
  console.log('PASS unknown commands, bad panes, timeouts and a missing Loom');
} finally {
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  for (const s of shared) {
    if (s.had) copyFileSync(s.backup, s.file);
    else rmSync(s.file, { force: true });
  }
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
      if (i === 10) { console.log('Could not remove', dir, e.code); break; }
      await pause(1000);
    }
  }
}
