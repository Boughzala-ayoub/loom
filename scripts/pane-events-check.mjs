// Pane state events against the real app: watch --panes, wait --until and
// webhooks, with a local HTTP server as the receiver. Needs a debug build with
// --features tauri/custom-protocol (loom.exe and loomctl.exe beside it, or
// LOOM_TEST_EXE). A temporary profile and Git folder; one PowerShell pane, no
// agents. A debug Loom keeps its own data folder; the OpenCode plugin it
// rewrites is shared, so it is put back.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
const ctl = join(dirname(exe), 'loomctl.exe');
assert.ok(existsSync(ctl), `loomctl.exe must sit beside ${exe}`);
const plugin = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins/loom.js');
const dir = mkdtempSync(join(tmpdir(), 'loom-pane-events-'));
const pluginBackup = join(dir, 'loom.js.backup'), hadPlugin = existsSync(plugin);
if (hadPlugin) copyFileSync(plugin, pluginBackup);
const repo = join(dir, 'alpha');
mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
const profile = join(dir, 'workspace.json');
writeFileSync(profile, JSON.stringify({ silent: true, ui: { thread: 0 }, threads: [{ repo, dir: repo, branch: '', name: 'alpha', panes: [{ cmd: '' }] }] }));
const pause = ms => new Promise(r => setTimeout(r, ms));

// The receiver: /ok takes everything, /flaky refuses each delivery's first try, /gone is a 404.
const got = { ok: [], flaky: [], gone: [] };
const triedFlaky = new Set();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const name = req.url.slice(1), hit = { headers: req.headers, body, json: JSON.parse(body) };
    got[name]?.push(hit);
    const delivery = req.headers['x-loom-delivery'];
    const status = name === 'gone' ? 404 : name === 'flaky' && !triedFlaky.has(delivery) ? 500 : 200;
    if (name === 'flaky') triedFlaky.add(delivery);
    res.writeHead(status).end();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env };
delete env.LOOM_PIPE; // this check may itself run in a Loom pane
const child = spawn(exe, [profile], { stdio: 'ignore', env });

/** loomctl for this profile: exit code, stdout, stderr, and --json's data.
 * Never spawnSync: it would block this process's HTTP server, the webhooks' receiver. */
