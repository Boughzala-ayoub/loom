// loomctl's tasks against the real app: the real pipe, loomctl and panes, on a
// temporary profile. A PowerShell pane's tasks (exit codes, --key retries),
// watch --follow across Loom being killed and started again, and the submit
// round trip against the three calls it replaces. With TASK_LIVE_CLAUDE=1 also
// a real Claude Code pane on haiku (a few cents of API use): a prompt start
// and Stop through Loom's hooks, an approval answered with choose, an Esc
// interrupt, a collapsed multi-line paste, and the time from submit to start.
// Needs a build with --features tauri/custom-protocol. Defaults to the debug
// build, whose data folder and pipe are its own, so the installed Loom's
// files and pipe are never touched; LOOM_TEST_EXE picks another.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
const ctl = join(dirname(exe), 'loomctl.exe');
assert.ok(existsSync(ctl), `loomctl.exe must sit beside ${exe}`);
const dir = mkdtempSync(join(tmpdir(), 'loom-task-live-'));
const repo = join(dir, 'alpha');
mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
const claudeDir = process.env.TASK_LIVE_CLAUDE_DIR || resolve('.'); // a folder Claude already trusts
const profile = join(dir, 'workspace.json');
const startups = [{ label: 'powershell', cmd: '' }, { label: 'claude', cmd: 'claude --model haiku --setting-sources project --permission-mode default' }];
writeFileSync(profile, JSON.stringify({ silent: true, startups, ui: { thread: 0 }, threads: [{ repo, dir: repo, branch: '', name: 'alpha', panes: [{ cmd: '' }] }] }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.LOOM_PIPE; // this check may itself run in a Loom pane
let loom;
const start = () => (loom = spawn(exe, [profile], { stdio: 'ignore' }));
const kill = () => spawnSync('taskkill', ['/T', '/F', '/PID', String(loom.pid)], { stdio: 'ignore' });

/** loomctl on this profile: exit code, output, --json's data, and how long it took. */
function loomctl(...args) {
  const t = performance.now();
  const r = spawnSync(ctl, ['--profile', profile, ...args], { encoding: 'utf8', env, timeout: 120000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json, ms: performance.now() - t };
}
const ok = (...args) => {
  const r = loomctl(...args);
  assert.equal(r.code, 0, `loomctl ${args.join(' ')} failed (${r.code}): ${r.err} ${r.out}`);
  return r;
};
const task = (id) => ok('--json', 'task', id).json;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (xs) => `median ${median(xs).toFixed(0)} ms (${xs.map((x) => x.toFixed(0)).join(', ')})`;
async function ready() {
  for (let i = 0; i < 300; i++) {
    if (loomctl('--json', 'status').code === 0) return;
    await pause(200);
  }
  assert.fail('Loom never answered');
}
/** A follower: `watch --follow` as a child, its JSON lines as they come. */
function follow(...args) {
  const c = spawn(ctl, ['--profile', profile, '--json', 'watch', '--follow', ...args], { env });
  const f = { lines: [], err: '', code: null, done: new Promise((r) => c.on('close', (code) => r((f.code = code)))) };
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (buf.slice(0, i).trim()) f.lines.push(JSON.parse(buf.slice(0, i)));
  });
  c.stderr.on('data', (d) => (f.err += d));
  f.kill = () => c.kill();
  return f;
}
const waitFor = async (cond, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (cond()) return;
  assert.fail(`timed out: ${what}`);
};

try {
  start();
  await ready();
  const sh = ok('--json', 'panes').json[0];
  await waitFor(() => loomctl('--json', 'panes').json[0].atPrompt, 20000, 'PowerShell prompt');

  // A shell task: tied by its token, failed with its own exit code.
  const bad = ok('--json', '--key', 'live-1', 'submit', sh.id, 'cmd /c exit 3').json;
  assert.match(bad.task, /^[0-9a-f]{16}$/);
  const failed = ok('--json', 'wait', '--task', bad.task, '--timeout', '20').json;
  assert.deepEqual([failed.state, failed.exit, failed.correlation], ['failed', 3, 'token'], JSON.stringify(failed));
  console.log('PASS a PowerShell task fails with its own exit code');

  // A retry with the same key: the same task, nothing typed again.
  const retry = loomctl('--json', '--key', 'live-1', 'submit', sh.id, 'cmd /c exit 3');
  assert.equal(retry.code, 0, retry.err);
  assert.equal(retry.json.task, bad.task);
  assert.match(retry.err, /didn't run again/);
  assert.equal(ok('--json', 'tasks').json.length, 1);
  console.log('PASS a retried --key submit answers with the same task');

  // The round trip: one submit against the three calls a guarded send took.
  const submitMs = [], threeMs = [], startMs = [];
  for (let i = 0; i < 5; i++) {
    await waitFor(() => loomctl('--json', 'panes').json[0].atPrompt, 20000, 'prompt');
    const r = ok('--json', 'submit', sh.id, `echo task-${i}`);
    submitMs.push(r.ms);
    const done = ok('--json', 'wait', '--task', r.json.task, '--timeout', '20').json;
    assert.equal(done.state, 'completed', JSON.stringify(done));
    startMs.push(Date.parse(done.startedAt) - Date.parse(done.acceptedAt));
    await waitFor(() => loomctl('--json', 'panes').json[0].atPrompt, 20000, 'prompt');
    const t = performance.now();
    ok('--json', 'panes');
    const input = ok('--json', 'read', sh.id).json.input.rev;
    ok('--json', 'send', sh.id, '--receipt', '--input', input, `echo send-${i}`);
    threeMs.push(performance.now() - t);
  }
  console.log(`MEASURE shell: submit ${fmt(submitMs)}; panes+read+send ${fmt(threeMs)}; accepted to started ${fmt(startMs)}`);

  // watch --follow across Loom going away: no event twice, none missed, the restart's own included.
  const long = ok('--json', 'submit', sh.id, 'Start-Sleep 120').json.task;
  ok('wait', '--task', long, '--until', 'working', '--timeout', '20');
  const before = ok('--json', 'watch', '--after', '0').json;
  const f = follow('--after', String(before.events.find((e) => e.task === long).seq - 1), '--timeout', '120');
  await waitFor(() => f.lines.some((e) => e.task === long && e.state === 'working'), 15000, 'the follower sees the working task');
  kill();
  await waitFor(() => /Trying again every second/.test(f.err), 15000, `the follower says it lost Loom: ${f.err}`);
  start();
  await ready();
  await waitFor(() => f.lines.some((e) => e.task === long && e.state === 'unknown'), 30000, `the follower gets the restart's event: ${f.err}`);
  const seqs = f.lines.map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), `Each event once, in order: ${seqs}`);
  assert.deepEqual(f.lines.filter((e) => e.task === long).map((e) => e.state), ['accepted', 'submitted', 'working', 'unknown'], JSON.stringify(f.lines));
  assert.equal(task(long).reason, 'loom-restarted');
  assert.match(f.err, /reached Loom again/);
  f.kill();
  // After the restart the journal still answers for the old key, and types nothing.
  const after = loomctl('--json', '--key', 'live-1', 'submit', sh.id, 'cmd /c exit 3'); // the same words, though that pane id is gone
  assert.equal(after.json.task, bad.task, after.err);
  const one = follow(bad.task);
  assert.equal(await one.done, 0, 'Following a finished task stops');
  assert.deepEqual(one.lines.map((e) => e.state), ['accepted', 'submitted', 'working', 'failed']);
  console.log('PASS watch --follow reconnects after Loom restarts: each event once, the unknown outcome included; keys outlive the restart');

  // A follow that ends is still JSON lines, its failure included (review P2).
  const last = ok('--json', 'watch', '--after', '0').json.last;
  for (const [args, exit, code] of [[['--after', String(last), '--timeout', '3'], 3, 'timeout'], [['nosuchtask'], 1, 'failed']]) {
    const r = spawnSync(ctl, ['--profile', profile, '--json', 'watch', '--follow', ...args], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r.status, exit, r.stderr);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l)); // throws on a line that isn't JSON alone
    assert.deepEqual([lines.at(-1).ok, lines.at(-1).code, typeof lines.at(-1).next], [false, code, 'number'], r.stdout);
  }
  console.log('PASS watch --follow --json ends, on a timeout or a failure, with one more JSON line');

  if (process.env.TASK_LIVE_CLAUDE) {
    const pane = ok('--json', 'new', claudeDir, '--agent', 'claude').json.panes[0];
    // Claude drops a paste sent while it starts: wait for its input, then a little more.
    await waitFor(() => ['empty', 'suggestion'].includes(loomctl('--json', 'read', pane.id).json?.input?.kind), 60000, 'Claude input');
    await pause(5000);
    const timings = [];
    for (let i = 0; i < 3; i++) {
      const r = ok('--json', 'submit', pane.id, `Reply with exactly the word PONG${i}.`);
      const t0 = performance.now();
      let seen;
      for (; !seen && performance.now() - t0 < 30000; await pause(25)) if (task(r.json.task).state !== 'submitted') seen = performance.now() - t0;
      const done = ok('--json', 'wait', '--task', r.json.task, '--timeout', '120').json;
      assert.deepEqual([done.state, done.correlation], ['completed', 'prompt'], JSON.stringify(done));
      timings.push({ cli: r.ms, typing: Date.parse(done.submittedAt) - Date.parse(done.acceptedAt), hook: Date.parse(done.startedAt) - Date.parse(done.submittedAt), seen });
      await pause(1500);
    }
    console.log(`MEASURE claude: submit call ${fmt(timings.map((t) => t.cli))}; accepted to Enter ${fmt(timings.map((t) => t.typing))}; Enter to Claude's start report ${fmt(timings.map((t) => t.hook))}; submit returned to loomctl seeing it start ${fmt(timings.map((t) => t.seen))}`);

    // A collapsed multi-line paste still ties by the prompt Claude reports.
    const lines = ['Reply with exactly the word LINES.', ...Array.from({ length: 40 }, (_, i) => `\tfiller line ${i}  `)].join('\r\n');
    const multi = spawnSync(ctl, ['--profile', profile, '--json', 'submit', pane.id, '-'], { input: lines, encoding: 'utf8', env });
    assert.equal(multi.status, 0, multi.stderr);
    const multiDone = ok('--json', 'wait', '--task', JSON.parse(multi.stdout).task, '--timeout', '120').json;
    assert.deepEqual([multiDone.state, multiDone.correlation], ['completed', 'prompt'], JSON.stringify(multiDone));
    console.log('PASS a 41-line paste with tabs and CRLF ties by the prompt Claude reports');

    // Approval: Claude asks to write outside its folder; choose answers; the turn completes.
    await pause(1500);
    const target = join(dir, 'approved.txt');
    const ask = ok('--json', 'submit', pane.id, `Use the Write tool to create the file ${target} containing the word hi. Then reply DONE.`).json.task;
    const asked = ok('--json', 'wait', '--task', ask, '--timeout', '120').json;
    assert.deepEqual([asked.state, asked.detail], ['approval', 'Write'], JSON.stringify(asked));
    const menu = ok('--json', 'menu', pane.id).json;
    ok('choose', pane.id, '1', '--menu', menu.rev);
    const approved = ok('--json', 'wait', '--task', ask, '--timeout', '120').json;
    assert.equal(approved.state, 'completed', JSON.stringify(approved));
    const states = approved.events.map((e) => e.state);
    assert.deepEqual(states.slice(states.indexOf('approval')), ['approval', 'working', 'completed'], `Asked, answered, done: ${states}`);
    assert.ok(existsSync(target), 'Claude wrote the file it asked to');
    console.log('PASS approval: PermissionRequest asks, choose answers, Stop completes');

    // Interrupt: Esc while Claude writes; it reports nothing (no Stop), and Loom sees it stop.
    await pause(1500);
    const story = loomctl('--json', 'submit', pane.id, 'Write a 1500 word story about a lighthouse keeper.');
    if (story.code !== 0) console.log(`submit refused; the screen:\n${loomctl('read', pane.id).out}\n${JSON.stringify(loomctl('--json', 'read', pane.id).json?.input)}`);
    assert.equal(story.code, 0, story.err);
    const busy = story.json.task;
    ok('wait', '--task', busy, '--until', 'working', '--timeout', '60');
    await pause(1500);
    ok('keys', pane.id, 'esc');
    const stopped = ok('--json', 'wait', '--task', busy, '--timeout', '30').json;
    assert.deepEqual([stopped.state, stopped.reason], ['cancelled', 'interrupted'], JSON.stringify(stopped));
    console.log('PASS an Esc interrupt ends the task cancelled, with no hook to say so');
  }
} finally {
  if (loom) kill();
  await pause(500);
  rmSync(dir, { recursive: true, force: true });
}
