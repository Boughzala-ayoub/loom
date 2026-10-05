// Smoke test the installed CLIs in isolated homes. Creates empty sessions, no model calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const root = mkdtempSync(join(resolve('node_modules/.cache'), 'opencode-cli-check-'));
const npm = join(process.env.APPDATA, 'npm/node_modules');
const exes = [process.env.OPENCODE_V1_EXE || join(npm, 'opencode-ai/bin/opencode.exe'), process.env.OPENCODE_V2_EXE || join(npm, '@opencode/cli/bin/opencode.exe')];
for (const [index, exe] of exes.entries()) {
  const version = index + 1;
  if (process.env.OPENCODE_CHECK_VERSION && Number(process.env.OPENCODE_CHECK_VERSION) !== version) continue;
  assert.ok(existsSync(exe), `Set OPENCODE_V${version}_EXE to an installed CLI`);
  const dir = join(root, `v${version}`);
  mkdirSync(join(dir, 'config/opencode/plugins'), { recursive: true });
  copyFileSync('src-tauri/src/loom-opencode.js', join(dir, 'config/opencode/plugins/loom.js'));
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'), LOOM_PANE: `opencode-real-${process.pid}-${version}`, LOOM_SESSION_FILE: join(dir, 'selected') };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_CONFIG_DIR;
  if (version === 2) env.OPENCODE_PASSWORD = crypto.randomUUID();
  if (version === 2) writeFileSync(join(dir, 'config/opencode/plugins/lookup-probe.js'), `
    import fs from 'node:fs';
    export default { id: 'loom-test-lookup', setup(ctx) {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type !== 'session.created') continue;
            const session = await ctx.session.get({ sessionID: event.data.sessionID });
            fs.writeFileSync(${JSON.stringify(join(dir, 'lookup.json'))}, JSON.stringify(session));
          }
        } catch {}
      })();
      return () => controller.abort();
    } };
  `);
  const run = (args, pane = false) => {
    const clean = { ...env };
    if (!pane) { delete clean.LOOM_PANE; delete clean.LOOM_SESSION_FILE; }
    const result = spawnSync(exe, args, { cwd: dir, env: clean, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 << 20 });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error || result.stderr}`);
    return result.stdout;
  };
  console.log(`OpenCode ${run(['--version']).trim()}`);
  let server, sid;
  try {
    if (version === 2) {
      server = spawn(exe, ['serve', '--stdio', '--port', '0'], { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const url = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('V2 server startup timed out')), 45000);
        let text = '';
        server.stdout.on('data', chunk => {
          text += chunk;
          if (!text.includes('\n')) return;
          clearTimeout(timeout);
          try { resolve(JSON.parse(text.split('\n')[0]).url); } catch (error) { reject(error); }
        });
        server.on('error', reject);
      });
      const plugins = JSON.parse(run(['api', 'plugin.list', '--server', url]));
      assert.ok(JSON.stringify(plugins).includes('loom'), 'V2 lists the actual Loom plugin');
      sid = JSON.parse(run(['api', 'session.create', '--server', url, '--data', JSON.stringify({ location: { directory: dir } })])).data.id;
    } else {
      const socket = createServer();
      await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      server = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: dir, env, windowsHide: true, stdio: 'ignore' });
      let response;
      for (let i = 0; i < 150; i++) {
        response = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': dir }, body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (response?.ok) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(response?.ok, 'V1 server creates a session');
      sid = (await response.json()).id;
    }
    assert.ok(sid);
    for (let i = 0; i < 30 && !existsSync(env.LOOM_SESSION_FILE); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(env.LOOM_SESSION_FILE, 'utf8').split('\n')[0], sid, `V${version} really loads the plugin and captures session.created`);
    if (version === 2) {
      for (let i = 0; i < 30 && !existsSync(join(dir, 'lookup.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(JSON.parse(readFileSync(join(dir, 'lookup.json'), 'utf8')).id, sid, 'V2 plugin lookup returns the session directly');
    }
    const rows = JSON.parse(run(['session', 'list', '--format', 'json', ...(version === 2 ? ['--standalone'] : [])]));
    assert.ok(rows.some(r => r.id === sid && r.directory === dir), 'The real list format contains this directory and session');
    const data = JSON.parse(run(version === 2 ? ['session', 'export', sid, '--standalone'] : ['export', sid, '--pure']));
    assert.equal(data.info.id, sid);
    assert.ok(Array.isArray(data.messages));
    assert.equal(readFileSync(env.LOOM_SESSION_FILE, 'utf8').split('\n')[0], sid, 'Helper reads do not change the pane marker');
    console.log(`PASS OpenCode ${version}: actual plugin load, session capture, listing and export`);
  } finally {
    if (server?.pid) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const marker = join(tmpdir(), 'loom-wait', env.LOOM_PANE);
    if (existsSync(marker)) unlinkSync(marker);
  }
}
