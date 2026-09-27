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
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_selected', status: { type: 'busy' } } } });
    assert.equal(readFileSync(wake, 'utf8'), 'opencode:busy');
    unlinkSync(wake);
    await plugin.event({ event: { type, properties: { sessionID: 'ses_selected' } } });
    assert.ok(existsSync(wake), `${type} must drop the wake marker`);
    assert.equal(readFileSync(wake, 'utf8'), 'opencode:waiting');
    unlinkSync(wake);
  }
  await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'ses_selected' } } });
  assert.equal(readFileSync(wake, 'utf8'), 'opencode:busy', 'an answer restores Working rather than ringing');
  unlinkSync(wake);
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  assert.ok(!existsSync(wake), 'a child finishing must not change the parent state');
  console.log('PASS per-pane Codex markers, exact resume, ephemeral/guardian rejection, OpenCode selection, subagent isolation and OpenCode wakes');
} finally {
  for (const suffix of ['0', '1', 'oc']) if (existsSync(marker(pane + suffix))) unlinkSync(marker(pane + suffix));
  rmSync(codexHome, { recursive: true, force: true });
}
