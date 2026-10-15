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
import { createServer, connect } from 'node:net';
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
/** loomctl without waiting, for commands that must overlap. */
function loomctlAsync(...args) {
  const env = { ...process.env };
  delete env.LOOM_PIPE;
  return new Promise(done => {
    const c = spawn(ctl, ['--profile', profile, ...args], { env });
    let out = '', err = '';
    c.stdout.on('data', d => (out += d));
    c.stderr.on('data', d => (err += d));
    c.on('close', code => {
      let json;
      try { json = JSON.parse(out); } catch { json = undefined; }
      done({ code, out: out.trim(), err: err.trim(), json });
    });
  });
}
const gitInit = name => {
  const r = join(dir, name);
  mkdirSync(r);
  spawnSync('git', ['init', '-q', r]);
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

  // LOOM_CLI_REVIEW.md's findings, as they would bite.
  // F1: an on/off option never takes the next word, before or after the target.
  ok('add', 'alpha', '--agent', 'cmd');
  ok('wait', 'alpha:2', '--state', 'idle', '--timeout', '20');
  const firstId = ok('--json', 'panes').json[0].id;
  ok('show', 'alpha:1');
  ok('close', '--yes', 'alpha:2');
  await page.waitForFunction(() => document.querySelectorAll('.grid:not(.hidden) .pane').length === 1);
  assert.deepEqual(ok('--json', 'panes').json.map(p => p.id), [firstId], 'close --yes alpha:2 closed alpha:2, not the pane in front');
  ok('send', '--no-enter', 'alpha:1', 'rem', 'flag-first');
  await pause(500);
  assert.match(ok('read', 'alpha:1').out, /rem flag-first$/m, 'send --no-enter before the pane still types all the words');
  ok('keys', 'alpha:1', 'ctrl-c');
  r = loomctl('close', '--yes=alpha:1');
  assert.equal(r.code, 1, '--yes=<something else> is refused, not read as a target');
  // F2: a pane's LOOM_PIPE is its own Loom's process pipe, whoever holds the workspace's.
  ok('send', 'alpha:1', 'echo pipe=%LOOM_PIPE%');
  await pause(800);
  assert.match(ok('read', 'alpha:1', '--lines', '10').out, new RegExp(`^pipe=.*-pid${child.pid}$`, 'm'), 'Panes get their Loom\'s own pipe');
  // F4: two sends at once reach the pane as two commands.
  const sends = await Promise.all([loomctlAsync('send', 'alpha:1', 'echo first-of-two'), loomctlAsync('send', 'alpha:1', 'echo second-of-two')]);
  assert.deepEqual(sends.map(s => s.code), [0, 0], JSON.stringify(sends));
  await pause(800);
  const both = ok('read', 'alpha:1', '--lines', '40').out;
  assert.match(both, /^first-of-two$/m, both);
  assert.match(both, /^second-of-two$/m, both);
  assert.doesNotMatch(both, /first-of-twoecho|second-of-twoecho/, 'The texts did not run together');
  // F6: two new threads at once each answer with their own.
  const gamma = gitInit('gamma dir');
  const delta = gitInit('delta');
  const made = await Promise.all([loomctlAsync('--json', 'new', gamma, '--agent', 'cmd'), loomctlAsync('--json', 'new', delta, '--agent', 'cmd')]);
  assert.deepEqual(made.map(m => m.code), [0, 0], JSON.stringify(made.map(m => m.err)));
  assert.deepEqual(made.map(m => m.json.name), ['gamma dir', 'delta'], 'Each new answers with the thread it opened');
  assert.notEqual(made[0].json.id, made[1].json.id);
  ok('close-thread', 'delta', '--yes');
  // F3: two deletes of one worktree at once, both past the risk check before
  // either removes it: one deletes it, the other says so, the rest stay.
  spawnSync('git', ['-C', delta, '-c', 'user.name=check', '-c', 'user.email=check@loom', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const zeta = ok('--json', 'new', delta, '--name', 'race', '--agent', 'cmd').json;
  const closes = await Promise.all([1, 2].map(() => loomctlAsync('close-thread', zeta.name, '--yes', '--delete', 'worktree')));
  assert.deepEqual(closes.map(c => c.code).sort(), [0, 1], JSON.stringify(closes));
  assert.match(closes.find(c => c.code === 1).err, /already clos|No thread/);
  assert.deepEqual(ok('--json', 'threads').json.map(t => t.name), ['alpha', 'gamma dir'], 'No other thread was dropped');
  assert.ok(!existsSync(zeta.dir), 'The worktree is gone');
  // F8: a relative folder is relative to the terminal loomctl ran in, spaces and all.
  const epsilon = gitInit('epsilon dir');
  const env = { ...process.env };
  delete env.LOOM_PIPE;
  r = spawnSync(ctl, ['--profile', profile, '--json', 'new', '.', '--agent', 'cmd'], { cwd: epsilon, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dir.toLowerCase(), epsilon.toLowerCase(), 'new . opened the terminal\'s folder');
  // F9: --json prints null for an answer with nothing in it.
  r = ok('--json', 'menu', 'alpha:1');
  assert.equal(r.out, 'null');
  assert.equal(JSON.parse(r.out), null);
  // F10: a fractional pane count is refused before git makes anything.
  r = loomctl('new', repoA, '--name', 'half', '--panes', '1.5');
  assert.equal(r.code, 1);
  assert.match(r.err, /whole number/);
  // A bad --mix is refused before git makes anything too.
  for (const [mix, why] of [['{"nope":1}', /--mix takes .*not nope/], ['{"cmd":0}', /counts are 1 to 16/], ['{"cmd":9,"powershell":8}', /1 to 16 panes, not 17/], ['[1]', /--mix takes/], ['{}', /not 0/]]) {
    r = loomctl('new', repoA, '--name', 'half', '--mix', mix);
    assert.equal(r.code, 1, mix);
    assert.match(r.err, why);
  }
  assert.match(loomctl('new', repoA, '--name', 'half', '--mix', '{"cmd":1}', '--panes', '2').err, /takes the place of/);
  assert.equal(spawnSync('git', ['-C', repoA, 'branch', '--list', 'loom/half'], { encoding: 'utf8' }).stdout.trim(), '', 'No branch was cut');
  assert.ok(!existsSync(join(homedir(), 'loom', 'alpha', 'half')), 'No worktree was made');
  ok('close-thread', 'epsilon dir', '--yes');
  ok('close-thread', 'gamma dir', '--yes');
  console.log('PASS the review\'s findings: flags, pane pipes, overlapping sends, news and closes, relative folders, null JSON, whole counts');

  // LOOM_CLI_AGENT_REVIEW.md, against the real app and the real loomctl.
  const info = ok('--json', 'info').json;
  assert.equal(info.pid, child.pid);
  assert.equal(info.protocol, 3);
  assert.ok(info.pipe.endsWith(`-pid${child.pid}`), info.pipe);
  // A1: a loomctl from before the hello is refused, and its command never runs.
  const panesBefore = ok('--json', 'panes').json.map(p => p.id);
  const oldReply = await new Promise((done, fail) => {
    const s = connect(info.pipe, () => s.write(JSON.stringify({ cmd: 'close', args: { _: [panesBefore[0]], yes: true }, timeout: 30 }) + '\n'));
    let got = '';
    s.on('data', d => (got += d));
    s.on('end', () => done(JSON.parse(got)));
    s.on('error', fail);
  });
  assert.equal(oldReply.ok, false, JSON.stringify(oldReply));
  assert.match(oldReply.error, /loomctl is older/);
  await pause(300);
  assert.deepEqual(ok('--json', 'panes').json.map(p => p.id), panesBefore, 'Nothing was closed');
  // A1: this loomctl, reaching a Loom from before the hello, stops at the hello.
  const oldPipe = `\\\\.\\pipe\\loom-cli-check-old-${process.pid}`;
  const heard = [];
  const oldLoom = createServer(s => {
    let buf = '';
    s.on('data', d => {
      buf += d;
      if (!buf.includes('\n')) return;
      heard.push(JSON.parse(buf.split('\n')[0]));
      s.end(JSON.stringify({ ok: false, error: 'Unknown command "null". loomctl help lists them.' }) + '\n');
    });
  });
  await new Promise(r => oldLoom.listen(oldPipe, r));
  r = await new Promise(done => {
    const c = spawn(ctl, ['close', 'alpha:1', '--yes'], { env: { ...process.env, LOOM_PIPE: oldPipe } });
    let err = '';
    c.stderr.on('data', d => (err += d));
    c.on('close', code => done({ code, err }));
  });
  oldLoom.close();
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /older than this loomctl/);
  assert.deepEqual(heard.map(h => Object.keys(h)), [['hello']], 'Only the hello reached it, never the command');
  // A5: standard input starting with -- is text, all of it.
  const plain = { ...process.env };
  delete plain.LOOM_PIPE;
  r = spawnSync(ctl, ['--profile', profile, 'send', 'alpha:1', '-'], { input: '--no-enter & echo stdin-was-text\r\n', encoding: 'utf8', env: plain });
  assert.equal(r.status, 0, r.stderr);
  await pause(800);
  const screen = ok('read', 'alpha:1', '--lines', '15').out;
  assert.match(screen, />--no-enter & echo stdin-was-text$/m, screen);
  assert.match(screen, /^stdin-was-text$/m, 'The line ran, so Enter was pressed');
  // Failures under --json are JSON too.
  r = loomctl('--json', 'read', 'nosuch:9');
  assert.equal(r.code, 1);
  assert.equal(r.json?.ok, false, r.out);
  assert.match(r.json.error, /nosuch/);
  console.log('PASS the agent review: info, both kinds of old loomctl and Loom refused before a command, stdin as text, JSON failures');

  // Second agent review. R2 and R4: every failure under --json is one JSON
  // object with a code and whether the command went out, and a Loom that
  // never answers the hello can't hold loomctl.
  const fakeLoom = answer => new Promise(ready => {
    const pipe = `\\\\.\\pipe\\loom-cli-check-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const heard = [];
    const server = createServer(s => {
      let buf = '';
      s.on('error', () => {});
      s.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
          heard.push(JSON.parse(buf.slice(0, i)));
          answer(s, heard.at(-1));
        }
      });
    });
    server.listen(pipe, () => ready({ pipe, heard, close: () => server.close() }));
  });
  const via = (pipe, ...args) => new Promise(done => {
    const t0 = Date.now();
    const c = spawn(ctl, args, { env: { ...process.env, LOOM_PIPE: pipe } });
    let out = '', err = '';
    c.stdout.on('data', d => (out += d));
    c.stderr.on('data', d => (err += d));
    c.on('close', code => {
      let json;
      try { json = JSON.parse(out); } catch { json = undefined; }
      done({ code, out, err, json, ms: Date.now() - t0 });
    });
  });
  const shape = r => [r.code, r.json?.ok, r.json?.code, r.json?.sent];
  // A PowerShell pane takes typing once its prompt is drawn and PSReadLine is reading: text sent sooner can be lost.
  const atPrompt = async id => {
    for (let i = 0; i < 80 && !ok('--json', 'panes').json.find(p => p.id === id)?.atPrompt; i++) await pause(250);
    await pause(500);
  };
  r = loomctl('--json', 'read', '--timeout', 'soon');
  assert.deepEqual(shape(r), [1, false, 'usage', false], r.out);
  r = await via(`\\\\.\\pipe\\loom-cli-check-nobody-${process.pid}`, '--json', 'status');
  assert.deepEqual(shape(r), [2, false, 'not-running', false], r.out);
  const helloOk = { ok: true, protocol: info.protocol, version: info.version, pid: 1, pipe: 'fake' };
  let fakeOne = await fakeLoom((s, line) => line.hello && s.end(JSON.stringify({ ok: false, error: 'Unknown command "null".' }) + '\n'));
  r = await via(fakeOne.pipe, '--json', 'close', 'alpha:1', '--yes');
  fakeOne.close();
  assert.deepEqual(shape(r), [2, false, 'version', false], r.out);
  fakeOne = await fakeLoom(() => {}); // takes the hello, never answers
  r = await via(fakeOne.pipe, '--json', '--timeout', '1', 'close', 'alpha:1', '--yes');
  fakeOne.close();
  assert.deepEqual(shape(r), [3, false, 'timeout', false], r.out + r.err);
  assert.ok(r.ms < 6000, `A silent hello held loomctl ${r.ms} ms`);
  assert.deepEqual(fakeOne.heard.map(h => Object.keys(h)), [['hello']], 'No command went to a Loom that never said hello');
  fakeOne = await fakeLoom((s, line) => (line.hello ? s.write(JSON.stringify(helloOk) + '\n') : s.destroy()));
  r = await via(fakeOne.pipe, '--json', 'close', 'alpha:1', '--yes');
  fakeOne.close();
  assert.deepEqual(shape(r), [2, false, 'connection', true], r.out);
  assert.match(r.json.error, /may have run/);
  r = loomctl('--json', 'wait', 'alpha:1', '--state', 'exited', '--timeout', '1');
  assert.deepEqual(shape(r), [3, false, 'timeout', true], r.out);
  r = loomctl('--json', 'read', 'nosuch:9');
  assert.deepEqual(shape(r), [1, false, 'failed', true], r.out);
  // A real shell pane's exit code, and --gen from what panes showed.
  const shell = ok('--json', 'add', 'alpha', '--cmd=').json;
  await atPrompt(shell.id);
  // The way a script reads an outcome: note commands, send, wait for it to grow.
  // (The startup command counts too: the first prompt reports it.)
  const shellNow = () => ok('--json', 'panes', '--thread', 'alpha').json.find(q => q.id === shell.id);
  const outcome = async line => {
    const base = shellNow().commands;
    ok('send', shell.ref, line);
    let p;
    for (let i = 0; i < 40 && (p = shellNow()).commands <= base; i++) await pause(250);
    return [p.commands - base, p.failed, p.exit, p];
  };
  let [, , , shown] = await outcome('cmd /c exit 7');
  assert.deepEqual([shown.failed, shown.exit], [true, 7], JSON.stringify(shown));
  ok('send', shell.ref, '--gen', String(shown.generation), 'cmd /c exit 0');
  ok('restart', shell.ref, '--yes');
  r = loomctl('--json', 'send', shell.ref, '--gen', String(shown.generation), 'echo stale');
  assert.deepEqual(shape(r), [1, false, 'failed', true], r.out);
  assert.match(r.json.error, /was restarted before Loom typed anything/);
  console.log('PASS the second agent review: JSON for every failure, a silent hello bounded, shell exit codes, --gen');

  // Third agent review. S2: exit is the exact code or null, never a guess.
  await atPrompt(shell.id);
  const exits = [];
  for (const line of ['cmd /c exit 7', 'cmd /c exit 7', "Get-Item 'C:\\nope-loom' -ErrorAction SilentlyContinue", 'cmd /c exit 0']) exits.push((await outcome(line)).slice(0, 3));
  assert.deepEqual(exits, [[1, true, 7], [1, true, null], [1, true, null], [1, false, 0]], 'A repeated 7 and a failed cmdlet have no exact code, not 1 or a stale 7');
  assert.ok(shellNow().generation > shown.generation, 'The restart moved the generation on');
  ok('close', shell.ref, '--yes');
  // S1: a request cut off before its newline never runs, over the real pipe.
  const victim = ok('--json', 'add', 'alpha', '--cmd=').json;
  await new Promise(done => {
    const s = connect(info.pipe, () => s.write(JSON.stringify({ hello: info.protocol }) + '\n'));
    let got = '', sent = false;
    s.on('data', d => {
      got += d;
      if (sent || !got.includes('\n')) return;
      sent = true;
      s.end(JSON.stringify({ cmd: 'close', argv: [victim.id, '--yes'], stdin: null, cwd: dir, timeout: 30 }));
      setTimeout(() => s.destroy(), 1500);
    });
    s.on('close', done);
    s.on('error', () => {});
  });
  await pause(800);
  assert.ok(ok('--json', 'panes').json.some(p => p.id === victim.id), 'A close without its newline did not run');
  ok('close', victim.ref, '--yes');
  console.log('PASS the third agent review: exact or unknown shell exit codes, cut-off requests never run');

  // A Loom on protocol 2 drops --key without a word, so this loomctl refuses it
  // at the hello: a keyed send never reaches it.
  fakeOne = await fakeLoom((s, line) => line.hello && s.write(JSON.stringify({ ...helloOk, protocol: 2 }) + '\n'));
  r = await via(fakeOne.pipe, '--json', '--key', 'old-app-task', 'send', 'p1', '--no-enter', 'task');
  fakeOne.close();
  assert.deepEqual(shape(r), [2, false, 'version', false], r.out);
  assert.deepEqual(fakeOne.heard.map(h => Object.keys(h)), [['hello']], 'Only the hello reached the protocol-2 Loom');
  // --key: a retry of a real add gets the first pane, not a second one.
  const panesBeforeKey = ok('--json', 'panes').json.length;
  const keyed1 = ok('--json', '--key', `check-${process.pid}`, 'add', 'alpha', '--cmd=');
  const keyed2 = ok('--json', '--key', `check-${process.pid}`, 'add', 'alpha', '--cmd=');
  assert.equal(keyed2.json.id, keyed1.json.id, 'The retry answers with the first pane');
  assert.match(keyed2.err, /didn't run again/);
  assert.equal(ok('--json', 'panes').json.length, panesBeforeKey + 1, 'One pane, not two');
  r = loomctl('--json', '--key', `check-${process.pid}`, 'status');
  assert.deepEqual(shape(r), [1, false, 'failed', true], r.out);
  // A receipt from a real PowerShell prompt: its own command's exit code.
  const rcpt = keyed1.json;
  await atPrompt(rcpt.id);
  const token = ok('send', rcpt.ref, '--receipt', 'cmd /c exit 4').out;
  assert.match(token, /^[0-9a-f]{16}$/);
  r = ok('--json', 'wait', '--receipt', token, '--timeout', '20');
  assert.deepEqual([r.json.done, r.json.failed, r.json.exit], [true, true, 4], r.out);
  assert.match(ok('read', rcpt.ref, '--lines', '5').out, /cmd \/c exit 4 {2}# loom-receipt:/);
  ok('close', rcpt.ref, '--yes');
  console.log('PASS --key retries and a shell receipt, against the real app');

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
