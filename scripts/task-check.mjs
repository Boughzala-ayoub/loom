// loomctl's tasks (submit, task, tasks, wait --task, watch) against the built
// page, over Tauri's mocks, the way ui-check.mjs drives loomctl. The agents are
// fakes in the page: a Claude-like input box that echoes pastes and shows "esc
// to interrupt" while busy, and Loom's PowerShell marks for a shell. What the
// agents report comes in as the agent-events Rust would emit, stamped with the
// launch that sent it, so every case sends exactly the signals a real agent
// would, or doesn't. The cases marked "review" reproduce the findings of
// docs/reviews/LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_005726.md,
// "follow-up" those of ..._FOLLOWUP_REVIEW_2026-10-02_020625.md, "third
// review" those of ..._REVIEW_2026-10-02_030207.md, "fourth review" those of
// ..._REVIEW_2026-10-02_035349.md, "fifth review" that of
// ..._REVIEW_2026-10-02_074959.md (one case runs the real `loom.exe
// --claude-hook` from LOOM_TEST_EXE or the debug build, when there is one),
// "sixth review" that of ..._REVIEW_2026-10-02_105046.md, and "seventh
// review" that of ..._REVIEW_2026-10-02_120244.md.
// Build, then `npx vite preview --port 4273 --strictPort`, then run this.
// TASK_QUICK=1 skips the 30 s idle cases.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { promptMatch, readJournal } from '../src/task.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RESP_BASE || 'http://localhost:4273';
assert.equal((await fetch(base)).status, 200, 'The preview must be serving');
const mocks = readFileSync('node_modules/@tauri-apps/api/mocks.js', 'utf8').replace(/^export \{.*$/m, '');

const setup = () => {
  const repo = 'C:\\projects\\loom';
  const state = { repos: [repo], threads: [{ repo, dir: `${repo}\\work`, branch: 'loom/work', name: 'work', panes: [{ cmd: 'claude' }, { cmd: 'codex' }, { cmd: 'claude' }] }], ui: { thread: 0 } };
  const qa = window.qa = { calls: [], panes: [], agents: {}, prompts: [], journalHeld: [], heldWrites: [], failWriteIf: null, noEcho: false, ignoreEsc: false, idleAfterEnter: false, shellHang: false };
  const out = (id) => qa.panes.filter((a) => a.id === id).at(-1).onOut;
  qa.out = (id, data) => out(id).onmessage(data);
  // An agent's screen: transcript line, a rule, its input, a rule, a footer that says busy.
  qa.draw = (id) => {
    const a = qa.agents[id], rule = '─'.repeat(60);
    if (a.dialog) return out(id).onmessage(`\x1b[2J\x1b[H ${a.dialog}\r\n  Enter to allow · Esc to deny\r\n`); // unnumbered, no hint
    const top = a.menu ? ` ${a.menu}\r\n ❯ 1. Yes\r\n   2. No (esc)` : ' Agent';
    out(id).onmessage(`\x1b[2J\x1b[H${top}\r\n${rule}\r\n❯ ${a.input}\r\n${rule}\r\n  ${a.busy ? 'esc to interrupt' : '? for shortcuts'}\r\n`);
  };
  const shellPrompt = '\x1b]133;A\x07PS> \x1b]133;B\x07';
  const mockAudio = { connect() { return mockAudio; }, start() {}, stop() {}, frequency: { setValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
  window.AudioContext = class { state = 'running'; currentTime = 0; destination = mockAudio; resume() {} createGain() { return mockAudio; } createOscillator() { return mockAudio; } };
  mockWindows('main');
  mockIPC((cmd, args = {}) => {
    qa.calls.push({ cmd, args });
    if (cmd === 'load_state') return JSON.stringify(state);
    // The journal outlives a reload, as the file outlives Loom. A write can be
    // refused (a full disk) or held (still in flight when Loom "crashes").
    if (cmd === 'task_journal_read') {
      if (localStorage.getItem('qa-journal-unreadable')) throw new Error('Test: access is denied');
      return localStorage.getItem('qa-journal') ?? '';
    }
    if (cmd === 'task_journal_write') {
      if (qa.journalFail || qa.journalFailIf?.(args.text)) throw new Error('Test: the disk is full');
      const write = () => localStorage.setItem('qa-journal', (args.append ? localStorage.getItem('qa-journal') ?? '' : '') + args.text);
      if (qa.journalHold?.(args.text)) return new Promise((resolve) => qa.journalHeld.push(() => (write(), resolve())));
      return void write();
    }
    if (cmd === 'pty_spawn') {
      qa.panes.push(args);
      const shell = args.argv[0] === 'powershell.exe';
      // Agents turn bracketed paste on, as Claude Code and Codex do, so a paste arrives as one.
      qa.agents[args.id] = shell ? { shell: true, line: '' } : { input: '', busy: false, menu: null };
      setTimeout(() => (shell ? out(args.id).onmessage(shellPrompt) : (out(args.id).onmessage('\x1b[?2004h'), qa.draw(args.id))), 0);
      return;
    }
    if (cmd === 'pty_write') {
      if (qa.failWriteIf?.(args.data)) throw new Error('Test: the terminal write failed');
      if (qa.holdWriteIf?.(args.data)) return new Promise((resolve, reject) => qa.heldWrites.push({ resolve, reject }));
      const lost = qa.loseReplyIf?.(args.data);
      const a = qa.agents[args.id];
      if (!a) return;
      const data = args.data;
      if (a.shell) {
        if (data !== '\r') { a.line += data; out(args.id).onmessage(data); return; }
        const line = a.line; a.line = '';
        if (qa.shellHang) return; // the line never runs: no marks
        const code = /exit (\d+)/.exec(line)?.[1] ?? '0';
        setTimeout(() => out(args.id).onmessage(`\x1b]133;E;${line}\x07\x1b]133;C\x07\r\n\x1b]133;D;${code}\x07${shellPrompt}`), 50);
        if (lost) throw new Error('Test: the terminal took it, and its answer was lost');
        return;
      }
      if (data.startsWith('\x1b[200~')) { if (!qa.noEcho) a.input += data.slice(6, -6); }
      else if (data === '\r') { if (a.input) { qa.prompts.push([args.id, a.input]); a.input = ''; a.busy = !qa.idleAfterEnter; } }
      else if (data === '\x1b') { if (!qa.ignoreEsc) a.busy = false; }
      else if (data === '\x15') a.input = ''; // Ctrl-U clears the input
      else if (!a.menu && !data.startsWith('\x1b')) a.input += data;
      qa.draw(args.id);
      if (lost) throw new Error('Test: the terminal took it, and its answer was lost');
      return;
    }
    if (cmd === 'plugin:window|is_focused') return true;
    if (cmd === 'plugin:path|resolve_directory') return 'C:\\Users\\test';
    if (cmd === 'plugin:path|join') return args.paths.join('\\');
    if (cmd === 'take_sessions' || cmd === 'model_options') return [];
    if (cmd === 'session_usage' || cmd === 'last_messages') return {};
    if (cmd === 'has_session' || cmd === 'pane_booted' || cmd === 'has_codex_session') return true;
    if (cmd === 'git_run') return args.args.includes('--show-toplevel') ? args.dir : args.args[0] === 'rev-parse' ? 'main' : '';
    if (cmd === 'plan_usage' || cmd === 'codex_plan_usage') throw new Error('not in this check');
  }, { shouldMockEvents: true });
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
const ok = (label) => { checks++; console.log(`ok   ${label}`); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript({ content: `${mocks}\n(${setup})();` });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.evaluate(() => localStorage.removeItem('qa-journal'));
  const boot = async () => {
    await page.goto(base);
    await page.waitForFunction(() => window.qa.calls.some((c) => c.cmd === 'cli_ready') && window.qa.panes.length >= 3);
    await page.waitForTimeout(300);
  };
  await boot();

  const call = (cmd, argv, stdin, key, timeout = 5) => page.evaluate(async ([cmd, argv, stdin, key, timeout]) => {
    const id = window.qa.cliIds = (window.qa.cliIds ?? 0) + 1;
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'cli', payload: { id, cmd, argv, stdin, cwd: null, timeout, key } });
    for (const end = Date.now() + 60000; Date.now() < end;) {
      const reply = window.qa.calls.find((c) => c.cmd === 'cli_reply' && c.args.id === id);
      if (reply) return reply.args.reply;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { hung: [cmd, ...argv].join(' ') };
  }, [cmd, argv, stdin ?? null, key ?? null, timeout]);
  const cli = (cmd, ...argv) => call(cmd, argv);
  const paneId = async (ref) => (await cli('panes')).data.find((p) => p.ref === ref).id;
  const gen = async (id) => (await cli('panes')).data.find((p) => p.id === id).generation;
  /** What Rust's send_task_events would emit for these reports from a pane:
   * stamped with its running launch, unless an event names one (null: none). */
  const report = async (id, ...events) => {
    const launch = await gen(id);
    const stamped = events.map(({ launch: l, ...e }) => (l === null ? e : { ...e, launch: l ?? launch }));
    await page.evaluate(([id, events]) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'agent-events', payload: events.map((e) => [id, { t: Date.now(), ...e }]) }), [id, stamped]);
  };
  const agent = (id, set) => page.evaluate(([id, set]) => { Object.assign(window.qa.agents[id], set); window.qa.draw(id); }, [id, set]);
  /** Claude stops as it really does: idle on screen, and its Stop hook reports. */
  const stops = async (id) => { await agent(id, { busy: false }); await report(id, { kind: 'stop' }); };
  const qa = (set) => page.evaluate((set) => {
    for (const [k, v] of Object.entries(set)) window.qa[k] = typeof v === 'string' && v.startsWith('fn:') ? new Function('d', v.slice(3)) : v;
  }, set);
  const prompts = (id) => page.evaluate((id) => window.qa.prompts.filter(([p]) => p === id).map(([, t]) => t), id);
  const pastes = (id) => page.evaluate((id) => window.qa.calls.filter((c) => c.cmd === 'pty_write' && c.args.id === id && c.args.data.startsWith('\x1b[200~')).length, id);
  /** The task as the journal would bring it back after a restart. */
  const saved = async (id) => readJournal(await page.evaluate(() => localStorage.getItem('qa-journal') ?? '')).tasks.get(id);
  const journalTask = async (id) => (await page.evaluate(() => localStorage.getItem('qa-journal') ?? '')).split('\n').flatMap((l) => { try { const r = JSON.parse(l); return r.task?.id === id ? [r.task] : []; } catch { return []; } }).at(-1);
  const state = async (task) => (await cli('task', task)).data;
  const until = async (task, want, ms = 4000) => {
    const end = Date.now() + ms;
    let t;
    while (Date.now() < end) { t = await state(task); if (t.state === want) return t; await page.waitForTimeout(100); }
    assert.fail(`task ${task} stayed ${t?.state}, expected ${want}: ${JSON.stringify(t)}`);
  };

  let claude = await paneId('work:1');
  let codex = await paneId('work:2');
  /** Loom restarted (a reload): the panes have new ids. */
  const reboot = async () => {
    await boot();
    claude = await paneId('work:1');
    codex = await paneId('work:2');
  };
  const timing = [];
  let sh;
  /** Sixth and seventh reviews' tasks, checked again across a restart: [ref, text, key, task, state, uncertain]. */
  const acrossRestart = [];

  // Claude, end to end: accepted, submitted, working on its prompt's report, completed on Stop and idle.
  {
    const t0 = Date.now();
    const r = await cli('submit', 'work:1', 'write the tests');
    timing.push(Date.now() - t0);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.text, /^[0-9a-f]{16}$/);
    assert.deepEqual([r.data.state, r.data.input, r.data.saved, r.data.events.map((e) => e.state)], ['submitted', 'empty', true, ['accepted', 'submitted']]);
    assert.deepEqual(await prompts(claude), ['write the tests'], 'Typed and entered once');
    await report(claude, { kind: 'start', match: promptMatch('write the tests') });
    const working = await until(r.text, 'working');
    assert.equal(working.correlation, 'prompt');
    const early = await call('wait', ['--task', r.text], null, null, 1);
    assert.deepEqual([early.ok, early.timeout, early.state], [false, true, 'working'], `A wait that runs out says where the task got to: ${JSON.stringify(early)}`);
    const waiting = cli('wait', '--task', r.text);
    await stops(claude);
    const done = await waiting;
    assert.deepEqual([done.ok, done.data.state, done.data.final], [true, 'completed', true], JSON.stringify(done));
    const all = await cli('watch', '--after', '0');
    const mine = all.data.events.filter((e) => e.task === r.text);
    assert.deepEqual(mine.map((e) => e.state), ['accepted', 'submitted', 'working', 'completed']);
    assert.ok(all.data.events.every((e, i, a) => !i || e.seq > a[i - 1].seq), 'Numbered in order');
    const after = await call('watch', ['--after', String(all.data.next)], null, null, 1);
    assert.deepEqual([after.ok, after.data.events, after.data.next], [true, [], all.data.next], 'Nothing new: an empty answer, the same place');
    const one = await cli('watch', r.text, '--after', String(mine[1].seq));
    assert.deepEqual([one.data.events.map((e) => e.state), one.data.done], [['working', 'completed'], true], 'One task: its events after the place given, and done');
    ok('Claude: submit, prompt report, Stop, wait and watch');
  }

  // A turn that never named the task doesn't finish it, and neither does going idle.
  {
    await agent(claude, { busy: false });
    const b = (await cli('submit', 'work:1', 'task B')).text;
    await report(claude, { kind: 'start', match: promptMatch('someone else typed this') }, { kind: 'stop' });
    await page.waitForTimeout(700);
    assert.equal((await state(b)).state, 'working', 'Seen busy on screen after its Enter');
    assert.equal((await state(b)).correlation, 'screen');
    await stops(claude);
    await page.waitForTimeout(1000);
    assert.equal((await state(b)).state, 'working', 'A Stop never completes a task only seen busy');
    await agent(claude, { busy: true });
    await report(claude, { kind: 'start', match: promptMatch('task B') });
    await page.waitForTimeout(200);
    assert.equal((await state(b)).correlation, 'prompt');
    await stops(claude);
    assert.equal((await until(b, 'completed')).correlation, 'prompt');
    ok('An unrelated prompt and turn leave a task alone; its own report ties it');
  }

  // --key: a retry gets the same task and types nothing; another request can't reuse it.
  {
    await agent(claude, { busy: false });
    const first = await call('submit', ['work:1', 'keyed task'], null, 'job-1');
    const again = await call('submit', ['work:1', 'keyed task'], null, 'job-1');
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual([again.replayed, again.text], [true, first.text]);
    assert.equal((await prompts(claude)).filter((t) => t === 'keyed task').length, 1, 'Typed once');
    const other = await call('submit', ['work:1', 'a different task'], null, 'job-1');
    assert.equal(other.ok, false);
    assert.match(other.error, /different command/);
    ok('A retried submit with --key types once');
  }

  // A stale pane: --gen from before a restart is refused unwritten; a restart or close cancels.
  {
    await agent(claude, { busy: false });
    const g = await gen(claude);
    const before = (await cli('tasks')).data.length, pasted = await pastes(claude);
    const stale = await cli('submit', 'work:1', '--gen', String(g - 1), 'for an old launch');
    assert.deepEqual([stale.ok, stale.typed], [false, false], JSON.stringify(stale));
    assert.equal(stale.task, undefined, 'No task for nothing typed');
    assert.deepEqual([(await cli('tasks')).data.length, await pastes(claude)], [before, pasted]);
    const cut = (await cli('submit', 'work:1', 'cut short')).text;
    await report(claude, { kind: 'start', match: promptMatch('cut short') });
    await until(cut, 'working');
    assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
    const restarted = await until(cut, 'cancelled');
    assert.equal(restarted.reason, 'pane-restarted');
    await stops(claude); // the new launch's turn
    assert.equal((await state(cut)).state, 'cancelled', 'A later launch never finishes it');
    const closing = (await cli('submit', 'work:3', 'in a pane about to close')).text;
    assert.equal((await cli('close', 'work:3', '--yes')).ok, true);
    assert.equal((await until(closing, 'cancelled')).reason, 'pane-closed');
    ok('A stale --gen types nothing; a restart or close cancels');
  }

  // Review P1: a late report from a replaced process never moves the new launch's task.
  {
    await agent(claude, { busy: false, input: '' });
    const g1 = await gen(claude);
    const a = (await cli('submit', 'work:1', 'old launch task')).text;
    await report(claude, { kind: 'start', match: promptMatch('old launch task') });
    await until(a, 'working');
    assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
    await until(a, 'cancelled');
    const g2 = await gen(claude);
    assert.ok(g2 > g1, `${g1} then ${g2}`);
    const b = (await cli('submit', 'work:1', 'new launch task')).text;
    await report(claude, { kind: 'start', match: promptMatch('new launch task') });
    await until(b, 'working');
    await agent(claude, { busy: false });
    await report(claude, { kind: 'stop', launch: g1 }, { kind: 'stop', launch: null });
    await page.waitForTimeout(1500);
    assert.equal((await state(b)).state, 'working', "The old launch's Stop, and one naming no launch, end nothing");
    await report(claude, { kind: 'stop' });
    await until(b, 'completed');
    ok("A replaced launch's late Stop doesn't complete the new launch's task");
  }

  // Review P1: Claude's Stop may be overruled by another Stop hook; only Stop and Claude idle complete.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'stop gets blocked')).text;
    await report(claude, { kind: 'start', match: promptMatch('stop gets blocked') });
    await until(t, 'working');
    await report(claude, { kind: 'stop' }); // Claude stays busy: another hook sent it on
    await page.waitForTimeout(1500);
    assert.equal((await state(t)).state, 'working', 'A Stop while Claude works on ends nothing');
    await cli('keys', 'work:1', 'esc'); // the continuation is interrupted: no Stop comes
    assert.equal((await until(t, 'cancelled', 5000)).reason, 'interrupted', 'An Esc after the Stop decides, not the Stop');
    await agent(claude, { busy: false, input: '' });
    const u = (await cli('submit', 'work:1', 'stops for real')).text;
    await report(claude, { kind: 'start', match: promptMatch('stops for real') }, { kind: 'stop' });
    await page.waitForTimeout(1000);
    assert.equal((await state(u)).state, 'working', 'Still busy on screen: not yet');
    await agent(claude, { busy: false });
    await until(u, 'completed');
    ok('A Stop completes only once Claude is idle; an Esc after it still cancels');
  }

  // Approval: Claude's PermissionRequest; a delivered answer moves it on (review P2: not a failed or navigating one).
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'write a file')).text;
    await report(claude, { kind: 'start', match: promptMatch('write a file') }, { kind: 'approval', detail: 'Write' });
    const asked = await cli('wait', '--task', t);
    assert.deepEqual([asked.data.state, asked.data.detail], ['approval', 'Write'], 'A wait returns when the task asks');
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const lost = await cli('keys', 'work:1', 'enter');
    await qa({ failWriteIf: null });
    assert.equal(lost.ok, false, 'The answer failed to go in');
    assert.deepEqual([(await state(t)).state, (await state(t)).answerInDoubt, (await state(t)).uncertain], ['approval', true, null], 'Still asking, and the answer is in doubt');
    assert.equal((await cli('keys', 'work:1', 'down')).ok, true);
    assert.equal((await state(t)).state, 'approval', 'Moving the highlight answers nothing');
    assert.equal((await cli('keys', 'work:1', 'enter')).ok, true);
    const answered = await state(t);
    assert.deepEqual([answered.state, answered.answerInDoubt, answered.events.at(-1).signal], ['working', false, 'answered']);
    await stops(claude);
    await until(t, 'completed');
    ok('Approval: asked; a failed Enter and an arrow leave it asking; a delivered Enter answers it');
  }

  // Failure: Claude's StopFailure; a shell command's own exit code.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'hit a rate limit')).text;
    await report(claude, { kind: 'start', match: promptMatch('hit a rate limit') }, { kind: 'fail', detail: 'rate_limit: 429' });
    assert.equal((await until(t, 'failed')).detail, 'rate_limit: 429');
    sh = (await call('add', ['work', '--cmd='])).data.id;
    await page.waitForTimeout(300);
    const bad = await cli('submit', sh, 'exit 5');
    assert.equal(bad.ok, true, JSON.stringify(bad));
    const failed = await cli('wait', '--task', bad.text);
    assert.deepEqual([failed.data.state, failed.data.exit, failed.data.correlation], ['failed', 5, 'token'], JSON.stringify(failed.data));
    const good = await cli('submit', sh, 'echo fine');
    assert.deepEqual([(await cli('wait', '--task', good.text)).data.state, (await state(good.text)).exit], ['completed', 0]);
    ok("Failure: Claude's StopFailure and a shell's exit 5");
  }

  // Interrupted: Esc, and the agent stops working, with no end reported. Esc it shrugs off changes nothing.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'long job')).text;
    await report(claude, { kind: 'start', match: promptMatch('long job') });
    await qa({ ignoreEsc: true });
    await cli('keys', 'work:1', 'esc');
    await page.waitForTimeout(3000);
    assert.equal((await state(t)).state, 'working', 'Still busy after Esc: not interrupted');
    await qa({ ignoreEsc: false });
    await cli('keys', 'work:1', 'esc');
    const cancelled = await until(t, 'cancelled', 5000);
    assert.deepEqual([cancelled.reason, cancelled.events.at(-1).signal], ['interrupted', 'interrupt']);
    ok('Esc that stops the agent cancels; Esc it ignores does not');
  }

  // Guards: a draft or a question on screen, and nothing is typed.
  {
    await agent(claude, { busy: false, input: 'half typed' });
    const pasted = await pastes(claude);
    const draft = await cli('submit', 'work:1', 'over a draft');
    assert.deepEqual([draft.ok, draft.typed], [false, false], JSON.stringify(draft));
    assert.match(draft.error, /draft/);
    assert.equal((await state(draft.task)).reason, 'not-sent', 'Reserved, then not sent');
    await agent(claude, { input: '', menu: 'Allow Write to notes.md?' });
    const menu = await cli('submit', 'work:1', 'into a question');
    assert.deepEqual([menu.ok, menu.typed], [false, false], JSON.stringify(menu));
    assert.match(menu.error, /asking a question/);
    assert.equal(await pastes(claude), pasted, 'Neither typed anything');
    await agent(claude, { menu: null });
    ok('Submit refuses a draft and a question');
  }

  // Codex: no start reported, so the screen says working; only the turn naming its prompt completes it.
  {
    await agent(codex, { busy: false });
    const t = (await cli('submit', 'work:2', 'fix lint')).text;
    assert.equal((await until(t, 'working')).correlation, 'screen');
    await report(codex, { kind: 'end', matches: [promptMatch('another prompt')], turn: 'turn-a' });
    await page.waitForTimeout(300);
    assert.equal((await state(t)).state, 'working');
    await page.evaluate((id) => window.qa.panes.filter((a) => a.id === id).at(-1).onOut.onmessage('\x1b]9;Approval requested: rm -rf build\x07'), codex);
    assert.equal((await until(t, 'approval')).detail, 'Approval requested: rm -rf build');
    await cli('keys', 'work:2', 'y');
    await until(t, 'working');
    await report(codex, { kind: 'end', matches: [promptMatch('fix  lint\n')], turn: 'turn-b' });
    assert.equal((await until(t, 'completed')).correlation, 'prompt');
    ok('Codex: screen, OSC 9 approval, and the turn naming its prompt');
  }

  // Review P1: one Codex mention of a repeated prompt completes one task; a turn reported twice counts once.
  {
    await agent(codex, { busy: false, input: '' });
    const a = (await cli('submit', 'work:2', 'run the suite')).text;
    const b = (await cli('submit', 'work:2', 'run the suite')).text;
    await report(codex, { kind: 'end', matches: [promptMatch('run the suite')], turn: 'turn-1' });
    assert.equal((await until(a, 'completed')).uncertain, 'repeated-prompt', 'The oldest, marked as picked by order');
    await page.waitForTimeout(300);
    assert.equal((await state(b)).final, false, 'One mention completes one task');
    await report(codex, { kind: 'end', matches: [promptMatch('run the suite')], turn: 'turn-1' });
    await page.waitForTimeout(300);
    assert.equal((await state(b)).final, false, 'The same turn reported again counts once');
    await report(codex, { kind: 'end', matches: [promptMatch('run the suite')], turn: 'turn-2' });
    assert.equal((await until(b, 'completed')).uncertain, null);
    ok('Codex: a repeated prompt needs a mention per task, and a turn counts once');
  }

  // Follow-up F3: the same text submitted again doesn't prove an earlier Enter that failed.
  {
    await agent(codex, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const a = await call('submit', ['work:2', 'retry same text'], null, 'review-a');
    await qa({ failWriteIf: null });
    assert.deepEqual([a.ok, a.uncertain, (await state(a.task)).state], [false, 'submit', 'submitted'], JSON.stringify(a));
    await agent(codex, { input: '' }); // the user clears the text that's waiting
    const b = await call('submit', ['work:2', 'retry same text'], null, 'review-b');
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal((await prompts(codex)).filter((t) => t === 'retry same text').length, 1, 'One prompt went in');
    await report(codex, { kind: 'end', matches: [promptMatch('retry same text')], turn: 'turn-review-f3' });
    assert.equal((await until(b.text, 'completed')).uncertain, 'repeated-prompt', 'The one whose Enter went in, marked as picked');
    const doubted = await state(a.task);
    assert.deepEqual([doubted.final, doubted.uncertain], [false, 'submit'], `The one in doubt isn't completed by the other's turn: ${JSON.stringify(doubted)}`);
    ok('A later submit of the same text completes itself, not an earlier one whose Enter failed');
  }

  // Third review F1: a later turn of the same text, from a send Loom never tracked, can't complete a task whose Enter failed.
  {
    // Codex, the review's case: A's Enter fails; B's turn completes B; then an untracked send of the text.
    await agent(codex, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const a = await call('submit', ['work:2', 'same again'], null, 'review3-a');
    await qa({ failWriteIf: null });
    await agent(codex, { input: '' });
    const b = await call('submit', ['work:2', 'same again'], null, 'review3-b');
    await report(codex, { kind: 'end', matches: [promptMatch('same again')], turn: 'turn-review3-b' });
    await until(b.text, 'completed');
    assert.equal((await state(a.task)).final, false);
    await agent(codex, { busy: false, input: '' });
    assert.equal((await cli('send', 'work:2', 'same again')).ok, true, 'An untracked send of the same text');
    await report(codex, { kind: 'end', matches: [promptMatch('same again')], turn: 'turn-review3-c' });
    const codexA = await until(a.task, 'unknown');
    assert.deepEqual([codexA.reason, codexA.uncertain], ['submit-uncertain', 'submit'], `Ambiguous, not completed: ${JSON.stringify(codexA)}`);
    // Claude, the same: A's Enter never reached Claude; an untracked send starts and ends a turn of that text.
    await agent(claude, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const c = await call('submit', ['work:1', 'claude same again'], null, 'review3-c');
    await qa({ failWriteIf: null });
    await agent(claude, { input: '' });
    assert.equal((await cli('send', 'work:1', 'claude same again')).ok, true);
    await report(claude, { kind: 'start', match: promptMatch('claude same again') });
    assert.equal((await until(c.task, 'working')).uncertain, 'submit', 'Input went in since its Enter: the start proves nothing');
    await stops(claude);
    const claudeC = await until(c.task, 'unknown');
    assert.equal(claudeC.reason, 'submit-uncertain', JSON.stringify(claudeC));
    ok('A turn of the same text from an untracked send ends a doubted task unknown, never completed (Codex and Claude)');
  }

  // Fourth review F1: input typed while a failed Enter's write was pending can't prove that Enter went in.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ holdWriteIf: "fn:return d === '\\r'" });
    const pending = call('submit', ['work:1', 'race same text'], null, 'review4-race');
    await page.waitForFunction(() => window.qa.heldWrites.length === 1);
    await qa({ holdWriteIf: null });
    // Through the window's own input: clear the waiting text, type the same, press Enter.
    await page.locator(`.pane[data-id="${claude}"] .xterm-helper-textarea`).focus();
    await page.keyboard.press('Control+u');
    await page.keyboard.type('race same text');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.qa.prompts.some(([, t]) => t === 'race same text'));
    await page.evaluate(() => window.qa.heldWrites.splice(0).forEach((w) => w.reject(new Error('Test: the terminal write failed'))));
    const a = await pending;
    assert.deepEqual([a.ok, a.uncertain], [false, 'submit'], JSON.stringify(a));
    assert.equal((await prompts(claude)).filter((t) => t === 'race same text').length, 1, "Only the window's prompt reached Claude");
    await report(claude, { kind: 'start', match: promptMatch('race same text') }); // the window prompt's start
    assert.equal((await until(a.task, 'working')).uncertain, 'submit', "Another prompt's start proves nothing about the task's Enter");
    await stops(claude);
    assert.equal((await until(a.task, 'unknown')).reason, 'submit-uncertain');
    ok("Typing while a failed Enter's write was pending keeps its doubt: unknown, not completed");
  }

  // Around fourth review F1: an earlier prompt of the same text can't prove a failed Enter either.
  {
    // Claude busy at the Enter: the start may be a prompt sent before it.
    await agent(claude, { busy: true, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const a = await call('submit', ['work:1', 'busy at the enter'], null, 'review4-busy');
    await qa({ failWriteIf: null });
    await agent(claude, { input: '' });
    await report(claude, { kind: 'start', match: promptMatch('busy at the enter') });
    assert.equal((await until(a.task, 'working')).uncertain, 'submit', 'Claude was busy at its Enter: no proof');
    await stops(claude);
    assert.equal((await until(a.task, 'unknown')).reason, 'submit-uncertain');
    // A start reported before the Enter was attempted is some earlier prompt's.
    await agent(claude, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const b = await call('submit', ['work:1', 'stamped before the enter'], null, 'review4-early');
    await qa({ failWriteIf: null });
    await agent(claude, { input: '', busy: true });
    const enteredAt = Date.parse((await state(b.task)).submittedAt);
    await report(claude, { kind: 'start', t: enteredAt - 60, match: promptMatch('stamped before the enter') });
    await page.waitForTimeout(300);
    assert.notEqual((await state(b.task)).correlation, 'prompt', 'A start from before its Enter is not its at all (sixth review)');
    await report(claude, { kind: 'start', match: promptMatch('stamped before the enter') });
    assert.equal((await until(b.task, 'working')).uncertain, 'submit', 'One after it: no proof either');
    await stops(claude);
    assert.equal((await until(b.task, 'unknown')).reason, 'submit-uncertain');
    ok('A start that may be an earlier prompt of the same text proves no failed Enter');
  }

  // Fourth review F2: a failed answer, then a delivered one, don't clear the doubt about the task's own Enter.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const a = await call('submit', ['work:1', 'approval same text'], null, 'review4-answer');
    await qa({ failWriteIf: null });
    await agent(claude, { input: '' });
    assert.equal((await cli('send', 'work:1', 'approval same text')).ok, true, 'An untracked send of the text');
    await report(claude, { kind: 'start', match: promptMatch('approval same text') });
    assert.equal((await until(a.task, 'working')).uncertain, 'submit');
    await report(claude, { kind: 'approval', detail: 'Bash' });
    await until(a.task, 'approval');
    await agent(claude, { busy: false, dialog: 'Allow Bash(ls)?' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    assert.equal((await cli('keys', 'work:1', 'enter')).ok, false);
    await qa({ failWriteIf: null });
    const asked = await state(a.task);
    assert.deepEqual([asked.state, asked.uncertain, asked.answerInDoubt], ['approval', 'submit', true], 'Both doubts, each its own');
    assert.equal((await cli('keys', 'work:1', 'enter')).ok, true);
    const answered = await state(a.task);
    assert.deepEqual([answered.state, answered.uncertain, answered.answerInDoubt], ['working', 'submit', false], "The answer's doubt clears; the Enter's stays");
    await agent(claude, { dialog: null });
    await stops(claude);
    assert.equal((await until(a.task, 'unknown')).reason, 'submit-uncertain', 'Never completed: its own Enter never went in');
    ok('A failed then delivered answer leaves the doubt about the Enter, and the task ends unknown');
  }

  // Fifth review: an earlier prompt of the same text, its busy screen and start report late, can't prove a failed Enter.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ idleAfterEnter: true }); // the earlier prompt's busy output hasn't drawn yet
    assert.equal((await cli('send', 'work:1', 'earlier pending same text')).ok, true, 'An untracked prompt goes in first');
    await qa({ idleAfterEnter: false, failWriteIf: "fn:return d === '\\r'" });
    const a = await call('submit', ['work:1', 'earlier pending same text'], null, 'review5-a');
    await qa({ failWriteIf: null });
    assert.deepEqual([a.ok, a.uncertain], [false, 'submit'], JSON.stringify(a));
    assert.equal((await prompts(claude)).filter((t) => t === 'earlier pending same text').length, 1, "The task's Enter never reached Claude");
    await agent(claude, { input: '', busy: true });
    await report(claude, { kind: 'start', match: promptMatch('earlier pending same text') }); // stamped after the task's Enter
    assert.equal((await until(a.task, 'working')).uncertain, 'submit', "The earlier prompt's late start proves nothing");
    await stops(claude);
    assert.equal((await until(a.task, 'unknown')).reason, 'submit-uncertain');
    let kept;
    for (let i = 0; i < 40 && (kept = await saved(a.task))?.state !== 'unknown'; i++) await page.waitForTimeout(50);
    assert.deepEqual([kept?.state, kept?.uncertain], ['unknown', 'submit'], 'And so it is journaled: a restart brings back no completed');
    // Codex, the same order: its earlier turn's end comes after the task's failed Enter.
    await agent(codex, { busy: false, input: '' });
    await qa({ idleAfterEnter: true });
    assert.equal((await cli('send', 'work:2', 'codex earlier same text')).ok, true);
    await qa({ idleAfterEnter: false, failWriteIf: "fn:return d === '\\r'" });
    const c = await call('submit', ['work:2', 'codex earlier same text'], null, 'review5-codex');
    await qa({ failWriteIf: null });
    assert.deepEqual([c.ok, c.uncertain], [false, 'submit'], JSON.stringify(c));
    await report(codex, { kind: 'end', matches: [promptMatch('codex earlier same text')], turn: 'turn-review5-earlier' });
    assert.equal((await until(c.task, 'unknown')).reason, 'submit-uncertain');
    ok("An earlier prompt's late start or turn end leaves a failed Enter in doubt: unknown, never completed");
  }

  // Fifth review, with the native helper's own timestamp: loom.exe --claude-hook, its stdin held open past the task's failed Enter.
  {
    const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
    if (!existsSync(exe)) console.log(`skip the native-helper case: no ${exe} (build it, or set LOOM_TEST_EXE)`);
    else {
      await agent(claude, { busy: false, input: '' });
      const text = 'earlier prompt, native stamp';
      await qa({ idleAfterEnter: true });
      assert.equal((await cli('send', 'work:1', text)).ok, true);
      await qa({ idleAfterEnter: false });
      // Claude's hook for that prompt starts now, and finishes reading its payload only after the task's Enter fails.
      const temp = mkdtempSync(join(tmpdir(), 'loom-task-check-'));
      const launch = await gen(claude);
      const hook = spawn(exe, ['--claude-hook'], { env: { ...process.env, LOOM_PANE: claude, LOOM_LAUNCH: String(launch), TEMP: temp, TMP: temp } });
      hook.stdin.write(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 'review5' }));
      await qa({ failWriteIf: "fn:return d === '\\r'" });
      const a = await call('submit', ['work:1', text], null, 'review5-native');
      await qa({ failWriteIf: null });
      assert.deepEqual([a.ok, a.uncertain], [false, 'submit'], JSON.stringify(a));
      const enterAt = Date.parse((await state(a.task)).submittedAt);
      const exited = new Promise((r) => hook.on('close', r));
      hook.stdin.end();
      assert.equal(await exited, 0, 'The helper always exits 0');
      const dir = join(temp, 'loom-task');
      const files = readdirSync(dir).filter((f) => f.startsWith(`${claude}.`) && f.endsWith('.json'));
      assert.equal(files.length, 1, `The helper wrote one event: ${files}`);
      const event = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      rmSync(temp, { recursive: true, force: true });
      assert.deepEqual([event.kind, event.match, event.launch], ['start', promptMatch(text), launch]);
      assert.ok(event.t > enterAt, `The helper stamps when it writes, after the task's Enter (${event.t} > ${enterAt})`);
      assert.equal((await prompts(claude)).filter((t) => t === text).length, 1, "Claude got the earlier prompt only, not the task's");
      // As lib.rs send_task_events hands it to the page.
      await agent(claude, { input: '', busy: true });
      await page.evaluate(([id, event]) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'agent-events', payload: [[id, event]] }), [claude, event]);
      assert.equal((await until(a.task, 'working')).uncertain, 'submit', "The native start, stamped after the Enter, still proves nothing");
      await stops(claude);
      assert.equal((await until(a.task, 'unknown')).reason, 'submit-uncertain');
      ok("The native helper's late timestamp proves no failed Enter either");
    }
  }

  // Third review F2: an unreported, unnumbered permission dialog is no proof Claude stopped.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'unreported dialog')).text;
    await report(claude, { kind: 'start', match: promptMatch('unreported dialog') }, { kind: 'stop' });
    await page.waitForTimeout(800); // busy: another Stop hook sent Claude on
    await agent(claude, { busy: false, dialog: 'Allow Bash(ls)?' }); // no approval report arrives
    await page.waitForTimeout(1500);
    assert.equal((await state(t)).state, 'working', 'A dialog in place of the input is no idle Claude');
    const waited = await call('wait', ['--task', t], null, null, 1);
    assert.deepEqual([waited.ok, waited.timeout, waited.state], [false, true, 'working'], JSON.stringify(waited));
    await agent(claude, { dialog: null }); // answered, and Claude idle at its input
    await until(t, 'completed');
    ok("A Stop holds only once Claude's input shows idle; a dialog without a report doesn't count");
  }

  // Follow-up F4: a Stop Claude worked on past, then a question: still asking, not completed.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'blocked then asks')).text;
    await report(claude, { kind: 'start', match: promptMatch('blocked then asks') }, { kind: 'stop' });
    await page.waitForTimeout(1000); // busy: another Stop hook sent Claude on
    assert.equal((await state(t)).state, 'working');
    await report(claude, { kind: 'approval', detail: 'Write' });
    await agent(claude, { busy: false, dialog: 'Allow Write to notes.md?' }); // no hint, no numbered menu
    await page.waitForTimeout(1500);
    const asked = await call('wait', ['--task', t], null, null, 2);
    assert.deepEqual([asked.ok, asked.data?.state], [true, 'approval'], `Asking, not completed: ${JSON.stringify(asked)}`);
    await agent(claude, { dialog: null });
    await cli('keys', 'work:1', 'enter');
    await until(t, 'working');
    await page.waitForTimeout(1500); // idle a moment after the answer, and no new Stop yet
    assert.equal((await state(t)).state, 'working', 'The Stop before the question counts for nothing after it');
    await stops(claude);
    await until(t, 'completed');
    // A Stop that comes while the task asks completes nothing while it asks.
    await agent(claude, { busy: false, input: '' });
    const v = (await cli('submit', 'work:1', 'asks then stops')).text;
    await report(claude, { kind: 'start', match: promptMatch('asks then stops') }, { kind: 'approval', detail: 'Bash' });
    await until(v, 'approval');
    await agent(claude, { busy: false, dialog: 'Allow Bash(ls)?' });
    await report(claude, { kind: 'stop' });
    await page.waitForTimeout(1500);
    assert.equal((await state(v)).state, 'approval', 'An approval pause confirms no Stop');
    await agent(claude, { dialog: null });
    await cli('keys', 'work:1', 'enter');
    await until(v, 'working');
    await stops(claude);
    await until(v, 'completed');
    // And with no approval report at all: a question on screen is no proof of a Stop either.
    await agent(claude, { busy: false, input: '' });
    const u = (await cli('submit', 'work:1', 'blocked then a dialog')).text;
    await report(claude, { kind: 'start', match: promptMatch('blocked then a dialog') }, { kind: 'stop' });
    await page.waitForTimeout(800);
    await agent(claude, { busy: false, menu: 'Allow Bash(rm build)?' });
    await page.waitForTimeout(1500);
    assert.equal((await state(u)).state, 'working', 'A question on screen keeps the Stop from completing it');
    await agent(claude, { menu: null });
    await until(u, 'completed');
    ok('A blocked Stop never completes a task that then asks, reported or only on screen');
  }

  // Sixth review: an earlier turn can't settle a task while its own paste or Enter is still being written.
  {
    const holdEnter = "fn:return d === '\\r'", holdPaste = "fn:return d.startsWith('\\x1b[200~')";
    /** An untracked prompt of `text` goes in first, its busy screen and reports still to come. */
    const earlier = async (id, ref, text) => {
      await agent(id, { busy: false, input: '' });
      await qa({ idleAfterEnter: true });
      assert.equal((await cli('send', ref, text)).ok, true, 'The earlier, untracked prompt');
      await qa({ idleAfterEnter: false });
    };
    /** Submits `text` with one write (`hold`) held, runs `during` while it is, then settles it `how`. */
    const pending = async (ref, text, key, hold, during, how) => {
      await qa({ holdWriteIf: hold });
      const reply = call('submit', [ref, text], null, key);
      reply.catch(() => {}); // a failed assertion below closes the page under it: report that, not this
      await page.waitForFunction(() => window.qa.heldWrites.length === 1);
      await qa({ holdWriteIf: null });
      const task = (await cli('tasks')).data.find((t) => t.key === key).task;
      await during(task);
      await page.waitForTimeout(1200); // past the sweep's Stop check and the journal's writes
      const mid = await state(task);
      assert.deepEqual([mid.state, mid.uncertain], ['accepted', null], `Nothing settles it while its write is out: ${JSON.stringify(mid)}`);
      assert.equal((await saved(task))?.state, 'accepted', 'Nor does the journal say otherwise');
      await page.evaluate((how) => window.qa.heldWrites.splice(0).forEach((w) => (how === 'resolve' ? w.resolve() : w.reject(new Error('Test: the terminal write failed')))), how);
      return { reply: await reply, task };
    };
    const claudeTurn = (text) => async () => {
      await agent(claude, { busy: true });
      await report(claude, { kind: 'start', match: promptMatch(text) });
      await stops(claude); // idle again, Stop reported; the task's text, if typed, waits in the input
    };
    const codexTurn = (text, turn) => () => report(codex, { kind: 'end', matches: [promptMatch(text)], turn });

    // The review's three, and Claude's paste too: the write fails after the earlier turn ended.
    for (const [agentId, ref, stage, hold, turn] of [
      [claude, 'work:1', 'enter', holdEnter, claudeTurn], [codex, 'work:2', 'enter', holdEnter, codexTurn],
      [codex, 'work:2', 'paste', holdPaste, codexTurn], [claude, 'work:1', 'paste', holdPaste, claudeTurn],
    ]) {
      const text = `${ref} earlier turn during pending ${stage}`, key = `review6-${agentId === claude ? 'claude' : 'codex'}-${stage}`;
      await earlier(agentId, ref, text);
      const { reply, task } = await pending(ref, text, key, hold, turn(text, `turn-${key}`), 'reject');
      const doubt = stage === 'enter' ? 'submit' : 'type';
      assert.deepEqual([reply.ok, reply.uncertain, reply.task], [false, doubt, task], JSON.stringify(reply));
      assert.equal((await prompts(agentId)).filter((t) => t === text).length, 1, 'Only the earlier prompt went in');
      const end = stage === 'enter' ? await until(task, 'unknown') : await state(task);
      const want = stage === 'enter' ? ['unknown', 'submit-uncertain', 'submit'] : ['failed', 'not-submitted', 'type'];
      assert.deepEqual([end.state, end.reason, end.uncertain], want, JSON.stringify(end));
      let kept;
      for (let i = 0; i < 40 && (kept = await saved(task))?.state !== want[0]; i++) await page.waitForTimeout(50);
      assert.deepEqual([kept?.state, kept?.uncertain], [want[0], want[2]], 'Journaled as it ended');
      acrossRestart.push([ref, text, key, task, want[0], want[2]]);
    }
    ok("An earlier turn while a task's Enter or paste is written settles nothing: its write's failure decides (Claude and Codex)");

    // The same while the write goes in: what came meanwhile is the task's after all, as it would be just after.
    {
      const text = 'own start before the enter reply';
      await agent(claude, { busy: false, input: '' });
      const { reply, task } = await pending('work:1', text, 'review6-claude-ok', holdEnter, async () => {
        await agent(claude, { busy: true });
        await report(claude, { kind: 'start', match: promptMatch(text) });
      }, 'resolve');
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual([(await until(task, 'working')).correlation], ['prompt']);
      await stops(claude);
      assert.equal((await until(task, 'completed')).uncertain, null);
      await agent(codex, { busy: false, input: '' });
      const c = await pending('work:2', 'codex turn before the enter reply', 'review6-codex-ok', holdEnter, codexTurn('codex turn before the enter reply', 'turn-review6-codex-ok'), 'resolve');
      assert.equal(c.reply.ok, true);
      assert.equal((await until(c.task, 'completed')).uncertain, null);
    }
    // A shell's token names the task, so the line running before the Enter's reply settles it, whatever the reply.
    for (const how of ['resolve', 'reject']) {
      const line = `echo token before the reply ${how}`;
      const { reply, task } = await pending(sh, line, `review6-shell-${how}`, holdEnter, (id) => page.evaluate(([pane, full]) => window.qa.out(pane, `\x1b]133;E;${full}\x07\x1b]133;C\x07\r\n\x1b]133;D;0\x07\x1b]133;A\x07PS> \x1b]133;B\x07`), [sh, `${line}  # loom-receipt:${id}`]), how);
      await page.evaluate((id) => { window.qa.agents[id].line = ''; }, sh); // the mock never ran the held line
      assert.deepEqual([reply.ok, reply.uncertain ?? null], how === 'resolve' ? [true, null] : [false, 'submit'], JSON.stringify(reply));
      const done = await until(task, 'completed');
      assert.deepEqual([done.correlation, done.exit, done.uncertain], ['token', 0, null], JSON.stringify(done));
    }
    ok('What came while the Enter was written counts once it went in; a shell token settles it either way');

    // Stamped after the task was accepted but before its Enter, a turn is another prompt's, wherever it arrives.
    {
      const text = 'turn stamped before its enter';
      await agent(codex, { busy: false, input: '' });
      const t = await call('submit', ['work:2', text], null, 'review6-stamp');
      assert.equal(t.ok, true, JSON.stringify(t));
      const rec = await state(t.text);
      const acceptedAt = Date.parse(rec.acceptedAt), enterAt = Date.parse(rec.submittedAt);
      assert.ok(enterAt - acceptedAt >= 100, `Typing and its echo come between (${enterAt - acceptedAt} ms)`);
      await report(codex, { kind: 'end', matches: [promptMatch(text)], turn: 'turn-review6-stamp-early', t: enterAt - 1 });
      await page.waitForTimeout(300);
      assert.equal((await state(t.text)).final, false, "A turn that ended before the task's Enter isn't its");
      await report(codex, { kind: 'end', matches: [promptMatch(text)], turn: 'turn-review6-stamp' });
      assert.equal((await until(t.text, 'completed')).correlation, 'prompt');
    }
    ok("A turn stamped before the task's Enter isn't its, even when it arrives after");
  }

  // A shell's token still proves a doubted Enter went in: the line that ran carries the task's own id.
  {
    await page.waitForTimeout(300);
    await qa({ loseReplyIf: "fn:return d === '\\r'" });
    const lost = await cli('submit', sh, 'echo proved by token');
    await qa({ loseReplyIf: null });
    assert.deepEqual([lost.ok, lost.uncertain], [false, 'submit'], JSON.stringify(lost));
    const ran = await cli('wait', '--task', lost.task);
    assert.deepEqual([ran.data.state, ran.data.uncertain, ran.data.exit, ran.data.correlation], ['completed', null, 0, 'token'], JSON.stringify(ran.data));
    ok("A shell's token, the task's own id, proves a doubted Enter; it completes with its exit code");
  }

  // Writes that fail: Enter in doubt stays open (the agent's report can still settle it); a paste that failed is not submitted.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ loseReplyIf: "fn:return d === '\\r'" }); // the Enter went in; its answer didn't come back
    const lost = await cli('submit', 'work:1', 'enter in doubt');
    await qa({ loseReplyIf: null });
    assert.deepEqual([lost.ok, lost.typed, lost.uncertain], [false, true, 'submit'], JSON.stringify(lost));
    const doubt = await state(lost.task);
    // Submitted, or working once a sweep sees Claude busy: either way the doubt stays.
    assert.deepEqual([doubt.final, doubt.uncertain], [false, 'submit'], JSON.stringify(doubt));
    await report(claude, { kind: 'start', match: promptMatch('enter in doubt') });
    assert.equal((await until(lost.task, 'working')).uncertain, 'submit', "A start can't tell its Enter from another's: the doubt stays");
    await stops(claude);
    assert.equal((await until(lost.task, 'unknown')).reason, 'submit-uncertain', 'Delivered, but nothing proves it: unknown, never a false completed');
    await agent(claude, { busy: false, input: '' });
    await qa({ noEcho: true });
    const unseen = await cli('submit', 'work:1', 'never shows');
    await qa({ noEcho: false });
    assert.deepEqual([unseen.ok, unseen.typed], [false, true]);
    const held = await state(unseen.task);
    assert.deepEqual([held.state, held.reason], ['failed', 'not-submitted']);
    ok('An Enter in doubt stays open with uncertain: submit; a held Enter fails as not-submitted');
  }

  // Review P1: the task is in the journal before anything is typed, and a journal that can't take it stops the send.
  {
    await agent(claude, { busy: false, input: '' });
    const pasted = await pastes(claude);
    await qa({ journalHold: 'fn:return true' });
    const pending = call('submit', ['work:1', 'reserved first'], null, 'durable-1');
    await page.waitForFunction(() => window.qa.journalHeld.length > 0);
    await page.waitForTimeout(300);
    assert.equal(await pastes(claude), pasted, 'Nothing typed while the reservation is unwritten');
    await qa({ journalHold: null });
    await page.evaluate(() => window.qa.journalHeld.splice(0).forEach((release) => release()));
    const reserved = await pending;
    assert.deepEqual([reserved.ok, await pastes(claude)], [true, pasted + 1], JSON.stringify(reserved));
    await agent(claude, { busy: false, input: '' });
    const listed = (await cli('tasks')).data.length;
    await qa({ journalFail: true });
    const refused = await cli('submit', 'work:1', 'the journal is full');
    await qa({ journalFail: false });
    assert.deepEqual([refused.ok, refused.typed, refused.task], [false, false, undefined], JSON.stringify(refused));
    assert.match(refused.error, /journal/);
    assert.deepEqual([await pastes(claude), (await cli('tasks')).data.length], [pasted + 1, listed], 'Nothing typed, no task');
    // The Enter's own record failing: the task went in, says the journal is behind, and the next write catches up.
    await qa({ journalFailIf: `fn:return d.includes('"submitted"')` });
    const behind = await cli('submit', 'work:1', 'the record lags');
    await qa({ journalFailIf: null });
    assert.deepEqual([behind.ok, behind.data.state, behind.data.saved], [true, 'submitted', false], JSON.stringify(behind));
    await report(claude, { kind: 'start', match: promptMatch('the record lags') });
    assert.equal((await until(behind.text, 'working')).saved, true);
    assert.equal((await journalTask(behind.text))?.state, 'working', 'Rewritten whole, the journal has it again');
    ok('The reservation is written before typing; a refused one types nothing; a lagging record says so and catches up');
  }

  // Idle is never completion: an agent that went quiet with nothing reported, or a shell line that never ran, is unknown after 30 s.
  if (!process.env.TASK_QUICK) {
    await agent(claude, { busy: false, input: '' });
    await qa({ idleAfterEnter: true, shellHang: true });
    const t = (await cli('submit', 'work:1', 'nothing reports this')).text;
    const line = (await cli('submit', sh, 'echo never runs')).text;
    await qa({ idleAfterEnter: false, shellHang: false });
    await page.waitForTimeout(5000);
    assert.deepEqual([(await state(t)).state, (await state(line)).state], ['submitted', 'submitted'], 'Idle for a while: still open');
    const quiet = await until(t, 'unknown', 32000);
    assert.equal(quiet.reason, 'no-end-signal');
    assert.equal((await until(line, 'unknown', 5000)).reason, 'no-start-signal');
    ok('Quiet with no report: unknown, never completed, for an agent and a shell line');
  }

  // Seventh review: while a newer task's Enter is held, an older task's own report waits, and so does the sweep: no old Stop, pane state or quiet spell decides it first.
  {
    const holdEnter = "fn:return d === '\\r'";
    /** Older task A works, its Stop seen while Claude still looked busy; newer task B's Enter is held while `during` runs, then settled `how`. */
    const older = async (name, how, during) => {
      await agent(claude, { busy: false, input: '' });
      const textA = `older task ${name}`, keyA = `review7-${name}`;
      const a = (await call('submit', ['work:1', textA], null, keyA)).text;
      await report(claude, { kind: 'start', match: promptMatch(textA) });
      await until(a, 'working');
      await agent(claude, { busy: true, input: '' });
      await report(claude, { kind: 'stop' }); // a candidate only: Claude still looks busy
      await page.waitForTimeout(300);
      await qa({ holdWriteIf: holdEnter });
      const b = call('submit', ['work:1', `newer task ${name}`], null, `${keyA}-b`);
      b.catch(() => {}); // a failed assertion below closes the page under it: report that, not this
      await page.waitForFunction(() => window.qa.heldWrites.length === 1);
      await qa({ holdWriteIf: null });
      await during();
      await page.waitForTimeout(1200); // well past the sweep's Stop check
      const mid = await state(a);
      assert.deepEqual([mid.state, (await saved(a))?.state], ['working', 'working'], `Nothing judged it while its report was held: ${JSON.stringify(mid)}`);
      await page.evaluate((how) => window.qa.heldWrites.splice(0).forEach((w) => (how === 'resolve' ? w.resolve() : w.reject(new Error('Test: the terminal write failed')))), how);
      const reply = await b;
      assert.deepEqual([reply.ok, reply.uncertain ?? null], how === 'resolve' ? [true, null] : [false, 'submit'], JSON.stringify(reply));
      return { a, textA, keyA };
    };
    const idle = () => agent(claude, { busy: false }); // its input stays readable: B's text waits there

    // The pane exits after A's failure report: that report decides, not the exit.
    {
      const { a, textA, keyA } = await older('fails then exits', 'reject', async () => {
        await report(claude, { kind: 'fail', detail: 'overloaded' });
        await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${id}`, payload: 1 }), claude);
      });
      const end = await until(a, 'failed');
      assert.deepEqual([end.detail, end.reason], ['overloaded', null], `Its own report, not the exit: ${JSON.stringify(end)}`);
      acrossRestart.push(['work:1', textA, keyA, a, 'failed', null]);
      assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
      await page.waitForTimeout(300);
    }
    // The review's two: Claude's StopFailure, and a PermissionRequest before its dialog shows. B's Enter fails, or goes in.
    for (const how of ['reject', 'resolve']) {
      const { a, textA, keyA } = await older(`fails ${how}`, how, async () => {
        await report(claude, { kind: 'fail', detail: 'rate_limit' });
        await idle();
      });
      const end = await until(a, 'failed');
      assert.deepEqual([end.detail, end.reason], ['rate_limit', null], JSON.stringify(end));
      acrossRestart.push(['work:1', textA, keyA, a, 'failed', null]);
    }
    for (const how of ['reject', 'resolve']) {
      const { a, textA, keyA } = await older(`asks ${how}`, how, async () => {
        await report(claude, { kind: 'approval', detail: 'Write' });
        await idle();
      });
      // B's Enter failed: A asks. It went in: that Enter answered the question (Pane.wrote), so A works on. Either way that Stop is spent.
      const now = await until(a, how === 'reject' ? 'approval' : 'working');
      assert.ok(now.events.some((e) => e.state === 'approval'), JSON.stringify(now.events));
      await page.waitForTimeout(1200);
      assert.equal((await state(a)).final, false, 'The Stop before the question completes nothing');
      acrossRestart.push(['work:1', textA, keyA, a, 'unknown', null]); // open at the restart
    }
    ok("An older task's report held behind a newer Enter still decides it: no old Stop or pane exit wins first");
  }

  // Sixth and seventh reviews, across a restart: the outcome each write or report left is what comes back, and a retried key gets it, typing nothing.
  {
    await reboot();
    for (const [ref, text, key, task, want, doubt] of acrossRestart) {
      const back = await state(task);
      assert.deepEqual([back.state, back.uncertain], [want, doubt], `${key}: ${JSON.stringify(back)}`);
      const pasted = await pastes(ref === 'work:1' ? claude : codex);
      const retry = await call('submit', [ref, text], null, key);
      assert.deepEqual([retry.ok, retry.replayed, retry.text, retry.data?.state], [true, true, task, want], JSON.stringify(retry));
      assert.equal(await pastes(ref === 'work:1' ? claude : codex), pasted, `${key}: the retry typed nothing`);
    }
    ok('Across a restart and a retried key, those tasks stay as their writes and reports left them, never completed');
  }

  // Follow-up F5: a failed answer's doubt reaches the journal, though the state stays approval.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'answer in doubt')).text;
    await report(claude, { kind: 'start', match: promptMatch('answer in doubt') }, { kind: 'approval', detail: 'Write' });
    await until(t, 'approval');
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    assert.equal((await cli('keys', 'work:1', 'enter')).ok, false);
    await qa({ failWriteIf: null });
    const before = await state(t);
    assert.deepEqual([before.state, before.answerInDoubt, before.saved], ['approval', true, true]);
    await reboot();
    const after = await state(t);
    assert.deepEqual([after.answerInDoubt, after.reason], [true, 'loom-restarted'], `The doubt survived the restart: ${JSON.stringify(after)}`);
    ok("A failed answer's doubt is journaled, not only kept in memory");
  }

  // Follow-up F1: a reservation written by a whole-journal rewrite (after a failed write) is in it.
  {
    await agent(claude, { busy: false, input: '' });
    const older = (await cli('submit', 'work:1', 'older task')).text;
    await qa({ journalFail: true });
    await report(claude, { kind: 'start', match: promptMatch('older task') });
    await until(older, 'working');
    await page.waitForTimeout(200);
    await qa({ journalFail: false });
    assert.equal((await state(older)).saved, false, 'Its last write failed');
    await agent(claude, { busy: false, input: '' });
    const fresh = await call('submit', ['work:1', 'new task in rewrite'], null, 'review-rewrite');
    assert.deepEqual([fresh.ok, fresh.data?.saved], [true, true], JSON.stringify(fresh));
    assert.equal((await state(older)).saved, true, 'The rewrite put the older task back');
    await reboot();
    const retry = await call('submit', ['work:1', 'new task in rewrite'], null, 'review-rewrite');
    assert.deepEqual([retry.ok, retry.replayed, retry.text], [true, true, fresh.text], `The rewrite kept the new task and its key: ${JSON.stringify(retry)}`);
    assert.deepEqual(await prompts(claude), [], 'The retry typed nothing');
    ok('A whole-journal rewrite carries the reservation it was written for');
  }

  // Follow-up F2: a tail torn inside a UTF-8 character costs that line only; a journal that can't be read stops submit.
  {
    await agent(claude, { busy: false, input: '' });
    const keyed = await call('submit', ['work:1', 'before the tear'], null, 'review-torn');
    const last = (await cli('watch', '--after', '0')).data.last;
    // What lib.rs returns for an append cut after the first byte of "é": the bytes decoded lossily.
    const torn = `{"event":{"seq":${last + 1},"task":"${keyed.text}","detail":"caf�`;
    await page.evaluate((torn) => localStorage.setItem('qa-journal', localStorage.getItem('qa-journal') + torn), torn);
    await reboot();
    assert.equal((await state(keyed.text)).reason, 'loom-restarted', 'The task before the tear came back');
    // The torn line's write never finished, so no watcher saw its number; every number one did see stays behind.
    const restarted = (await cli('watch', '--after', String(last))).data.events;
    assert.ok(restarted.length && restarted.every((e) => e.seq > last), `Numbering goes on past every number shown (${last}): ${JSON.stringify(restarted)}`);
    const retry = await call('submit', ['work:1', 'before the tear'], null, 'review-torn');
    assert.deepEqual([retry.ok, retry.replayed, retry.text], [true, true, keyed.text], JSON.stringify(retry));
    assert.deepEqual(await prompts(claude), [], 'The retry typed nothing');
    const kept = await page.evaluate(() => localStorage.getItem('qa-journal'));
    await page.evaluate(() => localStorage.setItem('qa-journal-unreadable', '1'));
    await reboot();
    const refused = await cli('submit', 'work:1', 'while the journal is unreadable');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /couldn't read its task journal/);
    assert.deepEqual([await pastes(claude), await page.evaluate(() => localStorage.getItem('qa-journal'))], [0, kept], 'Nothing typed, the journal left as it was');
    await page.evaluate(() => localStorage.removeItem('qa-journal-unreadable'));
    await reboot();
    ok('A torn tail keeps every task before it and the numbering; an unreadable journal stops submit, untouched');
  }

  // Third review F3: writes queued before a whole-journal rewrite can't undo it on replay.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ idleAfterEnter: true });
    const a = (await cli('submit', 'work:1', 'replay order A')).text;
    const b = (await cli('submit', 'work:1', 'replay order B')).text;
    await qa({ idleAfterEnter: false, journalFail: true });
    await agent(claude, { busy: true }); // the sweep marks both working by screen; those writes fail
    await until(a, 'working');
    await until(b, 'working');
    await page.waitForTimeout(300);
    await qa({ journalFail: false });
    // One batch, as Rust sends it: both prompts' starts (field changes only), then a failure.
    await report(claude, { kind: 'start', match: promptMatch('replay order A') }, { kind: 'start', match: promptMatch('replay order B') }, { kind: 'fail', detail: 'overloaded' });
    await until(b, 'failed');
    await page.waitForTimeout(300);
    assert.deepEqual([(await state(a)).saved, (await state(b)).saved], [true, true]);
    await reboot();
    const after = [await state(a), await state(b)].map((t) => [t.state, t.detail]);
    assert.deepEqual(after, [['failed', 'overloaded'], ['failed', 'overloaded']], 'The journal replays to what Loom had: failed, not working then unknown');
    ok("Writes queued behind a whole-journal rewrite don't undo it");
  }

  // Third review F4: a watcher never sees an event the journal doesn't hold, so no number comes twice, however many queue.
  {
    await agent(claude, { busy: false, input: '' });
    const t = (await cli('submit', 'work:1', 'backlog task')).text;
    await report(claude, { kind: 'start', match: promptMatch('backlog task') });
    await until(t, 'working');
    await page.waitForTimeout(200);
    const cursor = (await cli('watch', '--after', '0')).data.next;
    await qa({ journalHold: 'fn:return true' });
    // 1100 changes while the journal stalls: an approval and its answer, 550 times.
    await report(claude, ...Array.from({ length: 550 }, () => [{ kind: 'approval', detail: 'Write' }, { kind: 'resume' }]).flat());
    await page.waitForTimeout(300);
    const stalled = await call('watch', ['--after', String(cursor)], null, null, 1);
    assert.deepEqual([stalled.data.events.length, stalled.data.next], [0, cursor], 'None of them is on disk, so none is shown');
    await reboot(); // the stalled writes never land
    const after = await cli('watch', '--after', String(stalled.data.next));
    const mine = after.data.events.filter((e) => e.task === t);
    assert.deepEqual([mine.map((e) => e.state), after.data.gap], [['unknown'], false], `The restart's event comes, after every number the watcher saw: ${JSON.stringify(after.data)}`);
    ok('Events are shown only once written: 1100 stalled ones and a restart reuse no number a watcher saw');
  }

  // Review P1: a crash after the Enter, before its record: the reservation still holds the key.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ journalHold: `fn:return d.includes('"submitted"')` });
    void call('submit', ['work:1', 'crash after enter'], null, 'durable-2').catch(() => null);
    await page.waitForFunction(() => window.qa.prompts.some(([, t]) => t === 'crash after enter'));
    const first = (await cli('tasks')).data.find((t) => t.key === 'durable-2');
    await reboot(); // the Enter's record never reached the journal
    const back = await state(first.task);
    assert.deepEqual([back.state, back.reason, back.submittedAt], ['unknown', 'loom-restarted', null], JSON.stringify(back));
    const retry = await call('submit', ['work:1', 'crash after enter'], null, 'durable-2');
    assert.deepEqual([retry.ok, retry.replayed, retry.text], [true, true, first.task], JSON.stringify(retry));
    assert.deepEqual(await prompts(claude), [], 'The retry typed nothing');
    ok('A crash between the Enter and its record: the retry finds the reserved task and types nothing');
  }

  // Loom restarts: the journal brings tasks back, open ones as unknown, numbers going on; a retried key still finds its task.
  {
    await agent(claude, { busy: false, input: '' });
    const open = (await cli('submit', 'work:1', 'left running')).text;
    await report(claude, { kind: 'start', match: promptMatch('left running') });
    await until(open, 'working');
    const before = await cli('watch', '--after', '0');
    const keyed = await call('submit', ['work:1', 'keyed task'], null, 'job-1');
    await reboot();
    const back = await state(open);
    assert.deepEqual([back.state, back.reason], ['unknown', 'loom-restarted'], JSON.stringify(back));
    const resumed = await cli('watch', '--after', String(before.data.next));
    assert.deepEqual(resumed.data.events.map((e) => [e.task, e.state]), [[open, 'unknown']], 'A watcher picks up after its place: only the restart event');
    assert.ok(resumed.data.events[0].seq > before.data.next);
    const pasted = await pastes(claude);
    const retry = await call('submit', ['work:1', 'keyed task'], null, 'job-1');
    assert.deepEqual([retry.ok, retry.replayed, retry.text], [true, true, keyed.text], JSON.stringify(retry));
    assert.equal(await pastes(claude), pasted, 'Typed nothing after the restart');
    const kept = (await cli('tasks', '--state', 'completed')).data.length;
    assert.ok(kept >= 5, `Finished tasks came back: ${kept}`);
    ok('A restart keeps the record: open tasks unknown, numbering continues, keys still dedupe');
  }

  // Review P2: pruning past 500 finished tasks shows as a gap, and still does after the journal's rewrite and another restart.
  {
    const seeded = Array.from({ length: 501 }, (_, i) => ({
      id: `seed${String(i).padStart(12, '0')}`, key: null, what: null, pane: 'gone', ref: 'old:1', agent: 'claude', gen: 1, sha256: '', bytes: 0,
      match: '', input: 'empty', state: 'completed', correlation: 'prompt', uncertain: null, reason: null, detail: null, exit: null,
      acceptedAt: 1, submittedAt: 1, startedAt: 1, endedAt: 1, settledAt: 2 * i + 2,
      events: [{ seq: 2 * i + 1, task: `seed${String(i).padStart(12, '0')}`, at: 1, state: 'accepted', signal: 'loomctl' }, { seq: 2 * i + 2, task: `seed${String(i).padStart(12, '0')}`, at: 1, state: 'completed', signal: 'turn-end' }],
    }));
    const text = [{ seq: 1002, pruned: 0 }, ...seeded.map((task) => ({ task }))].map((l) => JSON.stringify(l)).join('\n') + '\n';
    await page.evaluate((text) => localStorage.setItem('qa-journal', text), text);
    await boot();
    const first = await cli('watch', '--after', '0');
    assert.deepEqual([first.data.gap, first.data.events[0].seq], [true, 3], 'The oldest task was pruned');
    await boot();
    const again = await cli('watch', '--after', '0');
    assert.deepEqual([again.data.gap, again.data.events[0].seq], [true, 3], 'The rewritten journal still knows what it pruned');
    assert.equal((await cli('watch', '--after', '2')).data.gap, false, 'From past the pruned events, no gap');
    ok('The pruned-event mark survives the journal rewrite and a restart');
  }

  assert.deepEqual(errors, []);
  console.log(`submit round trips (ms): ${timing.join(', ')}`);
  console.log(`\nall ${checks} task checks passed`);
} finally {
  await browser.close();
}