function loomctl(...args) {
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
const ok = async (...args) => {
  const r = await loomctl(...args);
  assert.equal(r.code, 0, `loomctl ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
};
const fails = async (pattern, ...args) => {
  const r = await loomctl(...args);
  assert.notEqual(r.code, 0, `loomctl ${args.join(' ')} should fail`);
  assert.match(r.err, pattern);
};
const events = async (...args) => (await ok('--json', 'watch', '--panes', '--timeout', '1', ...args)).json;
/** Until `test()` holds, polling every 200 ms. */
async function until(what, test, ms = 20000) {
  for (const end = Date.now() + ms; !test(); await pause(200)) if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
}
const signed = hit => hit.headers['x-loom-signature'] === 'sha256=' + createHmac('sha256', 's3cret').update(hit.body).digest('hex');

let follower;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { up = (await loomctl('status')).code === 0; if (!up) await pause(500); }
  assert.ok(up, 'The debug Loom must answer loomctl');
  assert.match((await ok('help', 'watch')).out, /--panes/, 'The debug Loom must embed the current frontend (npm run build, then cargo build)');

  // The pane settles idle once PowerShell's prompt is up; webhooks added after that miss its boot event.
  await ok('wait', 'alpha:1', '--until', 'idle', '--timeout', '60');

  // Webhooks are set from loomctl and kept in the workspace file.
  await ok('webhook', 'add', `${base}/ok`, '--secret', 's3cret', '--header', 'X-Key: abc', '--state', 'working,idle,exited');
  await ok('webhook', 'add', `${base}/flaky`, '--state', 'idle');
  await ok('webhook', 'add', `${base}/gone`, '--pane', 'alpha:1');
  let list = (await ok('--json', 'webhook', 'list')).json;
  assert.deepEqual(list.map(h => [h.url.split('/').pop(), h.secret, h.header, h.states.join(), h.panes.join()]),
    [['ok', true, 'X-Key: ...', 'working,idle,exited', ''], ['flaky', false, null, 'idle', ''], ['gone', false, null, '', 'alpha:1']]);
  assert.match((await ok('webhook', 'test', '1')).out, /HTTP 200/);
  assert.ok(got.ok[0].json.test && signed(got.ok[0]) && got.ok[0].headers['x-key'] === 'abc', 'The test delivery is signed and carries the header');
  await fails(/didn't take the test: HTTP 404/, 'webhook', 'test', '3');
  got.ok.length = got.gone.length = 0;
  await fails(/http:\/\/ or https:\/\//, 'webhook', 'add', 'ftp://example.com/x');
  await fails(/--header takes/, 'webhook', 'add', `${base}/ok`, '--header', 'no colon');
  await fails(/go with webhook add/, 'webhook', 'list', '--secret', 'x');
  await until('the workspace file to keep the webhooks', () => (JSON.parse(readFileSync(profile, 'utf8')).webhooks ?? []).length === 3, 5000);
  console.log('PASS webhook add, list, test and their checks; the workspace keeps them');

  const start = (await events()).next;
  follower = spawn(ctl, ['--profile', profile, '--json', 'watch', '--panes', '--follow', '--after', String(start)], { env });
  let followed = '';
  follower.stdout.on('data', d => (followed += d));

  // A command that runs about 4 s: working, then idle, each once.
  await ok('send', 'alpha:1', '1..6 | % { $_; Start-Sleep -Milliseconds 700 }');
  let r = await ok('--json', 'wait', 'alpha:1', '--until', 'working', '--timeout', '20');
  assert.equal(r.json.event.state, 'working');
  r = await ok('--json', 'wait', 'alpha:1', '--until', 'idle', '--timeout', '30');
  const idle = r.json.event;
  assert.deepEqual([idle.old, idle.state, idle.ref, idle.thread, idle.agent, idle.asking, idle.exit], ['working', 'idle', 'alpha:1', 'alpha', 'shell', false, null]);
  assert.ok(idle.tail.some(l => l.trim() === '6'), `The event carries the pane's last lines:\n${idle.tail.join('\n')}`);
  assert.ok(Date.parse(idle.at) <= idle.seq && idle.seq - Date.parse(idle.at) >= 1900, 'at is when the state began, 2 s before it settled');
  let seen = (await events('--after', String(start))).events;
  assert.deepEqual(seen.map(e => `${e.old}>${e.state}`), ['idle>working', 'working>idle']);
  console.log('PASS a 4 s command is one working and one idle event; wait --until follows them');

  // A command shorter than the settle time sends nothing.
  const quiet = (await events()).next;
  await ok('send', 'alpha:1', 'Start-Sleep -Milliseconds 1200');
  await ok('wait', 'alpha:1', '--state', 'working', '--timeout', '5'); // it did show working, so the next assert means something
  await pause(4500);
  assert.deepEqual((await events('--after', String(quiet))).events, [], 'A 1.2 s blip of work must not become events');
  console.log('PASS a blip shorter than 2 s sends no event');

  // Filters.
  assert.deepEqual((await events('--after', String(start), '--state', 'idle')).events.map(e => e.state), ['idle']);
  assert.equal((await events('--after', String(start), '--thread', 'alpha')).events.length, 2);
  assert.equal((await events('--after', String(start), '--pane', 'alpha:1')).events.length, 2);
  await fails(/No thread "nosuch"/, 'watch', '--panes', '--thread', 'nosuch', '--timeout', '1');
  await fails(/--state takes/, 'watch', '--state', 'bogus', '--timeout', '1');
  await fails(/--until takes/, 'wait', 'alpha:1', '--until', 'bogus');
  await fails(/not a task or --metadata/, 'watch', '--panes', '--metadata', '--timeout', '1');
  const later = await events('--after', String(Date.now() + 1000));
  assert.ok(later.events.length === 0 && !later.gap, '--after takes a time: nothing yet after it');
  assert.ok((await events('--after', '1')).gap, 'A number from before this run is a gap');
  console.log('PASS --state, --thread, --pane, --after as a time, gap, and the refusals');

  // The shell exits: an exited event with its code.
  await ok('send', 'alpha:1', 'exit');
  r = await ok('--json', 'wait', 'alpha:1', '--until', 'exited', '--timeout', '30');
  assert.deepEqual([r.json.event.old, r.json.event.state, r.json.event.exit], ['idle', 'exited', 0]);
  console.log('PASS the pane exiting is an exited event with its exit code');

  // What reached the webhooks.
  await until('/ok to get idle>working>idle>exited', () => got.ok.length >= 3);
  assert.deepEqual(got.ok.map(h => `${h.json.old}>${h.json.state}`), ['idle>working', 'working>idle', 'idle>exited']);
  assert.ok(got.ok.every(h => signed(h) && h.headers['x-key'] === 'abc' && h.headers['x-loom-event'] === 'pane-state' && h.headers['x-loom-delivery'] === String(h.json.seq)), 'Each delivery is signed, in order, with its headers');
  await until('/flaky to land its retried idle event', () => got.flaky.length >= 2, 15000);
  assert.deepEqual(got.flaky.map(h => h.json.state), ['idle', 'idle']);
  assert.equal(got.flaky[0].headers['x-loom-delivery'], got.flaky[1].headers['x-loom-delivery'], 'The 500 was retried with the same event');
  await until('/gone to see three events', () => got.gone.length >= 3);
  await pause(3000); // a retry of a 404 would land by now
  assert.equal(got.gone.length, 3, 'A 404 is not retried');
  list = (await ok('--json', 'webhook', 'list')).json;
  assert.deepEqual([list[0].sent, list[1].sent, list[1].failures.length, list[2].sent, list[2].failures.map(f => f.error).join()],
    [3, 1, 0, 0, 'HTTP 404,HTTP 404,HTTP 404']);
  console.log('PASS webhooks: signed and filtered deliveries, a 500 retried, a 404 logged and not retried');

  // The follower saw the same three events as JSON lines.
  const lines = followed.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(e => `${e.old}>${e.state}`), ['idle>working', 'working>idle', 'idle>exited']);
  const text = await loomctl('watch', '--panes', '--follow', '--after', String(start), '--timeout', '3');
  assert.equal(text.code, 3);
  assert.match(text.out, /alpha:1  working -> idle/);
  console.log('PASS watch --panes --follow, as JSON lines and as text');

  await ok('webhook', 'remove', '3');
  assert.equal((await ok('--json', 'webhook', 'list')).json.length, 2);
  await until('the workspace file to drop the webhook', () => JSON.parse(readFileSync(profile, 'utf8')).webhooks.length === 2, 5000);
  console.log('PASS webhook remove');
} finally {
  follower?.kill();
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  server.close();
  if (hadPlugin) copyFileSync(pluginBackup, plugin);
  else rmSync(plugin, { force: true });
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
      if (i === 10) { console.log('Could not remove', dir, e.code); break; }
      await pause(1000);
    }
  }
}
