// No API calls. Exercises provider hooks and the launcher with two panes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from '../src/agent.ts';
import { Loom } from '../src-tauri/src/loom-opencode.js';

const pane = `loom-check-${Date.now()}`;
const marker = name => join(tmpdir(), 'loom-session-check', name + '.session');
const codexHome = mkdtempSync(join(tmpdir(), 'loom-codex-check-'));
const sessions = join(codexHome, 'sessions', '2026', '09', '12');
mkdirSync(sessions, { recursive: true });
const rollout = (id, source) => writeFileSync(join(sessions, `rollout-test-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, source } }) + '\n');
// Codex's notify program is loom.exe itself: build it first (cargo build), or
// point LOOM_EXE at another one.
const loomExe = process.env.LOOM_EXE || resolve('src-tauri/target/debug/loom.exe');
const notify = (name, id) => {
  const run = spawnSync(loomExe, ['--codex-notify', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id })], {
    env: { ...process.env, CODEX_HOME: codexHome, LOOM_PANE: name, LOOM_SESSION_FILE: marker(name) },
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, String(run.error || run.stderr));
};
try {
  const ids = ['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
  for (const [i, session_id] of ids.entries()) {
    const name = pane + i;
    rollout(session_id, 'cli');
    notify(name, session_id);
    assert.equal(readFileSync(marker(name), 'utf8'), session_id);
    assert.ok(launch('codex', 'placeholder', true, undefined, session_id).at(-1).includes(`resume ${session_id}`));
  }
  notify(pane + '0', 'ephemeral-child');
  assert.equal(readFileSync(marker(pane + '0'), 'utf8'), ids[0], 'An unsaved internal thread must not replace the resumable session');
  rollout('guardian-child', { subagent: { other: 'guardian' } });
  notify(pane + '0', 'guardian-child');
  assert.equal(readFileSync(marker(pane + '0'), 'utf8'), ids[0], 'A persisted subagent must not replace the pane session');
  process.env.LOOM_PANE = pane + 'oc';
  process.env.LOOM_SESSION_FILE = marker(process.env.LOOM_PANE);
  const plugin = await Loom({ client: { session: { get: async () => ({ data: {} }) } } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_first' } } } });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_first');
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_first' } } } });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_first');
  await plugin['chat.message']({ sessionID: 'ses_selected' });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_selected');
  // A question or permission prompt blocks mid-turn: it must ring like session.idle.
  const wake = join(tmpdir(), 'loom-wait', process.env.LOOM_PANE);
  for (const type of ['session.idle', 'question.asked', 'permission.asked']) {
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_selected' } } });
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_selected', status: { type: 'busy' } } } });
    assert.equal(readFileSync(wake, 'utf8'), 'opencode:busy');
    unlinkSync(wake);
    await plugin.event({ event: { type, properties: { sessionID: 'ses_selected' } } });
    assert.ok(existsSync(wake), `${type} must drop the wake marker`);
    assert.equal(readFileSync(wake, 'utf8'), 'opencode:waiting');
    unlinkSync(wake);
  }
  await plugin.event({ event: { type: 'permission.replied', properties: { sessionID: 'ses_selected' } } });
  assert.equal(readFileSync(wake, 'utf8'), 'opencode:busy', 'an answer restores Working rather than ringing');
  unlinkSync(wake);
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  assert.ok(!existsSync(wake), 'a child finishing must not change the parent state');
  console.log('PASS per-pane Codex markers, exact resume, ephemeral/guardian rejection, OpenCode selection, subagent isolation and OpenCode wakes');
  // Claude's SessionStart hook (claude-hooks.json): which transcript the pane is on, the exact path
  // with no newline. Nothing outside a Loom pane, for bad JSON, or without a path; always exit 0.
  const tx = name => join(tmpdir(), 'loom-tx', name);
  const start = (name, input) => {
    const env = { ...process.env, LOOM_PANE: name };
    if (!name) delete env.LOOM_PANE;
    const run = spawnSync(loomExe, ['--session-start'], { env, input, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, String(run.error || run.stderr));
  };
  for (const path of ['C:\\Users\\a b\\.claude\\projects\\p\\s.jsonl', 'C:\\Users\\Zoé\\.claude\\projects\\p\\s.jsonl']) {
    start(pane + 'tx', JSON.stringify({ session_id: 's', transcript_path: path, hook_event_name: 'SessionStart' }));
    assert.equal(readFileSync(tx(pane + 'tx'), 'utf8'), path);
  }
  for (const [i, input] of ['{not json', '{"session_id":"s"}', '{"transcript_path":""}'].entries()) {
    start(pane + 'tx' + i, input);
    assert.ok(!existsSync(tx(pane + 'tx' + i)), `No marker for ${input}`);
  }
  start('', JSON.stringify({ transcript_path: 'C:\\x.jsonl' }));
  console.log('PASS Claude SessionStart marker, including a non-ASCII path, and nothing for a bad payload');
} finally {
  for (const suffix of ['0', '1', 'oc']) if (existsSync(marker(pane + suffix))) unlinkSync(marker(pane + suffix));
  for (const name of ['tx', 'tx0', 'tx1', 'tx2']) rmSync(join(tmpdir(), 'loom-tx', pane + name), { force: true });
  rmSync(codexHome, { recursive: true, force: true });
}
