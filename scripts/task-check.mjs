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
// TASK_REVIEW=unreadable|policy-recovery|restored-notices|manual-mismatch|send-draft|all runs the 2026-10-04 regressions only.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isFinal, promptMatch, readJournal } from '../src/task.ts';
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
    // a.codexShape: Codex 0.160's composer as captured (src/fixtures/codex-composer.json): "›"
    // in column 0, the input from column 2 (dim placeholder; a multi-line paste collapsed and
    // colored), a blank row, its status lines, and the real cursor at the insertion point.
    if (a.codexRaw) return out(id).onmessage(a.codexRaw); // a Codex screen exactly as given
    if (a.codexShape) {
      const body = !a.input ? '\x1b[2mAsk Codex to do anything\x1b[0m' : a.input.includes('\n') ? `\x1b[36m[Pasted Content ${a.input.length} chars]\x1b[0m` : a.input;
      const x = !a.input ? 2 : 2 + (a.input.includes('\n') ? `[Pasted Content ${a.input.length} chars]` : a.input).length;
      return out(id).onmessage(`\x1b[2J\x1b[H• Ran the tests\r\n\r\n\x1b[1m›\x1b[0m ${body}\r\n\r\n  gpt-5 high · ~\\work\r\n  ${a.busy ? 'esc to interrupt' : '? for shortcuts'}\x1b[3;${x + 1}H\x1b[?25${a.hidden ? 'l' : 'h'}`);
    }
    const top = a.menu ? ` ${a.menu}\r\n ❯ 1. Yes\r\n   2. No (esc)` : ' Agent';
    // a.v288: Claude Code 2.1.288, whose working line replaced the footer's "esc to interrupt".
    const working = a.v288 ? (a.busy ? '\r\n✢ Topsy-turvying… (12s · ↓ 1.2k tokens)' : '\r\n✻ Worked for 12s') : '';
    out(id).onmessage(`\x1b[2J\x1b[H${top}${working}\r\n${rule}\r\n❯ ${a.input}\r\n${rule}\r\n  ${a.busy && !a.v288 ? 'esc to interrupt' : '? for shortcuts'}\r\n`);
  };
  const shellPrompt = '\x1b]133;A\x07PS> \x1b]133;B\x07';
  const mockAudio = { connect() { return mockAudio; }, start() {}, stop() {}, frequency: { setValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
  window.AudioContext = class { state = 'running'; currentTime = 0; destination = mockAudio; resume() {} createGain() { return mockAudio; } createOscillator() { return mockAudio; } };
  mockWindows('main');
  mockIPC((cmd, args = {}) => {
    qa.calls.push({ cmd, args });
    // What Loom saved comes back on a reload only when a test asks (qa-use-state); every other reload starts as set up.
    if (cmd === 'save_state') return void localStorage.setItem('qa-state', args.json);
    if (cmd === 'load_state') return (localStorage.getItem('qa-use-state') && localStorage.getItem('qa-state')) || JSON.stringify(state);
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
      if (data.startsWith('\x1b[200~')) {
        if (!qa.noEcho) a.input += data.slice(6, -6);
        if (qa.unseenPaste) return; // in the input, not on screen yet: the echo check misses it
        // Drawn a while later, nothing drawn before: Codex 0.160 went quiet 0.4 s partway through a long paste.
        if (qa.drawLate) return void setTimeout(() => qa.draw(args.id), qa.drawLate);
      }
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
    // Codex's notify and OpenCode's plugin hand a pane its session id (lib.rs take_sessions): qa.sessions, once.
    if (cmd === 'take_sessions') return (qa.sessions ?? []).splice(0).filter(([id]) => args.ids.includes(id));
    if (cmd === 'model_options') return [];
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
  /** A prompt Loom tracks no task for: typed with send --no-enter, then a bare Enter from keys (an ordinary send is a task now). */
  const untracked = async (ref, text) => {
    const typed = await cli('send', ref, '--no-enter', text), entered = await cli('keys', ref, 'enter');
    return { ok: typed.ok && entered.ok && entered.data.task === undefined };
  };
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

  // Review of f80a83e, 2026-10-04. TASK_REVIEW runs just these regressions.
  const review = (name) => !process.env.TASK_REVIEW || process.env.TASK_REVIEW === name || process.env.TASK_REVIEW === 'all';
  const resetReview = async () => {
    await page.evaluate(() => localStorage.clear());
    await reboot();
  };
  if (review('unreadable')) {
    const old = await cli('submit', 'work:1', 'keep this history');
    await report(claude, { kind: 'start', match: promptMatch('keep this history') });
    await stops(claude);
    await until(old.text, 'completed');
    const original = await page.evaluate(() => localStorage.getItem('qa-journal'));
    for (const failFirst of [false, true]) {
      await page.evaluate(() => localStorage.setItem('qa-journal-unreadable', '1'));
      await reboot();
      await qa({ journalFail: failFirst });
      const sent = await cli('send', 'work:1', 'automatic with no history');
      assert.equal(sent.ok, true, JSON.stringify(sent));
      assert.equal(sent.data.saved, false);
      assert.match(sent.data.warning, /history is unavailable/i);
      await qa({ journalFail: false });
      await report(claude, { kind: 'start', match: promptMatch('automatic with no history') });
      await stops(claude);
      await until(sent.data.task, 'completed');
      await agent(codex, { codexShape: true, input: 'a readable manual prompt' });
      await page.waitForTimeout(250);
      await page.locator(`.pane[data-id="${codex}"] .xterm-helper-textarea`).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.qa.calls.filter((c) => c.cmd === 'task_journal_write').length), 0,
        'Unread history must block automatic appends and recovery rewrites');
      assert.equal((await state(sent.data.task)).saved, false);
      assert.deepEqual((await cli('watch', '--after', '0')).data.events, [], 'No reused event number is published');
      for (const args of [['work:1', 'off'], ['--all', 'off']]) {
        const refused = await cli('notify', ...args);
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.match(refused.error, /history|journal/i);
      }
      assert.equal(await page.evaluate(() => localStorage.getItem('qa-journal')), original);
      await page.evaluate(() => localStorage.removeItem('qa-journal-unreadable'));
    }
    await reboot();
    assert.equal((await state(old.text)).state, 'completed');
    ok('Unread startup history blocks automatic writes, durable events and policy changes, even after writes recover');
  }

  if (review('policy-recovery')) {
    await resetReview();
    const sent = await cli('submit', 'work:1', 'queued before a failed mute');
    await report(claude, { kind: 'start', match: promptMatch('queued before a failed mute') });
    await stops(claude);
    const done = await until(sent.text, 'completed'), seq = done.events.at(-1).seq;
    assert.equal((await cli('notify', '--check', String(seq))).data[seq], true);
    await qa({ journalFail: true });
    const mute = await cli('notify', 'work:1', 'off');
    await qa({ journalFail: false });
    assert.equal((await cli('notify', 'work:1', 'inherit')).ok, true);
    assert.equal((await cli('notify', '--check', String(seq))).data[seq], false);
    const writes = await page.evaluate(() => window.qa.calls.filter((c) => c.cmd === 'task_journal_write').slice(-2).map((c) => c.args.append));
    await reboot();
    assert.equal((await cli('notify', '--check', String(seq))).data[seq], false, 'A failed mute must survive re-enable and restart');
    assert.deepEqual(writes, [true, false], 'Recovery rewrites the retained policy history');
    assert.equal(mute.ok, false, 'The failed persistence must not acknowledge success');
    assert.match(mute.error, /not saved|persist|journal/i);
    ok('A failed policy append reports failure and the next write restores the mute before replay');
  }

  if (review('restored-notices')) {
    await resetReview();
    await qa({ sessions: [[codex, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']] });
    await page.waitForFunction(() => !window.qa.sessions.length, null, { timeout: 10000 });
    const finish = async (ref, text) => {
      const pane = await paneId(ref);
      await agent(pane, { input: '', busy: false });
      const sent = await cli('submit', ref, text);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      await report(pane, { kind: 'start', match: promptMatch(text) });
      await stops(pane);
      return (await until(sent.text, 'completed')).events.at(-1).seq;
    };
    const oldPane = claude;
    const old = await finish('work:1', 'queued before restoring its pane');
    const closed = await finish('work:3', 'queued before closing its pane');
    assert.equal((await cli('close', 'work:3', '--yes')).ok, true);
    assert.equal((await cli('add', 'work', '--cmd=claude')).ok, true);
    await page.waitForTimeout(700);
    await page.evaluate(() => localStorage.setItem('qa-use-state', '1'));
    await reboot();
    assert.notEqual(claude, oldPane, 'The restored pane has a new runtime id');
    assert.equal((await cli('notify', '--check', String(old))).data[old], true);
    assert.equal((await cli('notify', 'work:1', 'off')).ok, true);
    assert.equal((await cli('notify', '--check', String(old))).data[old], false, 'Restored-pane mute must reach its queued historical completion');
    assert.equal((await cli('notify', 'work:3', 'off')).ok, true);
    assert.equal((await cli('notify', '--check', String(closed))).data[closed], true, 'A replacement at the same ref does not own a closed pane\'s notices');
    assert.equal((await cli('notify', 'work:1', 'inherit')).ok, true);
    assert.equal((await cli('notify', '--check', String(old))).data[old], false, 'Re-enable never resends old notices');
    const newer = await finish('work:1', 'queued before a second restore');
    await page.waitForTimeout(700);
    await reboot();
    assert.equal((await cli('notify', '--check', String(newer))).data[newer], true);
    assert.equal((await cli('notify', 'work:1', 'off')).ok, true);
    assert.equal((await cli('notify', '--check', String(newer))).data[newer], false);
    assert.equal((await cli('notify', '--check', String(closed))).data[closed], true);
    await page.evaluate(() => localStorage.removeItem('qa-use-state'));
    ok('Restored-pane mutes reach historical notices across two restarts and leave closed panes independent');
  }

  if (review('manual-mismatch')) {
    await resetReview();
    const made = [];
    for (const [provider, pane, ref] of [['claude', claude, 'work:1'], ['codex', codex, 'work:2']]) {
      await agent(pane, { input: '', busy: false, codexShape: provider === 'codex' });
      const before = (await cli('tasks')).data.map((t) => t.task);
      await page.locator(`.pane[data-id="${pane}"] .xterm-helper-textarea`).focus();
      await page.keyboard.type('/clear');
      await page.waitForTimeout(250);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.evaluate(() => document.activeElement?.blur());
      await agent(pane, { input: '', busy: false }); // local command sends no turn report
      const text = `untracked ${provider} CLI-only turn`;
      assert.equal((await untracked(ref, text)).ok, true);
      assert.deepEqual((await cli('tasks')).data.map((t) => t.task), before);
      await report(pane, provider === 'claude'
        ? { kind: 'start', match: promptMatch(text) }
        : { kind: 'end', matches: [promptMatch(text)], turn: 'untracked-after-clear' });
      await page.waitForTimeout(250);
      made.push([provider, (await cli('tasks')).data.filter((t) => !before.includes(t.task)).map((t) => [t.source, t.state])]);
    }
    assert.deepEqual(made, [['claude', []], ['codex', []]], 'A known local-command marker must not adopt a different CLI-only turn');
    ok('Claude and Codex reject a known manual hash mismatch after a local command and CLI-only input');
  }

  if (review('send-draft')) {
    await resetReview();
    for (const [provider, pane, ref] of [['claude', claude, 'work:1'], ['codex', codex, 'work:2']]) {
      const prefix = 'Please fix ', asked = 'the test', full = prefix + asked;
      await agent(pane, { input: prefix, busy: false, codexShape: provider === 'codex' });
      await page.waitForTimeout(250);
      const sent = await cli('send', ref, '--receipt', asked);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      assert.equal((await prompts(pane)).at(-1), full, 'Ordinary send preserves append behavior');
      assert.equal((await saved(sent.data.task)).match, promptMatch(full), `${provider}: correlate the full submitted composer`);
      const receipt = (await cli('receipt', sent.data.receipt)).data;
      assert.deepEqual([sent.data.sha256, sent.data.bytes], [createHash('sha256').update(asked).digest('hex'), Buffer.byteLength(asked)]);
      assert.deepEqual([receipt.wrote.sha256, receipt.wrote.bytes], [sent.data.sha256, sent.data.bytes]);
      if (provider === 'claude') {
        await report(pane, { kind: 'start', match: promptMatch(full) });
        await until(sent.data.task, 'working');
        await stops(pane);
      } else {
        await agent(pane, { busy: false });
        await report(pane, { kind: 'end', matches: [promptMatch(full)], turn: 'appended-send' });
      }
      assert.equal((await until(sent.data.task, 'completed')).correlation, 'prompt');
      const event = (await cli('watch', sent.data.task, '--after', '0', '--metadata', '--policy')).data.events.at(-1);
      assert.equal(event.notify, true, 'The matched completion is eligible for its finish notice');
    }
    // No readable composer before or after: never pretend the appended text is the whole prompt.
    await agent(codex, { input: 'hidden earlier draft ', busy: false, codexShape: true, hidden: true });
    await page.waitForTimeout(250);
    const limited = await cli('send', 'work:2', 'with appended text');
    assert.equal(limited.ok, true, JSON.stringify(limited));
    assert.match(limited.data.correlationWarning, /complete.*prompt/i);
    assert.equal((await saved(limited.data.task)).match, '');
    assert.match((await state(limited.data.task)).detail, /complete.*prompt/i);
    ok('Ordinary sends match the complete Claude and Codex draft, keep receipt metadata and report unreadable correlation');
  }

  // Start the older cases with the same empty journal and settings as before.
  await page.evaluate(() => { localStorage.clear(); });
  await reboot();
  if (!process.env.TASK_REVIEW) {

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
    assert.equal((await untracked('work:2', 'same again')).ok, true, 'An untracked send of the same text');
    await report(codex, { kind: 'end', matches: [promptMatch('same again')], turn: 'turn-review3-c' });
    const codexA = await until(a.task, 'unknown');
    assert.deepEqual([codexA.reason, codexA.uncertain], ['submit-uncertain', 'submit'], `Ambiguous, not completed: ${JSON.stringify(codexA)}`);
    // Claude, the same: A's Enter never reached Claude; an untracked send starts and ends a turn of that text.
    await agent(claude, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    const c = await call('submit', ['work:1', 'claude same again'], null, 'review3-c');
    await qa({ failWriteIf: null });
    await agent(claude, { input: '' });
    assert.equal((await untracked('work:1', 'claude same again')).ok, true);
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
    assert.equal((await untracked('work:1', 'approval same text')).ok, true, 'An untracked send of the text');
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
    assert.equal((await untracked('work:1', 'earlier pending same text')).ok, true, 'An untracked prompt goes in first');
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
    assert.equal((await untracked('work:2', 'codex earlier same text')).ok, true);
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
      assert.equal((await untracked('work:1', text)).ok, true);
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
      assert.equal((await untracked(ref, text)).ok, true, 'The earlier, untracked prompt');
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
    assert.deepEqual([held.state, held.final, held.uncertain], ['accepted', false, 'enter'], 'Held back: open, its text maybe waiting');
    // Nothing went in, so the input reads empty: its Enter can't be pressed for it.
    const pasted = await pastes(claude);
    const refused = await call('keys', ['work:1', 'enter', '--task', unseen.task]);
    assert.deepEqual([refused.ok, refused.typed], [false, false], JSON.stringify(refused));
    assert.match(refused.error, /input reads as empty, not the task's text, so Loom pressed nothing/);
    // A plain Enter isn't the task's then, and writing to the pane ends it unknown, never submitted.
    const plain = await cli('keys', 'work:1', 'enter');
    assert.deepEqual([plain.ok, plain.data.task, await pastes(claude)], [true, undefined, pasted]);
    const gone = await until(unseen.task, 'unknown');
    assert.deepEqual([gone.reason, gone.submittedAt, gone.events.map((e) => e.state)], ['not-submitted', null, ['accepted', 'unknown']], JSON.stringify(gone));
    ok('An Enter in doubt stays open with uncertain: submit; a held Enter stays open, and other input ends it unknown');
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

  // Codex's composer, read in its own shape: submit goes in over the placeholder, a draft
  // someone typed stops it, and an input Loom can't read is treated as before.
  {
    await page.evaluate(() => localStorage.removeItem('qa-journal'));
    await reboot();
    await agent(codex, { codexShape: true, busy: false, input: '' });
    const input = async () => (await cli('read', 'work:2')).data.input;
    assert.deepEqual([(await input()).kind, (await input()).text], ['suggestion', 'Ask Codex to do anything'], 'The placeholder, read as typing replaces it');
    const before = (await prompts(codex)).length;
    const first = await cli('submit', 'work:2', 'run the codex task');
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual((await prompts(codex)).slice(before), ['run the codex task'], 'Submitted once, nothing else with it');
    await report(codex, { kind: 'end', matches: [promptMatch('run the codex task')], turn: 'turn-codex-shape-1' });
    assert.equal((await until(first.text, 'completed')).state, 'completed');
    // Someone's own draft: submit types nothing and leaves it.
    await agent(codex, { busy: false, input: 'my own draft' });
    assert.deepEqual([(await input()).kind, (await input()).text], ['draft', 'my own draft']);
    const pasted = await pastes(codex);
    const refused = await cli('submit', 'work:2', 'another task');
    assert.deepEqual([refused.ok, refused.typed], [false, false], JSON.stringify(refused));
    assert.match(refused.error, /holds a draft someone typed, so submit typed nothing/);
    assert.deepEqual([await pastes(codex), await page.evaluate((id) => window.qa.agents[id].input, codex)], [pasted, 'my own draft'], 'Nothing typed, the draft kept');
    // A long task over the placeholder collapses as Codex shows it, and still submits once.
    await agent(codex, { input: '' });
    const long = await call('submit', ['work:2', '-'], 'line one\nline two\nline three\n');
    assert.equal(long.ok, true, JSON.stringify(long));
    assert.equal((await prompts(codex)).at(-1), 'line one\nline two\nline three');
    await report(codex, { kind: 'end', matches: [promptMatch('line one\nline two\nline three')], turn: 'turn-codex-shape-2' });
    await until(long.text, 'completed');
    // Review 2026-10-02 19:08 (P1): a draft whose first line is blank, the cursor on it.
    // The blank row under the cursor is part of the draft, so both guards refuse,
    // with the cursor on its first line or its last.
    for (const [x, y] of [[2, 2], [12, 4]]) {
      const raw = `\x1b[2J\x1b[H• Ran the tests\r\n\r\n\x1b[1m›\x1b[0m \r\n\r\n  third line\r\n\r\n  gpt-5 high · ~\\work\r\n  ? for shortcuts\x1b[${y + 1};${x + 1}H\x1b[?25h`;
      await agent(codex, { codexRaw: raw, busy: false, input: '\n\nthird line' });
      assert.deepEqual([(await input()).kind, (await input()).text], ['draft', '\n\nthird line'], `cursor at ${x},${y}`);
      const pastesBefore = await pastes(codex), promptsBefore = (await prompts(codex)).length;
      const viaSubmit = await cli('submit', 'work:2', 'new task');
      assert.deepEqual([viaSubmit.ok, viaSubmit.typed], [false, false], JSON.stringify(viaSubmit));
      assert.match(viaSubmit.error, /holds a draft someone typed, so submit typed nothing/);
      const viaReplace = await cli('send', 'work:2', '--replace', 'new task');
      assert.deepEqual([viaReplace.ok, viaReplace.typed], [false, false], JSON.stringify(viaReplace));
      assert.match(viaReplace.error, /holds a draft someone typed/);
      assert.deepEqual([await pastes(codex), (await prompts(codex)).length], [pastesBefore, promptsBefore], `Nothing typed or submitted, cursor at ${x},${y}`);
    }
    await agent(codex, { codexRaw: null, input: '' });
    // The cursor hidden: unknown. --replace still refuses; submit keeps its rule for an unread input.
    await agent(codex, { busy: false, input: '', hidden: true });
    assert.equal((await input()).kind, 'unknown');
    const replace = await cli('send', 'work:2', '--replace', 'not over an unread input');
    assert.deepEqual([replace.ok, replace.typed], [false, false], JSON.stringify(replace));
    assert.match(replace.error, /can't be read: Codex's cursor is hidden/);
    await agent(codex, { codexShape: false, hidden: false });
    ok("Codex's composer: submit over its placeholder, a draft kept (a blank first line too), a hidden cursor unread");
  }

  // watch waits on the journal's writes, not a timer, and --metadata gives IDs and state only.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ idleAfterEnter: true }); // no "esc to interrupt": the sweep can't move it to working first
    const r = await cli('submit', 'work:1', 'relayed by metadata');
    await qa({ idleAfterEnter: false });
    await page.waitForTimeout(200);
    const from = (await cli('watch', '--after', '0')).data.last;
    const t0 = Date.now();
    const woken = call('watch', ['--after', String(from), '--metadata'], null, null, 20);
    await page.waitForTimeout(300);
    await report(claude, { kind: 'start', match: promptMatch('relayed by metadata') });
    const w = await woken;
    assert.ok(Date.now() - t0 < 5000, `Woken by the write, not its 20 s deadline (${Date.now() - t0} ms)`);
    assert.deepEqual(Object.keys(w.data).sort(), ['done', 'events', 'gap', 'last', 'next', 'source'], JSON.stringify(w.data));
    assert.deepEqual([w.data.source, w.data.gap, w.data.events.length > 0], ['loom-durable-events-v2', false, true]);
    const mine = (await cli('watch', '--after', String(from), '--metadata')).data.events.find((e) => e.task === r.text);
    assert.deepEqual(Object.keys(mine).sort(), ['at', 'generation', 'pane', 'response', 'seq', 'state', 'task']);
    assert.deepEqual([mine.state, mine.pane, mine.generation], ['working', r.data.pane, r.data.generation]);
    await stops(claude);
    await until(r.text, 'completed');
    ok('watch wakes on the journal write; --metadata carries pane and generation, nothing else');
  }

  // Claude Code 2.1.288 draws no "esc to interrupt" while it works (seen live 2026-10-03, where a working
  // task ended unknown/no-end-signal after 30 s): its working line keeps a Stop and the quiet rule off.
  {
    await agent(claude, { busy: false, input: '', v288: true });
    const r = await cli('submit', 'work:1', 'a long turn on 2.1.288');
    await report(claude, { kind: 'start', match: promptMatch('a long turn on 2.1.288') });
    await until(r.text, 'working');
    await report(claude, { kind: 'stop' }); // another Stop hook sends Claude on: still at work
    await page.waitForTimeout(1500);
    assert.equal((await state(r.text)).state, 'working', 'Its working line on screen: the Stop waits');
    if (!process.env.TASK_QUICK) {
      await page.waitForTimeout(31000);
      assert.equal((await state(r.text)).state, 'working', 'Working past 30 s is not quiet');
    }
    await agent(claude, { busy: false }); // "✻ Worked for 12s"
    assert.equal((await until(r.text, 'completed')).correlation, 'prompt');
    await agent(claude, { v288: false });
    ok("Claude 2.1.288's working line, with no esc hint, keeps its task working past a Stop and 30 s; it completes once gone");
  }

  // Codex hides its status row, "esc to interrupt" with it, while it streams an answer (seen live 2026-10-04: two
  // tasks ended unknown/no-end-signal mid-answer, after web searches). Its title's run state, which Loom asks for
  // (tui.terminal_title run-state), says the turn still runs: the task stays working and the pane busy until the
  // title says Ready and Codex reports the turn's end.
  {
    const title = (t) => page.evaluate(([id, t]) => window.qa.out(id, `\x1b]0;${t}\x07`), [codex, t]);
    const pane = async () => (await cli('panes')).data.find((x) => x.id === codex);
    await agent(codex, { codexShape: true, busy: false, input: '' });
    await title('0199a1b2-c3d4-7e5f-8a9b-0c1d2... | Ready');
    const text = 'a long codex answer after a web search';
    const r = await cli('submit', 'work:2', text);
    await title('0199a1b2-c3d4-7e5f-8a9b-0c1d2... | Working');
    await until(r.text, 'working'); // its hint is up while it starts
    await agent(codex, { busy: false }); // the row goes as the answer streams
    await page.waitForTimeout(1500);
    assert.deepEqual([(await state(r.text)).state, (await pane()).state], ['working', 'working'], 'No hint, its title says Working: still at work');
    if (!process.env.TASK_QUICK) {
      await page.waitForTimeout(31000);
      assert.equal((await state(r.text)).state, 'working', 'Working past 30 s with no hint is not quiet');
    }
    await title('0199a1b2-c3d4-7e5f-8a9b-0c1d2... | Ready');
    await report(codex, { kind: 'end', matches: [promptMatch(text)], turn: 'codex-long-answer', response: promptMatch('Done.') });
    await until(r.text, 'completed');
    await agent(codex, { codexShape: false });
    assert.notEqual((await pane()).state, 'working', 'Ready: the pane is no longer busy');
    ok("Codex's run state in its title keeps a task working while it hides its status row; it completes on Ready and its end report");
  }

  // A paste the agent draws late (seen live 2026-10-04: a 964- and an 1145-byte submit to Codex 0.160 and Claude
  // Code held their Enter as not shown, the text on screen a moment later). Codex drew a long paste in stages, quiet
  // for 0.4 s partway, past a settle's 150 ms: Loom waits for the echo rather than reading the screen once.
  {
    const long = 'Review the change and report each defect with its file and line. '.repeat(18).trim(); // 1,151 bytes
    // Codex's leg is on several lines, which its composer collapses to [Pasted Content N chars], as Codex did
    // for long pastes when probed; one long line would wrap, and the mock doesn't indent wrapped rows as Codex does.
    for (const [pane, ref, shape, text] of [[claude, 'work:1', {}, long], [codex, 'work:2', { codexShape: true }, long.replaceAll('. ', '.\n')]]) {
      await agent(pane, { busy: false, input: '', ...shape });
      await qa({ drawLate: 600 });
      const r = await cli('submit', ref, text);
      await qa({ drawLate: 0 });
      assert.equal(r.ok, true, `${ref}: ${JSON.stringify(r)}`);
      const t = await state(r.text);
      assert.deepEqual([t.state, t.uncertain ?? null], ['submitted', null], JSON.stringify(t));
      assert.equal((await prompts(pane)).at(-1), text, 'Its Enter went in');
      // Its turn, as the agent reports it.
      if (pane === claude) await report(pane, { kind: 'start', match: promptMatch(text) }), await stops(pane);
      else await agent(pane, { busy: false }), await report(pane, { kind: 'end', matches: [promptMatch(text)], turn: 'late-draw', response: promptMatch('Done.') });
      await until(r.text, 'completed');
      await agent(pane, { busy: false, input: '', codexShape: false });
    }
    ok('A paste the agent draws late, past a settle\'s quiet, is still submitted once it shows (Claude Code and Codex)');
  }

  // A held Enter pressed later for its task (the 2026-10-02 pane case): the same task goes on to completed.
  {
    await agent(claude, { busy: false, input: '' });
    const text = 'held then entered for its task';
    const from = (await cli('watch', '--after', '0')).data.last;
    await qa({ unseenPaste: true });
    const held = await cli('submit', 'work:1', text);
    await qa({ unseenPaste: false });
    assert.deepEqual([held.ok, held.typed], [false, true], JSON.stringify(held));
    assert.match(held.error, /loomctl keys work:1 enter --task [0-9a-f]{16} submits it, and the task goes on/);
    const t = held.task;
    const open = await state(t);
    assert.deepEqual([open.state, open.final, open.uncertain, open.reason, open.submittedAt], ['accepted', false, 'enter', null, null], JSON.stringify(open));
    for (let i = 0; i < 40 && (await saved(t))?.uncertain !== 'enter'; i++) await page.waitForTimeout(50);
    assert.equal((await saved(t))?.uncertain, 'enter', 'Journaled as held');
    // Before its Enter, a start of its text is another prompt's, and a sweep with nothing written leaves it.
    await report(claude, { kind: 'start', match: promptMatch(text) });
    await page.waitForTimeout(700);
    assert.equal((await state(t)).state, 'accepted', "A start before the task's Enter isn't its");
    await agent(claude, {}); // the text shows now, as Claude's did a moment late
    const pasted = await pastes(claude);
    const elsewhere = await call('keys', ['work:2', 'enter', '--task', t]);
    assert.deepEqual([elsewhere.ok, elsewhere.typed], [false, false], JSON.stringify(elsewhere));
    assert.match(elsewhere.error, /is on another pane/);
    // Delayed start: the agent's report comes while the Enter's write is still out, and waits for it.
    await qa({ holdWriteIf: "fn:return d === '\\r'" });
    const entering = call('keys', ['work:1', 'enter']);
    await page.waitForFunction(() => window.qa.heldWrites.length === 1);
    await qa({ holdWriteIf: null });
    await report(claude, { kind: 'start', match: promptMatch(text) });
    await page.waitForTimeout(300);
    assert.equal((await state(t)).state, 'accepted', 'Nothing moves it while its Enter is written');
    await page.evaluate(() => window.qa.heldWrites.splice(0).forEach((w) => w.resolve()));
    const entered = await entering;
    assert.deepEqual([entered.ok, entered.data.task, await pastes(claude)], [true, t, pasted], JSON.stringify(entered));
    const working = await until(t, 'working');
    assert.deepEqual([working.correlation, working.uncertain, working.detail, !!working.submittedAt], ['prompt', null, null, true], JSON.stringify(working));
    // Duplicates and another launch's report move nothing; one Stop (twice) completes it once.
    await report(claude, { kind: 'start', match: promptMatch(text) });
    await report(claude, { kind: 'stop', launch: (await gen(claude)) + 1 });
    await page.waitForTimeout(800);
    assert.equal((await state(t)).state, 'working', "Another launch's Stop isn't this one's");
    await stops(claude);
    await report(claude, { kind: 'stop' });
    const done = await cli('wait', '--task', t);
    assert.deepEqual([done.ok, done.data.state, done.data.uncertain, done.data.reason], [true, 'completed', null, null], JSON.stringify(done));
    await report(claude, { kind: 'stop' });
    await page.waitForTimeout(300);
    const one = await cli('watch', t, '--after', '0');
    assert.deepEqual([one.data.events.map((e) => e.state), one.data.done], [['accepted', 'submitted', 'working', 'completed'], true], JSON.stringify(one.data));
    const all = (await cli('watch', '--after', String(from), '--metadata')).data.events.filter((e) => e.task === t);
    assert.deepEqual(all.map((e) => [e.state, e.pane, e.generation]), ['accepted', 'submitted', 'working', 'completed'].map((s) => [s, claude, open.generation]));
    const receipt = (await cli('receipt', t)).data;
    assert.deepEqual([receipt.wrote.stage, receipt.outcome === 'none'], ['submitted', false], JSON.stringify(receipt));
    ok('A held Enter pressed later is its task\'s: a delayed start, duplicates and another launch\'s Stop counted right, completed once');
  }

  // A key typed in the window while the paste was out: the input holds both, so the task isn't held for its Enter.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ holdWriteIf: "fn:return d.startsWith('\\x1b[200~')" });
    const sending = call('submit', ['work:1', 'joined by a keypress']);
    await page.waitForFunction(() => window.qa.heldWrites.length === 1);
    await qa({ holdWriteIf: null });
    await page.locator(`.pane[data-id="${claude}"] .xterm-helper-textarea`).focus();
    await page.keyboard.type('x');
    await page.evaluate(() => { document.activeElement?.blur(); window.qa.heldWrites.splice(0).forEach((w) => w.resolve()); });
    const r = await sending;
    assert.deepEqual([r.ok, r.typed], [false, true], JSON.stringify(r));
    assert.match(r.error, /Something else was typed into claude while Loom was pasting/);
    const t = await state(r.task);
    assert.deepEqual([t.state, t.reason, t.uncertain], ['failed', 'not-submitted', null], JSON.stringify(t));
    ok("Typing in the window during the paste still fails the task: its Enter isn't held for it");
  }

  // A held task whose pane restarts is cancelled, and its Enter can't be pressed for it after.
  {
    await agent(claude, { busy: false, input: '' });
    await qa({ unseenPaste: true });
    const held = await cli('submit', 'work:1', 'held then restarted');
    await qa({ unseenPaste: false });
    assert.equal((await state(held.task)).uncertain, 'enter');
    const g = await gen(claude);
    assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
    assert.equal((await until(held.task, 'cancelled')).reason, 'pane-restarted');
    const late = await call('keys', ['work:1', 'enter', '--task', held.task]);
    assert.deepEqual([late.ok, late.typed], [false, false], JSON.stringify(late));
    assert.match(late.error, /isn't waiting for its Enter \(it's cancelled\)/);
    await report(claude, { kind: 'start', match: promptMatch('held then restarted'), launch: g });
    await page.waitForTimeout(300);
    assert.equal((await state(held.task)).state, 'cancelled', 'An old launch reporting its text changes nothing');
    ok('A held task cancels with its pane, and its Enter is refused after');
  }

  // Review 2026-10-03 00:28 (P2): a held task's receipt stays pending and linked while its Enter can still be
  // pressed, so 510 later settled receipts don't prune it; one Enter recovers task and receipt together.
  {
    const claude3 = await paneId('work:3');
    await agent(claude, { busy: false, input: '' });
    await qa({ unseenPaste: true });
    const text = 'held past five hundred receipts';
    const held = await cli('submit', 'work:1', text);
    await qa({ unseenPaste: false });
    const t = held.task;
    let r = (await cli('receipt', t)).data;
    assert.deepEqual([r.outcome, r.held, r.wrote.stage], ['pending', true, 'typed'], JSON.stringify(r));
    // 510 later receipts that settle at once: sends to two other panes whose paste write fails, so each ends
    // unsent. (A paste that never shows would settle too, but only after sendReply's 5 s wait for its echo.) Sent
    // from the page in one go; they take turns per pane.
    await agent(codex, { busy: false, input: '' });
    await agent(claude3, { busy: false, input: '' });
    await qa({ failWriteIf: "fn:return d.includes('filler ')" });
    const tokens = await page.evaluate(async ([refs, n]) => {
      const ids = [];
      for (let i = 0; i < n; i++) {
        const id = window.qa.cliIds = (window.qa.cliIds ?? 0) + 1;
        ids.push(id);
        await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'cli', payload: { id, cmd: 'send', argv: [refs[i % refs.length], '--receipt', `filler ${i}`], stdin: null, cwd: null, timeout: 600, key: null } });
      }
      const want = new Set(ids);
      for (const end = Date.now() + 300000; Date.now() < end; await new Promise((res) => setTimeout(res, 250))) {
        const got = new Map();
        for (const c of window.qa.calls) if (c.cmd === 'cli_reply' && want.has(c.args.id)) got.set(c.args.id, c.args.reply);
        if (got.size === ids.length) return ids.map((id) => got.get(id).receipt);
      }
      return null;
    }, [['work:2', 'work:3'], 510]);
    await qa({ failWriteIf: null });
    assert.equal(tokens?.filter(Boolean).length, 510, 'Every filler send settled with a receipt');
    assert.equal((await cli('receipt', tokens[0])).ok, false, 'The oldest filler was pruned: the settled history is full');
    r = (await cli('receipt', t)).data;
    assert.deepEqual([r.outcome, r.held, r.wrote.stage], ['pending', true, 'typed'], `Still there, still pending: ${JSON.stringify(r)}`);
    // One Enter recovers it: no second paste, the same task and the same receipt.
    await agent(claude, {}); // the text shows now
    const pasted = await pastes(claude);
    const entered = await cli('keys', 'work:1', 'enter', '--task', t);
    assert.deepEqual([entered.ok, entered.data.task, await pastes(claude)], [true, t, pasted], JSON.stringify(entered));
    assert.equal((await prompts(claude)).filter((p) => p === text).length, 1, 'Its text went in once');
    await report(claude, { kind: 'start', match: promptMatch(text) });
    await until(t, 'working');
    await stops(claude);
    const done = await cli('wait', '--task', t);
    assert.deepEqual([done.data.state, done.data.task], ['completed', t]);
    r = (await cli('receipt', t)).data;
    assert.deepEqual([r.receipt, r.held, r.wrote.stage, r.outcome === 'none'], [t, false, 'submitted', false], `Linked and queryable after recovery: ${JSON.stringify(r)}`);
    ok('A held task keeps its receipt past 510 later settled ones; one Enter recovers both, no second paste');
  }

  // The same receipt settles when its held task ends instead: other input (unknown), or its pane restarting (cancelled).
  {
    for (const how of ['input', 'restart']) {
      await agent(claude, { busy: false, input: '' });
      await qa({ unseenPaste: true });
      const held = await cli('submit', 'work:1', `held then ${how}`);
      await qa({ unseenPaste: false });
      assert.equal((await cli('receipt', held.task)).data.held, true);
      if (how === 'input') assert.equal((await cli('keys', 'work:1', 'x')).ok, true);
      else assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
      const end = await until(held.task, how === 'input' ? 'unknown' : 'cancelled');
      assert.equal(end.reason, how === 'input' ? 'not-submitted' : 'pane-restarted');
      const r = (await cli('receipt', held.task)).data;
      assert.deepEqual([r.held, r.outcome, r.wrote.stage], [false, 'none', 'typed'], `${how}: settled, never pressed: ${JSON.stringify(r)}`);
      const late = await call('keys', ['work:1', 'enter', '--task', held.task]);
      assert.deepEqual([late.ok, late.typed], [false, false], JSON.stringify(late));
    }
    ok("A held task's receipt settles as unsent when other input or a restart ends the task, and recovery is refused");
  }

  // The fixture matrix behind the email bridge: Claude Code, Codex and OpenCode, as their reports reach Loom, each
  // through completion, failure, an approval, repeated idle reports, simultaneous panes, a generation change, a new
  // attempt and a Loom restart. watch --metadata is checked per cell here; TASK_MATRIX_OUT=<file> also writes the
  // events and cells for the bridge's own tests (its fixtures/loom-metadata-matrix.json).
  {
    await agent(claude, { busy: false, input: '' });
    await agent(codex, { busy: false, input: '' });
    const oc = (await call('add', ['work', '--cmd=opencode'])).data.id;
    const ocRef = (await cli('panes')).data.find((p) => p.id === oc).ref;
    const refs = { claude: 'work:1', codex: 'work:2', opencode: ocRef };
    const id = async (provider) => (await cli('panes')).data.find((p) => p.ref === refs[provider]).id;
    await agent(oc, { busy: false, input: '' });
    // A session for Codex and OpenCode to resume, as their notify and plugin report one, so they can restart.
    await qa({ sessions: [[codex, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'], [oc, 'ses_matrix']] });
    await page.waitForFunction(() => !window.qa.sessions.length, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    const base = (await cli('watch', '--after', '0')).data.last;
    let turns = 0;
    // How each agent's reports reach Loom (helper.rs, the OpenCode plugin): Claude names its prompt on start and
    // its final message on Stop, then sits idle; Codex reports no start (its screen shows it working) and names
    // prompt and final message on the turn's end; OpenCode names neither prompt nor start, only its final message.
    const start = async (provider, text) => {
      const p = await id(provider);
      await agent(p, { busy: true });
      if (provider === 'claude') await report(p, { kind: 'start', match: promptMatch(text) });
      if (provider === 'opencode') await report(p, { kind: 'start' });
    };
    const finish = async (provider, text, answer) => {
      const p = await id(provider);
      await agent(p, { busy: false });
      if (provider === 'claude') await report(p, { kind: 'stop', response: promptMatch(answer) });
      if (provider === 'codex') await report(p, { kind: 'end', matches: [promptMatch(text)], turn: `matrix-${++turns}`, response: promptMatch(answer) });
      if (provider === 'opencode') await report(p, { kind: 'end', response: promptMatch(answer) });
    };
    const submit = async (provider, text) => {
      await agent(await id(provider), { busy: false, input: '' });
      const r = await cli('submit', refs[provider], text);
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.text;
    };
    const run = async (provider, text, answer) => {
      const t = await submit(provider, text);
      await start(provider, text);
      await until(t, 'working');
      await finish(provider, text, answer);
      return t;
    };
    const cells = [];
    const events = async () => (await cli('watch', '--after', String(base), '--metadata')).data.events;
    const mine = async (t) => (await events()).filter((e) => e.task === t);
    for (const provider of ['claude', 'codex', 'opencode']) {
      // Completion: completed, naming the final message by its match.
      const c = await run(provider, `${provider} matrix completion`, 'All 12 tests pass.');
      assert.deepEqual((await until(c, 'completed')).state, 'completed');
      const completedEvent = (await mine(c)).at(-1);
      assert.deepEqual([completedEvent.state, completedEvent.response], ['completed', promptMatch('All 12 tests pass.')], JSON.stringify(completedEvent));
      assert.ok((await mine(c)).slice(0, -1).every((e) => e.response === null), 'Only the completed event names a response');
      cells.push({ provider, scenario: 'completion', tasks: [c], expect: [['finish']] });

      // Failure: Claude's and OpenCode's own reports; Codex reports none, so its process exiting is the failure.
      const f = await submit(provider, `${provider} matrix failure`);
      await start(provider, `${provider} matrix failure`);
      await until(f, 'working');
      if (provider === 'codex') {
        await page.evaluate((p) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${p}`, payload: 1 }), await id(provider));
        assert.equal((await until(f, 'failed')).reason, 'exited');
        const back = await cli('restart', refs[provider], '--yes');
        assert.equal(back.ok, true, JSON.stringify(back));
        await page.waitForTimeout(300);
      } else {
        await report(await id(provider), { kind: 'fail', detail: 'rate_limit' });
        await until(f, 'failed');
        await agent(await id(provider), { busy: false });
      }
      assert.equal((await mine(f)).at(-1).response, null, 'A failure names no response');
      cells.push({ provider, scenario: 'failure', tasks: [f], expect: [['fail']] });

      // Approval: blocked, answered, then completed: two outcomes of one attempt.
      const a = await submit(provider, `${provider} matrix approval`);
      await start(provider, `${provider} matrix approval`);
      await until(a, 'working');
      await report(await id(provider), { kind: 'approval', detail: 'Write' });
      await until(a, 'approval');
      await report(await id(provider), { kind: 'approval', detail: 'Write' }); // asked again: no second event
      await report(await id(provider), { kind: 'resume' });
      await until(a, 'working');
      await finish(provider, `${provider} matrix approval`, 'Wrote the file.');
      await until(a, 'completed');
      assert.deepEqual((await mine(a)).map((e) => e.state), ['accepted', 'submitted', 'working', 'approval', 'working', 'completed']);
      cells.push({ provider, scenario: 'approval-blocked', tasks: [a], expect: [['blocked', 'finish']] });

      // Repeated idle: the agent reports the same end again (another Stop, the turn again or under a new id, another
      // idle run end). The task is final, so Loom adds nothing; the bridge must suppress a repeat it ever sees.
      const i = await run(provider, `${provider} matrix repeated idle`, 'Done.');
      await until(i, 'completed');
      const before = (await mine(i)).length;
      for (let n = 0; n < 2; n++) await finish(provider, `${provider} matrix repeated idle`, 'Done.');
      await page.waitForTimeout(1200);
      assert.equal((await mine(i)).length, before, 'Repeated idle reports add no event');
      cells.push({ provider, scenario: 'repeated-idle', tasks: [i], expect: [['finish']] });

      // A new attempt: the same text again, the same answer: its own task, its own outcome.
      const n1 = await run(provider, `${provider} matrix same text`, 'Done.');
      await until(n1, 'completed');
      const n2 = await run(provider, `${provider} matrix same text`, 'Done.');
      await until(n2, 'completed');
      assert.notEqual(n1, n2);
      assert.deepEqual([(await mine(n1)).at(-1).response, (await mine(n2)).at(-1).response], [promptMatch('Done.'), promptMatch('Done.')]);
      cells.push({ provider, scenario: 'new-attempt', tasks: [n1, n2], expect: [['finish'], ['finish']] });

      // A generation change: the pane restarts mid-task (cancelled); its old launch's late end moves nothing; the
      // next launch's task completes under the new generation.
      const g1 = await submit(provider, `${provider} matrix generation`);
      await start(provider, `${provider} matrix generation`);
      await until(g1, 'working');
      const oldGen = (await state(g1)).generation;
      assert.equal((await cli('restart', refs[provider], '--yes')).ok, true);
      assert.equal((await until(g1, 'cancelled')).reason, 'pane-restarted');
      const late = provider === 'codex' ? { kind: 'end', matches: [promptMatch(`${provider} matrix generation`)], turn: `matrix-${++turns}` } : provider === 'claude' ? { kind: 'stop' } : { kind: 'end' };
      await report(await id(provider), { ...late, response: promptMatch('Done.'), launch: oldGen });
      await page.waitForTimeout(300);
      const g2 = await run(provider, `${provider} matrix generation`, 'Done.');
      await until(g2, 'completed');
      const [e1, e2] = [(await mine(g1)).at(-1), (await mine(g2)).at(-1)];
      assert.deepEqual([e1.state, e1.response, e2.state, e2.generation > e1.generation], ['cancelled', null, 'completed', true], JSON.stringify([e1, e2]));
      cells.push({ provider, scenario: 'generation-change', tasks: [g1, g2], expect: [[], ['finish']] });
    }

    // Simultaneous panes: one task on each, all answering the same "Done.": three outcomes, one per pane.
    const texts = { claude: 'claude matrix together', codex: 'codex matrix together', opencode: 'opencode matrix together' };
    const together = Object.fromEntries(await Promise.all(Object.keys(texts).map(async (p) => [p, await submit(p, texts[p])])));
    for (const p of Object.keys(texts)) await start(p, texts[p]);
    for (const p of Object.keys(texts)) await until(together[p], 'working');
    await Promise.all(Object.keys(texts).map((p) => finish(p, texts[p], 'Done.')));
    for (const p of Object.keys(texts)) {
      await until(together[p], 'completed');
      cells.push({ provider: p, scenario: 'simultaneous-panes', tasks: [together[p]], expect: [['finish']] });
    }
    const last = await Promise.all(Object.keys(texts).map(async (p) => (await mine(together[p])).at(-1)));
    assert.equal(new Set(last.map((e) => e.pane)).size, 3, 'Three panes');
    assert.equal(new Set(last.map((e) => e.response)).size, 1, 'One answer text, named alike');

    // A Loom restart: the journal brings back every event as it was, the same numbers and the same responses.
    const whole = (await cli('watch', '--after', String(base), '--metadata', '--policy')).data;
    assert.equal(whole.source, 'loom-durable-events-v3');
    assert.ok(whole.events.every((e) => Object.keys(e).sort().join() === 'at,generation,notify,pane,response,seq,source,state,task'), 'Metadata only');
    assert.ok(whole.events.every((e) => e.notify === ['completed', 'failed', 'approval'].includes(e.state)), 'Every pane on: every outcome may go out');
    // Every pane on, the default: v2 reads the same events, without the two fields.
    const v2 = (await cli('watch', '--after', String(base), '--metadata')).data;
    assert.deepEqual([v2.source, v2.events], ['loom-durable-events-v2', whole.events.map(({ source, notify, ...e }) => e)]);
    await reboot();
    const again = (await cli('watch', '--after', String(base), '--metadata', '--policy')).data;
    assert.deepEqual(again.events.filter((e) => e.seq <= whole.last), whole.events, 'Replayed after a restart exactly as before');
    for (const p of ['claude', 'codex', 'opencode']) cells.push({ provider: p, scenario: 'restart-replay', tasks: cells.filter((c) => c.provider === p && c.scenario === 'completion')[0].tasks, expect: [['finish']] });
    if (process.env.TASK_MATRIX_OUT) {
      const { writeFileSync } = await import('node:fs');
      const batch = { source: whole.source, events: whole.events, next: whole.last, last: whole.last, gap: false, done: false };
      writeFileSync(process.env.TASK_MATRIX_OUT, JSON.stringify({ made: 'Loom scripts/task-check.mjs over Tauri mocks; no live agent or mail', baseline: base, batch, cells }, null, 1) + '\n');
    }
    ok(`Matrix: ${cells.length} cells across Claude Code, Codex and OpenCode, metadata replayed exactly after a restart`);
  }

  // Ordinary sends and a person's own input are tasks too, each told apart by its source (task.ts TaskSource):
  // an ordinary loomctl send, and a person's Enter in Loom's window (the pane's own terminal, the Overview's
  // reply box), which becomes a task only once the agent reports the turn it sent.
  const ocPane = (await call('add', ['work', '--cmd=opencode'])).data.id;
  const ocRef = (await cli('panes')).data.find((p) => p.id === ocPane).ref;
  await agent(ocPane, { busy: false, input: '' });
  const refOf = { claude: 'work:1', codex: 'work:2', opencode: ocRef };
  const paneOf = async (provider) => (await cli('panes')).data.find((p) => p.ref === refOf[provider]).id;
  const taskIds = async () => (await cli('tasks')).data.map((t) => t.task);
  const newTasks = async (before) => (await cli('tasks')).data.filter((t) => !before.includes(t.task));
  /** A person typing in the pane in Loom's window and pressing Enter there, never loomctl. */
  const typeIn = async (pane, text) => {
    await page.locator(`.pane[data-id="${pane}"] .xterm-helper-textarea`).focus();
    if (text) await page.keyboard.type(text);
    await page.waitForTimeout(250); // the input shows it before the Enter, as it does for a person
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.evaluate(() => document.activeElement?.blur());
  };
  /** Each agent's own reports of a turn, as they reach Loom (helper.rs, the OpenCode plugin). */
  let manualTurns = 0;
  const startTurn = async (provider, pane, text) => {
    await agent(pane, { busy: true });
    if (provider === 'claude') await report(pane, { kind: 'start', match: promptMatch(text) });
    if (provider === 'opencode') await report(pane, { kind: 'start' });
  };
  const endTurn = async (provider, pane, text, answer = 'Done.') => {
    await agent(pane, { busy: false });
    if (provider === 'claude') await report(pane, { kind: 'stop', response: promptMatch(answer) });
    if (provider === 'codex') await report(pane, { kind: 'end', matches: [promptMatch(text)], turn: `manual-${++manualTurns}`, response: promptMatch(answer) });
    if (provider === 'opencode') await report(pane, { kind: 'end', response: promptMatch(answer) });
  };
  const waitNew = async (before, n = 1) => {
    for (let i = 0; i < 40; i++) { const got = await newTasks(before); if (got.length >= n) return got; await page.waitForTimeout(100); }
    return newTasks(before);
  };

  // An ordinary send (the reproduced gap): a task of its own, linked to its receipt, on every agent. A shell's isn't.
  {
    for (const provider of ['claude', 'codex', 'opencode']) {
      const pane = await paneOf(provider), text = `${provider} ordinary send`;
      await agent(pane, { busy: false, input: '', codexShape: provider === 'codex' });
      await page.waitForTimeout(250);
      const before = await taskIds();
      const sent = await cli('send', refOf[provider], '--receipt', text);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const made = await newTasks(before);
      assert.deepEqual(made.map((t) => [t.task, t.source, t.final]), [[sent.data.receipt, 'send', false]], `${provider}: ${JSON.stringify(made)}`);
      assert.equal(sent.data.task, sent.data.receipt, 'The task and its receipt are one token');
      assert.deepEqual([made[0].sha256, made[0].bytes], [sent.data.sha256, sent.data.bytes], 'The caller\'s digest, never the text');
      await startTurn(provider, pane, text);
      await until(sent.data.task, 'working');
      await endTurn(provider, pane, text, 'Sent and done.');
      const done = await until(sent.data.task, 'completed');
      assert.deepEqual([done.source, done.correlation === 'screen'], ['send', false], JSON.stringify(done));
      const meta = (await cli('watch', sent.data.task, '--after', '0', '--metadata', '--policy')).data.events.at(-1);
      assert.deepEqual([meta.state, meta.source, meta.notify, meta.response], ['completed', 'send', true, promptMatch('Sent and done.')]);
      assert.equal((await cli('receipt', sent.data.receipt)).ok, true, 'Its receipt is still there');
    }
    const shell = (await call('add', ['work', '--cmd='])).data.id;
    await page.waitForFunction((id) => window.qa.panes.some((p) => p.id === id), shell);
    await page.waitForTimeout(400);
    const before = await taskIds();
    const shellRef = (await cli('panes')).data.find((p) => p.id === shell).ref;
    const plain = await cli('send', shellRef, 'echo untracked line');
    assert.deepEqual([plain.ok, plain.data.task, (await newTasks(before)).length], [true, undefined, 0], 'A shell line has no turn to follow: no task');
    assert.equal((await cli('send', 'work:1', '--no-enter', 'typed only')).data.task, undefined, '--no-enter: no Enter, no task');
    await agent(claude, { busy: false, input: '' });
    ok('An ordinary send is a task of its own on Claude, Codex and OpenCode, linked to its receipt; a shell line and --no-enter are not');
  }

  // A person's input in Loom's window, a path apart from loomctl's: a task once the agent reports the turn, never before.
  {
    // Claude: the prompt's report names it; until then nothing.
    await agent(claude, { busy: false, input: '' });
    let before = await taskIds();
    await typeIn(claude, 'claude typed by hand');
    assert.equal((await prompts(claude)).at(-1), 'claude typed by hand', 'It went in from the window');
    assert.deepEqual(await newTasks(before), [], 'No task until Claude reports the turn');
    await startTurn('claude', claude, 'claude typed by hand');
    const [c] = await waitNew(before);
    assert.deepEqual([c?.source, c?.state, c?.correlation, c?.sha256, c?.bytes], ['manual', 'working', 'prompt', '', 0], JSON.stringify(c));
    await endTurn('claude', claude, 'claude typed by hand', 'Handled.');
    assert.equal((await until(c.task, 'completed')).source, 'manual');
    // Codex with an input it can't read (its composer isn't drawn): the turn's end report makes the task.
    await agent(codex, { busy: false, input: '', codexShape: false });
    before = await taskIds();
    await typeIn(codex, 'codex typed by hand');
    assert.deepEqual(await newTasks(before), [], 'Nothing read, nothing reported yet: no task');
    await endTurn('codex', codex, 'codex typed by hand');
    const [x] = await waitNew(before);
    assert.deepEqual([x?.source, x?.state, x?.correlation], ['manual', 'completed', 'prompt'], JSON.stringify(x));
    // Codex with its composer read off the screen: a task at the Enter, since Codex reports only finished turns.
    await agent(codex, { codexShape: true, busy: false, input: '' });
    before = await taskIds();
    await typeIn(codex, 'codex read by Loom');
    const [y] = await waitNew(before);
    assert.deepEqual([y?.source, ['submitted', 'working'].includes(y?.state), y?.correlation === 'prompt'], ['manual', true, false], `A task before any report: ${JSON.stringify(y)}`);
    await endTurn('codex', codex, 'codex read by Loom');
    await until(y.task, 'completed');
    await agent(codex, { codexShape: false, input: '' });
    // OpenCode names no prompt: the first run it reports after the Enter.
    before = await taskIds();
    await typeIn(ocPane, 'opencode typed by hand');
    assert.deepEqual(await newTasks(before), [], 'No run reported yet: no task');
    await startTurn('opencode', ocPane, '');
    const [o] = await waitNew(before);
    assert.deepEqual([o?.source, o?.state, o?.correlation], ['manual', 'working', 'sequence'], JSON.stringify(o));
    await endTurn('opencode', ocPane, '');
    await until(o.task, 'completed');
    // An Enter on an empty input sends nothing, and a turn nobody's Enter explains (a background notice) stays untracked.
    await agent(claude, { busy: false, input: '' });
    before = await taskIds();
    await typeIn(claude, '');
    await startTurn('claude', claude, 'a background notice');
    await endTurn('claude', claude, 'a background notice');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'No task for an empty Enter or a turn no Enter sent');
    // The Overview's reply box is a person's input too: its own text names the prompt.
    await agent(claude, { busy: false, input: '' });
    await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'wakes', payload: [[id, '']] }), claude);
    await page.click('#dashboard-btn');
    const box = page.locator(`input[data-key="reply-${claude}"]`).first();
    await box.waitFor();
    before = await taskIds();
    await box.fill('replied from the overview');
    await box.press('Enter');
    await page.waitForFunction((id) => window.qa.prompts.some(([p, t]) => p === id && t === 'replied from the overview'), claude);
    assert.deepEqual(await newTasks(before), [], 'Not before Claude reports it');
    await startTurn('claude', claude, 'replied from the overview');
    const [r] = await waitNew(before);
    assert.deepEqual([r?.source, r?.correlation], ['manual', 'prompt'], JSON.stringify(r));
    await endTurn('claude', claude, 'replied from the overview');
    await until(r.task, 'completed');
    await page.click('#dashboard-btn');
    ok('Input typed in a pane or replied in the Overview is a manual task once Claude, Codex or OpenCode reports its turn; an empty Enter or an unexplained turn is none');
  }

  // Review 2026-10-03 15:52 (P2): a person's Enter whose write failed can't be proven sent, so the turn a report then
  // names ends unknown, never completed, even when the report comes while the write is still out. And an Enter in
  // OpenCode's input, which Loom can't read, with nothing typed since the last Enter, claims no turn loomctl sent.
  {
    const rejectHeld = () => page.evaluate(() => window.qa.heldWrites.splice(0).forEach((w) => w.reject(new Error('Test: the terminal write failed late'))));
    // Claude: the Enter fails at once; a start naming the same words (an earlier prompt's, written late) proves nothing.
    await agent(claude, { busy: false, input: '' });
    let before = await taskIds();
    await qa({ failWriteIf: "fn:return d === '\\r'" });
    await typeIn(claude, 'claude enter failed');
    await qa({ failWriteIf: null });
    await startTurn('claude', claude, 'claude enter failed');
    const [cf] = await waitNew(before);
    assert.deepEqual([cf?.source, cf?.uncertain], ['manual', 'submit'], JSON.stringify(cf));
    await endTurn('claude', claude, 'claude enter failed');
    const cDone = await until(cf.task, 'unknown');
    assert.deepEqual([cDone.reason, (await saved(cf.task))?.state, (await saved(cf.task))?.uncertain], ['submit-uncertain', 'unknown', 'submit'], JSON.stringify(cDone));
    // Claude again, the report arriving while the Enter's write is out, and the write failing after it.
    await agent(claude, { busy: false, input: '' });
    before = await taskIds();
    await qa({ holdWriteIf: "fn:return d === '\\r'" });
    await typeIn(claude, 'claude enter failed late');
    await page.waitForFunction(() => window.qa.heldWrites.length > 0);
    await qa({ holdWriteIf: null });
    await startTurn('claude', claude, 'claude enter failed late');
    await page.waitForTimeout(300);
    assert.deepEqual(await newTasks(before), [], 'The report waits for the write');
    await rejectHeld();
    const [cl] = await waitNew(before);
    assert.deepEqual([cl?.source, cl?.uncertain], ['manual', 'submit'], JSON.stringify(cl));
    await endTurn('claude', claude, 'claude enter failed late');
    assert.equal((await until(cl.task, 'unknown')).reason, 'submit-uncertain');
    // Codex with its composer read: the task is made at the Enter; its turn's end comes while the write is out, then it fails.
    await agent(codex, { codexShape: true, busy: false, input: '' });
    before = await taskIds();
    await qa({ holdWriteIf: "fn:return d === '\\r'" });
    await typeIn(codex, 'codex enter failed late');
    await page.waitForFunction(() => window.qa.heldWrites.length > 0);
    await qa({ holdWriteIf: null });
    const [xf] = await waitNew(before);
    assert.equal(xf?.source, 'manual', JSON.stringify(xf));
    await endTurn('codex', codex, 'codex enter failed late');
    await page.waitForTimeout(300);
    assert.equal(isFinal((await cli('task', xf.task)).data.state), false, 'The end waits for the write');
    await rejectHeld();
    const xDone = await until(xf.task, 'unknown');
    assert.deepEqual([xDone.uncertain, xDone.reason], ['submit', 'submit-uncertain'], JSON.stringify(xDone));
    // The same, the write succeeding: completed as before. (The failed Enter left its text in the composer.)
    await agent(codex, { codexShape: true, busy: false, input: '' });
    before = await taskIds();
    await typeIn(codex, 'codex enter went in');
    const [xo] = await waitNew(before);
    await endTurn('codex', codex, 'codex enter went in');
    assert.equal((await until(xo.task, 'completed')).uncertain ?? null, null);
    await agent(codex, { codexShape: false, input: '' });
    // OpenCode: an Enter with nothing typed, then a run nobody's Enter sent (no Enter of Loom's either).
    await agent(ocPane, { busy: false, input: '' });
    before = await taskIds();
    await typeIn(ocPane, '');
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'An empty Enter claims no later run');
    // A person's Enter that started no run (typed, so noted), then a prompt loomctl typed and entered: loomctl's Enter explains it.
    await typeIn(ocPane, 'handled without a run');
    await agent(ocPane, { busy: false, input: '' });
    assert.equal((await untracked(ocRef, 'opencode typed by loomctl first')).ok, true);
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'An earlier Enter naming no prompt claims no turn loomctl entered');
    // An Enter with nothing typed, then a prompt loomctl typed and entered, which no task follows.
    await typeIn(ocPane, '');
    assert.equal((await untracked(ocRef, 'opencode typed by loomctl')).ok, true);
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'An empty Enter claims no turn loomctl sent');
    // Typed, then cleared with Ctrl+U: empty again.
    await page.locator(`.pane[data-id="${ocPane}"] .xterm-helper-textarea`).focus();
    await page.keyboard.type('never sent');
    await page.keyboard.press('Control+U');
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.activeElement?.blur());
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'Nor one cleared before its Enter');
    // A person's Enter after typing still makes its task, as above.
    await typeIn(ocPane, 'opencode typed after');
    await startTurn('opencode', ocPane, '');
    const [oc2] = await waitNew(before);
    assert.equal(oc2?.source, 'manual');
    await endTurn('opencode', ocPane, '');
    await until(oc2.task, 'completed');
    ok('A person\'s Enter whose write failed, at once or after the agent reported, ends its turn unknown; an empty OpenCode Enter claims no loomctl turn');
  }

  // Review 2026-10-03 19:10 (P2): a person's Enters don't take turns as sends do, so two can be written at once. Each
  // holds the pane's reports until its own outcome is on its task: what came meanwhile goes in only when both have one,
  // and a failure leaves only its own task in doubt.
  {
    const settle = (i, went) => page.evaluate(([i, went]) => {
      const w = window.qa.heldWrites[i];
      if (went) w.resolve(); else w.reject(new Error('Test: the terminal write failed late'));
    }, [i, went]);
    const holdBoth = async (pane, first, second, reset) => {
      await page.evaluate(() => (window.qa.heldWrites.length = 0));
      await qa({ holdWriteIf: "fn:return d === '\\r'" });
      await typeIn(pane, first);
      await reset(); // the first Enter never reached the process: a person clears the input and types another prompt
      await typeIn(pane, second);
      await page.waitForFunction(() => window.qa.heldWrites.length === 2);
      await qa({ holdWriteIf: null });
    };
    const finals = (...ts) => Promise.all(ts.map(async (t) => (await cli('task', t.task)).data.final));
    // Codex, its composer read: a task at each Enter. The second Enter goes in, then (second pass) fails.
    for (const second of ['went in', 'failed']) {
      const reset = () => agent(codex, { codexShape: true, busy: false, input: '' });
      await reset();
      const before = await taskIds();
      await holdBoth(codex, `codex first, then one that ${second}`, `codex second, one that ${second}`, reset);
      const [one, two] = await waitNew(before, 2);
      assert.deepEqual([one?.source, two?.source], ['manual', 'manual'], JSON.stringify([one, two]));
      // The second's turn reported while both are out, then the first goes in, the second still out: nothing moves.
      await endTurn('codex', codex, `codex second, one that ${second}`);
      await settle(0, true);
      await page.waitForTimeout(400);
      assert.deepEqual(await finals(one, two), [false, false], 'Reports wait for every Enter still out');
      // The first's own turn, reported in the overlap.
      await endTurn('codex', codex, `codex first, then one that ${second}`);
      await page.waitForTimeout(400);
      assert.deepEqual(await finals(one, two), [false, false], 'Still waiting for the second');
      await settle(1, second === 'went in');
      const t1 = await until(one.task, 'completed');
      const t2 = await until(two.task, second === 'went in' ? 'completed' : 'unknown');
      assert.deepEqual([t1.uncertain ?? null, t2.uncertain ?? null, t2.reason ?? null],
        [null, ...(second === 'went in' ? [null, null] : ['submit', 'submit-uncertain'])], JSON.stringify([t1, t2]));
      const kept = await saved(two.task);
      assert.deepEqual([kept?.state, kept?.uncertain ?? null], [t2.state, t2.uncertain ?? null], 'The journal says the same');
    }
    // Claude: Enters are noted, tasks come with its reports. The second's start, reported in the overlap, waits for the
    // second write, and its failure is on the task that start makes.
    {
      const reset = () => agent(claude, { busy: false, input: '' });
      await reset();
      const before = await taskIds();
      await holdBoth(claude, 'claude overlap first', 'claude overlap second', reset);
      await startTurn('claude', claude, 'claude overlap second');
      await settle(0, true);
      await page.waitForTimeout(400);
      assert.deepEqual(await newTasks(before), [], 'No task while the second Enter is out');
      await settle(1, false);
      const [c2] = await waitNew(before);
      assert.deepEqual([c2?.source, c2?.uncertain], ['manual', 'submit'], JSON.stringify(c2));
      await endTurn('claude', claude, 'claude overlap second');
      assert.equal((await until(c2.task, 'unknown')).reason, 'submit-uncertain');
      await reset();
    }
    // The pane exits while a person's Enter is still out, then the write fails: the task isn't final before the
    // failure is known, and ends with the doubt on it.
    {
      await agent(codex, { codexShape: true, busy: false, input: '' });
      const before = await taskIds();
      await page.evaluate(() => (window.qa.heldWrites.length = 0));
      await qa({ holdWriteIf: "fn:return d === '\\r'" });
      await typeIn(codex, 'codex enter out at an exit');
      await page.waitForFunction(() => window.qa.heldWrites.length === 1);
      await qa({ holdWriteIf: null });
      const [x] = await waitNew(before);
      await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${id}`, payload: 1 }), codex);
      await page.waitForTimeout(1200); // past the sweep
      assert.equal((await cli('task', x.task)).data.final, false, 'Not final while its Enter is out');
      await settle(0, false);
      const xe = await until(x.task, 'failed');
      assert.deepEqual([xe.reason, xe.uncertain, (await saved(x.task))?.uncertain], ['exited', 'submit', 'submit'], JSON.stringify(xe));
      // Codex starts again by resuming its session, as its notify reports one.
      await qa({ sessions: [[codex, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c']] });
      await page.waitForFunction(() => !window.qa.sessions.length, null, { timeout: 10000 });
      await page.waitForTimeout(200);
      const back = await cli('restart', 'work:2', '--yes');
      assert.equal(back.ok, true, JSON.stringify(back));
      await page.waitForTimeout(300);
      await agent(codex, { codexShape: false, busy: false, input: '' });
    }
    ok('Overlapping Enters of a person\'s: reports wait for every write; the first going in releases nothing; the second going in or failing settles only its own task; a pane exit during a write ends no task before its outcome');
  }

  // Review 2026-10-03 19:10 (P2): typing evidence belongs to the launch that got it. A draft left in OpenCode's process
  // before a relaunch is no sign that an Enter on the new launch's empty input sent anything.
  {
    await agent(ocPane, { busy: false, input: '' });
    const before = await taskIds();
    const gen = async () => (await cli('panes')).data.find((p) => p.id === ocPane).generation;
    const g1 = await gen();
    await page.locator(`.pane[data-id="${ocPane}"] .xterm-helper-textarea`).focus();
    await page.keyboard.type('a draft never sent');
    await page.evaluate(() => document.activeElement?.blur());
    // OpenCode starts again by resuming its session, as its plugin reports one.
    await qa({ sessions: [[ocPane, 'ses_relaunch']] });
    await page.waitForFunction(() => !window.qa.sessions.length, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    // The process exits and the pane starts again: a new launch, its input empty.
    await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: `pty-exit:${id}`, payload: 0 }), ocPane);
    const back = await cli('restart', ocRef, '--yes');
    assert.equal(back.ok, true, JSON.stringify(back));
    await page.waitForTimeout(300);
    await agent(ocPane, { busy: false, input: '' });
    const g2 = await gen();
    assert.ok(g2 > g1, `A new launch: ${g1} -> ${g2}`);
    // An Enter with nothing typed in this launch, then a run nobody's Enter sent.
    await typeIn(ocPane, '');
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'A draft from the last launch qualifies no Enter in this one');
    // Again, a prompt loomctl typed and entered after the empty Enter: no task either.
    await typeIn(ocPane, '');
    assert.equal((await untracked(ocRef, 'opencode loomctl after a relaunch')).ok, true);
    await startTurn('opencode', ocPane, '');
    await endTurn('opencode', ocPane, '');
    await page.waitForTimeout(800);
    assert.deepEqual(await newTasks(before), [], 'Nor a loomctl turn');
    // Typed in this launch: tracked, on this launch.
    await typeIn(ocPane, 'typed in the new launch');
    await startTurn('opencode', ocPane, '');
    const [t] = await waitNew(before);
    assert.deepEqual([t?.source, t?.generation], ['manual', g2], JSON.stringify(t));
    await endTurn('opencode', ocPane, '');
    await until(t.task, 'completed');
    ok('Typing evidence is the launch\'s that got it: a relaunch clears it, an empty Enter after claims no run, typing in the new launch is tracked');
  }

  // A person's prompt during a tracked submit's turn: two tasks, one each, one Stop ends both; repeated idle adds nothing.
  {
    await agent(claude, { busy: false, input: '' });
    const before = await taskIds();
    const s = await cli('submit', 'work:1', 'tracked overlap task');
    await startTurn('claude', claude, 'tracked overlap task');
    await until(s.text, 'working');
    await typeIn(claude, 'typed during the turn');
    await report(claude, { kind: 'start', match: promptMatch('typed during the turn') });
    const made = await waitNew(before, 2);
    assert.deepEqual(made.map((t) => t.source).sort(), ['manual', 'submit'], 'Exactly two tasks: no double count');
    const m = made.find((t) => t.source === 'manual');
    assert.equal((await until(m.task, 'working')).correlation, 'prompt');
    await endTurn('claude', claude, 'tracked overlap task', 'Both done.');
    await until(s.text, 'completed');
    await until(m.task, 'completed');
    const events = async () => (await cli('watch', '--after', '0')).data.events.filter((e) => e.task === s.text || e.task === m.task).length;
    const count = await events();
    for (let i = 0; i < 2; i++) await endTurn('claude', claude, 'tracked overlap task', 'Both done.');
    await page.waitForTimeout(1200);
    assert.deepEqual([await events(), (await newTasks(before)).length], [count, 2], 'Repeated idle reports: no event, no task');
    ok('A typed prompt during a tracked submit is its own task, one Stop completes both, and repeated idle reports add nothing');
  }

  // The same words in two turns are two tasks, each completed once; Codex the same.
  {
    for (const provider of ['claude', 'codex']) {
      const pane = await paneOf(provider);
      if (provider === 'codex') await agent(pane, { codexShape: true });
      const before = await taskIds();
      for (let turn = 0; turn < 2; turn++) {
        await agent(pane, { busy: false, input: '' });
        const was = await taskIds();
        await typeIn(pane, 'the same words');
        await startTurn(provider, pane, 'the same words');
        const [t] = await waitNew(was);
        assert.ok(t, `${provider} turn ${turn + 1} has a task`);
        await endTurn(provider, pane, 'the same words');
        await until(t.task, 'completed');
      }
      const made = await newTasks(before);
      assert.equal(made.length, 2, `${provider}: two turns, two tasks`);
      for (const t of made) assert.equal(t.events.filter((e) => e.state === 'completed').length, 1, 'Each completed once');
      if (provider === 'codex') await agent(pane, { codexShape: false, input: '' });
    }
    ok('The same words typed in two turns are two tasks, each completed once (Claude and Codex)');
  }

  // Fast: the turn's reports come at once. Approval and failure of a person's own turn.
  {
    await agent(claude, { busy: false, input: '' });
    let before = await taskIds();
    await typeIn(claude, 'quick question');
    await agent(claude, { busy: false }); // done before Loom looks again
    await report(claude, { kind: 'start', match: promptMatch('quick question') }, { kind: 'stop', response: promptMatch('Quick answer.') });
    const [f] = await waitNew(before);
    const fast = await until(f.task, 'completed');
    assert.equal(fast.events.at(-1).response, promptMatch('Quick answer.'));
    await agent(claude, { busy: false, input: '' });
    before = await taskIds();
    await typeIn(claude, 'needs a permission');
    await startTurn('claude', claude, 'needs a permission');
    const [a] = await waitNew(before);
    await report(claude, { kind: 'approval', detail: 'Write' });
    await until(a.task, 'approval');
    const blocked = (await cli('watch', a.task, '--after', '0', '--metadata', '--policy')).data.events.at(-1);
    assert.deepEqual([blocked.state, blocked.source, blocked.notify], ['approval', 'manual', true]);
    await report(claude, { kind: 'resume' });
    await until(a.task, 'working');
    await report(claude, { kind: 'fail', detail: 'rate_limit' });
    assert.equal((await until(a.task, 'failed')).source, 'manual');
    await agent(claude, { busy: false });
    ok('A typed turn that completes at once, and one that asks then fails, keep their source and outcomes');
  }

  // Relaunch, generations and a Loom restart: an Enter belongs to the launch it went into.
  {
    await agent(claude, { busy: false, input: '' });
    let before = await taskIds();
    const g = (await cli('panes')).data.find((p) => p.id === claude).generation;
    await typeIn(claude, 'typed before a relaunch');
    assert.equal((await cli('restart', 'work:1', '--yes')).ok, true);
    await page.waitForTimeout(300);
    await agent(claude, { busy: false, input: '' });
    await report(claude, { kind: 'start', match: promptMatch('typed before a relaunch'), launch: g });
    await report(claude, { kind: 'start', match: promptMatch('typed before a relaunch') });
    await page.waitForTimeout(600);
    assert.deepEqual(await newTasks(before), [], "The old launch's report is stale, and the new launch never had that Enter");
    // A person's turn still open when Loom restarts ends unknown, its source kept.
    await typeIn(claude, 'open at a restart');
    await startTurn('claude', claude, 'open at a restart');
    const [t] = await waitNew(before);
    await page.waitForTimeout(300);
    await reboot();
    const after = await state(t.task);
    assert.deepEqual([after.state, after.reason, after.source], ['unknown', 'loom-restarted', 'manual'], JSON.stringify(after));
    ok("A relaunch strands an Enter's old launch, a stale report starts nothing, and a restart ends a typed turn unknown, still manual");
  }

  // The notification policy: every pane on by default; a pane's own on or off wins; kinds for every pane;
  // kept across restarts; turning off holds back what wasn't sent, and turning on again sends none of it.
  {
    const now = async () => (await cli('notify')).data;
    let policy = await now();
    assert.deepEqual([policy.all, policy.kinds, policy.newPanes, policy.panes.every((p) => p.notify === 'inherit' && p.finish && p.fail && p.blocked)],
      ['on', { finish: true, fail: true, blocked: true }, 'inherit', true], 'Default: every pane on, every kind, new panes inherit');
    const bell = (pane) => page.evaluate((id) => { const b = document.querySelector(`.pane[data-id="${id}"] .pane-head button.notify`); return b && { own: b.classList.contains('own'), off: b.classList.contains('off'), title: b.title }; }, pane);
    assert.deepEqual(await bell(claude), { own: false, off: false, title: 'Task notices on, like every pane. Click to change.' });
    // Review 2026-10-03 15:52 (P2): every argument is checked before anything changes, so a refused command leaves
    // the policy, each pane's own setting, the journal's policy history and the saved settings as they were.
    {
      const kept = async () => [JSON.stringify(await now()), await page.evaluate(() => [localStorage.getItem('qa-journal'), localStorage.getItem('qa-state')])];
      await page.waitForTimeout(700); // past save()'s 300 ms
      const before = await kept();
      for (const argv of [['--all', 'off', 'work:99'], ['--finish', 'off', 'work:1', 'maybe'], ['--new-panes', 'off', 'work:1', 'off', 'extra'],
        ['--all', 'off', '--fail', 'sometimes'], ['--blocked', 'off', '--new-panes', 'never'], ['--check', '1', '--all', 'off'], ['work:1', 'off', '--check', '1']]) {
        const r = await cli('notify', ...argv);
        assert.equal(r.ok, false, `notify ${argv.join(' ')} is refused: ${JSON.stringify(r)}`);
      }
      await page.waitForTimeout(700);
      assert.deepEqual(await kept(), before, 'A refused notify changes nothing');
    }
    /** A completed submit on `ref`, and what --metadata --policy says of its last event. */
    const finish = async (ref, text) => {
      const pane = (await cli('panes')).data.find((p) => p.ref === ref).id;
      await agent(pane, { busy: false, input: '' });
      const t = (await cli('submit', ref, text)).text;
      await report(pane, { kind: 'start', match: promptMatch(text) });
      await until(t, 'working');
      await stops(pane);
      await until(t, 'completed');
      return { task: t, meta: (await cli('watch', t, '--after', '0', '--metadata', '--policy')).data.events.at(-1) };
    };
    const base = (await cli('watch', '--after', '0')).data.last;
    // A reference relay, as docs/turn-tracking-and-notifications.md asks of the email bridge: queue a notice only for
    // notify: true, ask notify --check right before sending, and never queue again what it muted.
    const relay = { cursor: base, queued: [], sent: [], muted: [] };
    const ingest = async () => {
      const w = (await cli('watch', '--after', String(relay.cursor), '--metadata', '--policy')).data;
      for (const e of w.events) if (['completed', 'failed', 'approval'].includes(e.state)) (e.notify ? relay.queued : relay.muted).push(e.seq);
      relay.cursor = w.next;
    };
    const deliver = async () => {
      if (!relay.queued.length) return;
      const check = (await cli('notify', '--check', relay.queued.join(','))).data;
      for (const seq of relay.queued.splice(0)) (check[seq] === true ? relay.sent : relay.muted).push(seq);
    };
    const a = await finish('work:1', 'notice A, pane on');
    assert.deepEqual([a.meta.notify, a.meta.source], [true, 'submit']);
    await ingest();
    assert.equal(relay.queued.length, 1, 'Queued, not sent yet');
    // Off for this pane, with A still queued: A must not go out.
    assert.equal((await cli('notify', 'work:1', 'off')).data.notify, 'off');
    assert.deepEqual(await bell(claude), { own: true, off: true, title: 'Task notices off for this pane. Click to change.' });
    await deliver();
    assert.deepEqual([relay.sent.length, relay.muted.includes(a.meta.seq)], [0, true], 'A queued notice of a pane turned off is not sent');
    const b = await finish('work:1', 'notice B, pane off');
    const other = await finish('work:3', 'notice on another pane');
    assert.deepEqual([b.meta.notify, other.meta.notify], [false, true], 'Off for one pane only');
    // On again: nothing it held back goes out, only what comes after.
    await cli('notify', 'work:1', 'inherit');
    assert.deepEqual(await bell(claude), { own: false, off: false, title: 'Task notices on, like every pane. Click to change.' });
    await ingest();
    await deliver();
    assert.deepEqual((await cli('notify', '--check', `${a.meta.seq},${b.meta.seq}`)).data, { [a.meta.seq]: false, [b.meta.seq]: false }, 'Still held back');
    assert.deepEqual([relay.sent, relay.muted.includes(b.meta.seq)], [[other.meta.seq], true], 'No flood of muted history');
    const c = await finish('work:1', 'notice C, pane on again');
    await ingest();
    await deliver();
    assert.equal(relay.sent.at(-1), c.meta.seq, 'Only what came after');
    // Every pane off, one pane on: the pane wins. Kinds apply to every pane.
    await cli('notify', '--all', 'off');
    await cli('notify', 'work:3', 'on');
    const [d1, d3] = [await finish('work:1', 'notice D1, every pane off'), await finish('work:3', 'notice D3, its own on')];
    assert.deepEqual([d1.meta.notify, d3.meta.notify], [false, true], 'A pane on wins over every pane off');
    assert.deepEqual(await bell(claude), { own: false, off: true, title: 'Task notices off, like every pane. Click to change.' });
    await cli('notify', '--all', 'on', '--fail', 'off');
    await cli('notify', 'work:3', 'inherit');
    await agent(claude, { busy: false, input: '' });
    const f = (await cli('submit', 'work:1', 'notice F, fails')).text;
    await report(claude, { kind: 'start', match: promptMatch('notice F, fails') });
    await until(f, 'working');
    await report(claude, { kind: 'fail', detail: 'rate_limit' });
    await until(f, 'failed');
    await agent(claude, { busy: false });
    const fm = (await cli('watch', f, '--after', '0', '--metadata', '--policy')).data.events.at(-1);
    const g = await finish('work:1', 'notice G, finishes');
    assert.deepEqual([fm.state, fm.notify, g.meta.notify], ['failed', false, true], 'Fail off, finish on');
    // Review 2026-10-03 15:52 (P1): a v2 reader can't see the policy and would send every outcome, so a range
    // holding one the policy holds back is refused whole, saying why; never a v2 answer with the muted notice in it.
    const v2 = await cli('watch', '--after', String(base), '--metadata');
    assert.deepEqual([v2.ok, /holds back/.test(v2.error), /loom-durable-events-v3/.test(v2.error)], [false, true, true], JSON.stringify(v2));
    const v2f = await cli('watch', f, '--after', '0', '--metadata');
    assert.equal(v2f.ok, false, 'Nor the muted task alone');
    // Where every notice may go out, v2 reads as before: seven fields.
    const v2g = (await cli('watch', g.task, '--after', '0', '--metadata')).data;
    assert.deepEqual([v2g.source, v2g.events.at(-1).state, v2g.events.every((e) => Object.keys(e).sort().join() === 'at,generation,pane,response,seq,state,task')], ['loom-durable-events-v2', 'completed', true]);
    // New panes start as set: off, then like every pane again.
    await cli('notify', '--new-panes', 'off');
    const fresh = (await call('add', ['work', '--cmd=claude'])).data.id;
    await page.waitForTimeout(300);
    assert.deepEqual([(await cli('panes')).data.find((p) => p.id === fresh).notify, (await bell(fresh)).off], ['off', true], 'A new pane starts off');
    const freshRef = (await cli('panes')).data.find((p) => p.id === fresh).ref;
    await page.waitForTimeout(500);
    assert.equal((await finish(freshRef, 'a new pane, off')).meta.notify, false);
    await cli('notify', '--new-panes', 'inherit');
    const fresh2 = (await call('add', ['work', '--cmd=claude'])).data.id;
    assert.equal((await cli('panes')).data.find((p) => p.id === fresh2).notify, 'inherit');
    // Kept across a Loom restart: every setting, each pane's own, and every event's decision.
    await cli('notify', 'work:1', 'off');
    await cli('notify', '--new-panes', 'on', '--blocked', 'off');
    // Every pane off, one on, with a notice of its own not sent yet: the restart renames its pane, never mutes it.
    await cli('notify', '--all', 'off');
    await cli('notify', 'work:3', 'on');
    const own = await finish('work:3', 'its own on, across a restart');
    assert.equal(own.meta.notify, true);
    // Review 2026-10-03 15:52 (P2): off, on, off again with no event between: three changes at one number. The
    // journal's replay keeps all three, so the notice after them stays held back across the restart.
    await cli('notify', 'work:1', 'on');
    await cli('notify', 'work:1', 'off');
    const late = await finish('work:1', 'muted after on and off again');
    assert.equal(late.meta.notify, false);
    const decided = (await cli('watch', '--after', String(base), '--metadata', '--policy')).data;
    await page.waitForTimeout(700); // past save()'s 300 ms
    await page.evaluate(() => localStorage.setItem('qa-use-state', '1'));
    await reboot();
    policy = await now();
    const w1 = policy.panes.find((p) => p.ref === 'work:1');
    assert.deepEqual([policy.all, policy.kinds, policy.newPanes, w1.notify, policy.panes.find((p) => p.ref === 'work:3').notify],
      ['off', { finish: true, fail: false, blocked: false }, 'on', 'off', 'on'], JSON.stringify(policy));
    assert.equal((await cli('notify', '--check', String(own.meta.seq))).data[own.meta.seq], true, 'Its own on still lets its unsent notice go');
    assert.equal((await cli('notify', '--check', String(late.meta.seq))).data[late.meta.seq], false, 'Off, on, off again at one number: still off after the restart');
    assert.equal((await bell(claude)).off, true, 'Its bell still says off');
    const again = (await cli('watch', '--after', String(base), '--metadata', '--policy')).data;
    assert.deepEqual(again.events.filter((e) => e.seq <= decided.last).map((e) => [e.seq, e.notify]), decided.events.map((e) => [e.seq, e.notify]), 'Every decision survives the restart');
    assert.equal((await finish('work:1', 'after the restart, still off')).meta.notify, false);
    await page.evaluate(() => localStorage.removeItem('qa-use-state'));
    ok('Notification policy: default on, a pane\'s own setting wins, kinds filter, queued notices of a muted pane stay unsent, re-enabling sends no history, new panes start as set, a refused notify changes nothing, v2 is refused over a muted notice, and it all survives a restart');
  }

  }
  assert.deepEqual(errors, []);
  console.log(`submit round trips (ms): ${timing.join(', ')}`);
  console.log(`\nall ${checks} task checks passed`);
} finally {
  await browser.close();
}
