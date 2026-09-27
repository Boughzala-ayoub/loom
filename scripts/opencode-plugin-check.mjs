// No model calls. Exercise both real plugin entrypoints and their marker files.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin, { Loom } from '../src-tauri/src/loom-opencode.js';

const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-plugin-'));
const previous = { pane: process.env.LOOM_PANE, session: process.env.LOOM_SESSION_FILE };
const pane = `opencode-check-${process.pid}`;
const marker = join(tmpdir(), 'loom-wait', pane);
const sessionFile = join(dir, 'session');
const read = () => existsSync(marker) ? readFileSync(marker, 'utf8') : '';
try {
  for (const version of [1, 2]) {
    process.env.LOOM_PANE = pane;
    process.env.LOOM_SESSION_FILE = sessionFile;
    if (existsSync(marker)) unlinkSync(marker);
    let hook, dispose, event, release, aborted = false;
    let gate;
    const lookup = async id => {
      if (gate) { const wait = gate; gate = undefined; await wait; }
      if (id === 'ses_missing') throw new Error('Session disappeared');
      return { id, ...(id === 'ses_child' ? { parentID: 'ses_main' } : {}) };
    };
    if (version === 1) {
      assert.equal(plugin.server, Loom);
      const hooks = await plugin.server({ client: { session: { get: async ({ path }) => ({ data: await lookup(path.id) }) } } });
      hook = hooks['chat.message']; dispose = hooks.dispose;
      event = (type, data) => hooks.event({ event: { type, properties: type === 'session.created' ? { info: { id: data.sessionID, parentID: data.parentID } } : data } });
    } else {
      const items = [];
      let wake;
      dispose = await plugin.setup({
        session: { get: ({ sessionID }) => lookup(sessionID), hook: async (name, fn) => { assert.equal(name, 'prompt'); hook = fn; } },
        event: { subscribe: async function* ({ signal }) {
          signal.addEventListener('abort', () => { aborted = true; wake?.(); });
          while (!signal.aborted) {
            if (!items.length) await new Promise(resolve => wake = resolve);
            if (signal.aborted) break;
            const { value, done } = items.shift();
            yield value;
            done();
          }
        } },
      });
      event = (type, data) => new Promise(done => { items.push({ value: { type, data }, done }); wake?.(); });
    }
    const status = (state, sessionID = 'ses_main') => version === 1
      ? event('session.status', { sessionID, status: { type: state } })
      : event(state === 'busy' ? 'session.execution.started' : state === 'retry' ? 'session.retry.scheduled' : 'session.execution.succeeded', { sessionID });
    await status('busy');
    assert.equal(read(), 'opencode:busy');
    assert.equal(readFileSync(sessionFile, 'utf8'), 'ses_main', 'Resume recovers the root session');
    await status('idle', 'ses_child');
    assert.equal(read(), 'opencode:busy', 'Child completion cannot finish the root');
    await event('session.created', { sessionID: 'ses_child', parentID: 'ses_main' });
    assert.equal(readFileSync(sessionFile, 'utf8'), 'ses_main');
    await event('permission.asked', { sessionID: 'ses_other', id: 'other' });
    assert.equal(read(), 'opencode:busy', 'An unrelated session cannot ring this pane');
    await event('permission.asked', { sessionID: 'ses_child', id: 'p1' });
    await event('permission.asked', { sessionID: 'ses_main', id: 'p2' });
    assert.equal(read(), 'opencode:waiting', 'A child approval needs the user too');
    await status('retry');
    assert.equal(read(), 'opencode:waiting', 'Busy cannot erase an unanswered approval');
    await event('permission.replied', { sessionID: 'ses_child', requestID: 'p1' });
    assert.equal(read(), 'opencode:waiting', 'Another approval is still pending');
    await event('permission.replied', { sessionID: 'ses_main', requestID: 'p2' });
    assert.equal(read(), 'opencode:busy');
    const ask = version === 1 ? 'question.asked' : 'form.created';
    const askData = { sessionID: 'ses_main', id: 'q1' };
    for (const reply of version === 1 ? ['question.replied', 'question.rejected'] : ['form.replied', 'form.cancelled']) {
      await event(ask, version === 1 ? askData : { form: askData });
      assert.equal(read(), 'opencode:waiting');
      await event(reply, version === 1 ? { sessionID: 'ses_main', requestID: 'q1' } : askData);
      assert.equal(read(), 'opencode:busy');
    }
    for (const end of version === 1 ? ['session.idle', 'session.error'] : ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']) {
      await event(end, { sessionID: 'ses_main' });
      assert.equal(read(), 'opencode:waiting');
      unlinkSync(marker);
      await event(end, { sessionID: 'ses_main' });
      assert.equal(read(), '', 'Repeated completion does not ring twice');
      await status('busy');
    }
    // Selection and event delivery share one queue, including failed lookups.
    await hook({ sessionID: 'ses_missing' });
    gate = new Promise(resolve => release = resolve);
    const selection = hook({ sessionID: 'ses_next' });
    const working = status('busy', 'ses_next');
    const finished = status('idle', 'ses_next');
    release(); await Promise.all([selection, working, finished]);
    assert.equal(readFileSync(sessionFile, 'utf8'), 'ses_next');
    assert.equal(read(), 'opencode:waiting');
    // Disposal must also stop in-flight lookups from writing stale markers.
    gate = new Promise(resolve => release = resolve);
    const late = hook({ sessionID: 'ses_late' });
    await new Promise(resolve => setTimeout(resolve, 0));
    dispose(); release(); await late;
    assert.equal(readFileSync(sessionFile, 'utf8'), 'ses_next');
    if (version === 2) assert.equal(aborted, true);
    delete process.env.LOOM_PANE;
    assert.equal(await plugin.setup({}), undefined, 'Outside Loom the V2 plugin is inert');
    const noLoom = await Loom({ client: {} });
    await noLoom.event({ event: { type: 'session.created', properties: { info: { id: 'ses_external' } } } });
    assert.equal(readFileSync(sessionFile, 'utf8'), 'ses_next');
    console.log(`PASS OpenCode ${version}: session identity, states, prompts, child isolation, event order, cleanup, no-op outside Loom`);
  }
} finally {
  if (existsSync(marker)) unlinkSync(marker);
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['LOOM_PANE', previous.pane], ['LOOM_SESSION_FILE', previous.session]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
