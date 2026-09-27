// node scripts/codex-lock-check.mjs, against a built native Loom bundle.
// Only synthetic credentials/transcripts and temporary databases are used.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { launch } from '../src/agent.ts';

const dir = mkdtempSync(join(tmpdir(), 'loom-codex-lock-'));
const home = join(dir, 'codex home');
mkdirSync(home);
const profile = join(dir, 'workspace.json');
const stateIds = [randomUUID(), randomUUID()];
const sessionId = randomUUID();
const sessions = join(home, 'sessions', '2026', '09', '20');
mkdirSync(sessions, { recursive: true });
writeFileSync(join(sessions, `rollout-2026-09-20T12-00-00-${sessionId}.jsonl`), [
  { type: 'session_meta', payload: { id: sessionId, timestamp: '2026-09-20T12:00:00Z', cwd: dir, originator: 'codex_cli_rs', cli_version: '0.155.1', source: 'cli', model_provider: 'openai' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Saved conversation lock regression' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Saved conversation lock regression', images: [], local_images: [], text_elements: [] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Resume marker preserved.' }] } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'Resume marker preserved.', phase: 'final_answer' } },
].map(row => JSON.stringify({ timestamp: '2026-09-20T12:00:00Z', ...row })).join('\n') + '\n');
writeFileSync(profile, '{}');
writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-key' }));
writeFileSync(join(home, 'config.toml'), `model = "gpt-5.6-terra"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
openai_base_url = "http://127.0.0.1:1/v1"
[projects.${JSON.stringify(dir)}]
trust_level = "trusted"
`);
const lock = spawn('python', ['-u', '-c', `import sqlite3, sys
c = sqlite3.connect(sys.argv[2])
c.execute('CREATE TABLE loom_seed_probe (value INTEGER)')
c.execute('INSERT INTO loom_seed_probe VALUES (42)')
c.commit()
c.close()
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)')
c.commit()
c.execute('BEGIN IMMEDIATE')
print('locked', flush=True)
sys.stdin.read()
`, join(home, 'logs_2.sqlite'), join(home, 'state_5.sqlite')], { windowsHide: true });
await new Promise((ok, fail) => {
  lock.once('error', fail);
  lock.stdout.once('data', ok);
  lock.once('exit', code => fail(new Error(`Lock helper exited: ${code}`)));
});
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [profile], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
let browser;
let stateRoot;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    ready = await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => !!window.__TAURI__?.core);
  stateRoot = join(await page.evaluate(() => window.__TAURI__.path.appDataDir()), 'codex-sqlite');
  await page.evaluate(async ({ cwd, panes }) => {
    const { invoke, Channel } = window.__TAURI__.core;
    window.codexResults = {};
    await Promise.all(panes.map(async ({ id, argv }) => {
      const result = window.codexResults[id] = { output: '', code: null };
      await window.__TAURI__.event.listen(`pty-exit:${id}`, e => result.code = e.payload);
      const out = new Channel();
      out.onmessage = data => {
        void invoke('pty_ack', { channel: out.id });
        result.output += data;
        if (data.includes('\x1b[6n')) void invoke('pty_write', { id, data: '\x1b[1;1R' }).catch(() => {});
        if (!result.promotionHandled && /Use\s*existing\s*model/.test(result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))) {
          result.promotionHandled = true;
          setTimeout(() => void invoke('pty_write', { id, data: '\x1b[B\r' }), 100);
        }
      };
      await invoke('pty_spawn', { id, cwd, argv, codexStateId: id, cols: 120, rows: 35, onOut: out });
      await invoke('pty_write', { id, data: '\x1b[1;1R' });
    }));
  }, { cwd: dir, panes: stateIds.map((id, index) => ({ id, argv: launch('codex', id, index === 1, undefined, index === 1 ? sessionId : undefined) })) });
  await pause(12000);
  const results = await page.evaluate(() => window.codexResults);
  for (const id of stateIds) {
    const result = results[id];
    const output = result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.doesNotMatch(output, /database is locked|couldn't start because another Codex process/,
      'Codex must start even while the shared logs database has a writer lock');
    assert.equal(result.code, null, `Codex must remain running: ${output.slice(-3000)}`);
    assert.match(output, /gpt-5\.6-terra/i, `Codex must finish loading its model: ${output.slice(-3000)}`);
    assert.ok(existsSync(join(stateRoot, id, 'logs_2.sqlite')), 'Each pane must have its own log database');
    const seeded = spawnSync('python', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT value FROM loom_seed_probe").fetchone() == (42,)', join(stateRoot, id, 'state_5.sqlite')], { windowsHide: true, encoding: 'utf8' });
    assert.equal(seeded.status, 0, `A new pane must reuse the session index without sharing its database: ${seeded.stderr}`);
  }
  assert.match(results[stateIds[1]].output, /Resume marker preserved/, 'Resume must read the existing CODEX_HOME transcript');
  console.log('PASS fresh/resumed Codex panes seed private indexes while shared logs_2.sqlite is locked; saved conversation preserved');
} finally {
  lock.stdin.end();
  if (browser) await browser.contexts()[0].pages()[0].evaluate(() => window.__TAURI__.core.invoke('pty_shutdown')).catch(() => {});
  spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  if (browser) await Promise.race([browser.close().catch(() => {}), pause(2000)]);
  // Only the random IDs generated by this test, below Loom's state root.
  if (stateRoot) for (const id of stateIds) rmSync(join(stateRoot, id), { recursive: true, force: true });
}
