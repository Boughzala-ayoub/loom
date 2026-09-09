// No API calls. Exercises provider hooks and the launcher with two panes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from '../src/agent.ts';
import { Loom } from '../src-tauri/src/loom-opencode.js';

const pane = `loom-check-${Date.now()}`;
const marker = name => join(tmpdir(), 'loom-session-check', name + '.session');
try {
  const ids = ['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
  for (const [i, session_id] of ids.entries()) {
    const name = pane + i;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('& $env:LOOM_SESSION_HOOK $env:LOOM_SESSION_EVENT', 'utf16le').toString('base64')], {
      env: { ...process.env, LOOM_PANE: name, LOOM_SESSION_FILE: marker(name), LOOM_SESSION_HOOK: resolve('src-tauri/src/loom-session.ps1'), LOOM_SESSION_EVENT: JSON.stringify({ type: 'agent-turn-complete', 'thread-id': session_id }) },
      windowsHide: true, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(marker(name), 'utf8'), session_id);
    assert.ok(launch('codex', 'placeholder', true, undefined, session_id).at(-1).includes(`resume ${session_id}`));
  }
  process.env.LOOM_PANE = pane + 'oc';
  process.env.LOOM_SESSION_FILE = marker(process.env.LOOM_PANE);
  const plugin = await Loom({ client: { session: { get: async () => ({ data: {} }) } } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_first' } } } });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_first');
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_first' } } } });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_first');
  await plugin['chat.message']({ sessionID: 'ses_selected' });
  assert.equal(readFileSync(marker(process.env.LOOM_PANE), 'utf8'), 'ses_selected');
  console.log('PASS per-pane Codex markers, exact resume, OpenCode selection and subagent isolation');
} finally {
  for (const suffix of ['0', '1', 'oc']) if (existsSync(marker(pane + suffix))) unlinkSync(marker(pane + suffix));
}
