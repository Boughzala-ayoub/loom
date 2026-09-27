// Run against a built native bundle. Only temporary profiles and test PTYs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const dir = mkdtempSync(join(tmpdir(), 'loom-close-check-'));
const profile = join(dir, 'workspace.json');
writeFileSync(profile, '{}');
// Make slow Windows process cleanup deterministic, then run the real taskkill.
const helper = join(dir, 'taskkill.rs');
writeFileSync(helper, `use std::os::windows::process::CommandExt;
fn main() {
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let status = std::process::Command::new(std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/taskkill.exe"))
        .args(std::env::args_os().skip(1)).creation_flags(0x08000000).status().unwrap();
    std::process::exit(status.code().unwrap_or(1));
}`);
const compiled = spawnSync('rustc', [helper, '-o', join(dir, 'taskkill.exe')], { windowsHide: true, encoding: 'utf8' });
assert.equal(compiled.status, 0, String(compiled.error || compiled.stderr));
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [profile], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, Path: dir + ';' + process.env.Path,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
let exited = false;
const exit = new Promise(r => child.once('exit', code => { exited = true; r(code); }));
let browser;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200 && !exited; i++) {
    ready = await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const bundle = readFileSync('dist/index.html', 'utf8').match(/src="([^"]*\/main-[^"]+\.js)"/)[1];
  assert.equal(await page.locator('script[type="module"][src]').first().getAttribute('src'), bundle, 'The native app must embed the current frontend bundle');
  await page.evaluate(async ({ node, cwd }) => {
    const { invoke, Channel } = window.__TAURI__.core;
    await window.__TAURI__.event.listen('pty-exit:exited-test', () => window.testPtyExited = true);
    for (const id of ['close-test', 'sibling-test', 'exited-test']) {
      const out = new Channel();
      // ConPTY requests the inherited cursor position, including at shutdown.
      out.onmessage = data => {
        if (id === 'exited-test') window.exitedOutput = (window.exitedOutput || '') + data;
        if (data.includes('\x1b[6n')) void invoke('pty_write', { id, data: '\x1b[1;1R' }).catch(() => {});
      };
      await invoke('pty_spawn', { id, cwd, argv: [node, '-e', id === 'exited-test' ? 'process.stdout.write("EXIT-DRAIN-MARKER\\n", () => process.exit(1))' : 'setInterval(() => {}, 1000)'], cols: 80, rows: 24, onOut: out });
      await invoke('pty_write', { id, data: '\x1b[1;1R' });
    }
  }, { node: process.execPath, cwd: dir });
  await page.waitForFunction(() => window.testPtyExited);
  await page.waitForFunction(() => window.exitedOutput?.includes('EXIT-DRAIN-MARKER'));
  await pause(2000);
  const hosts = () => JSON.parse(spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `@((Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}") | Where-Object { $_.Name -in @('OpenConsole.exe', 'conhost.exe') } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { @{ id = $p.Id; cpu = $p.CPU } } }) | ConvertTo-Json -Compress`],
    { windowsHide: true, encoding: 'utf8' }).stdout.trim() || '[]');
  const before = [].concat(hosts());
  await pause(2000);
  const after = [].concat(hosts());
  console.log('Native console hosts:', JSON.stringify(after.map(p => ({ id: p.id, cpuSeconds: p.cpu - (before.find(b => b.id === p.id)?.cpu ?? p.cpu) }))));
  assert.equal(after.length, 2, 'Natural process exit must release its console host without closing the pane');
  const result = await Promise.race([page.evaluate(async () => {
    const { invoke } = window.__TAURI__.core;
    const results = [];
    for (const id of ['close-test', 'exited-test']) {
      let killed = false;
      const kill = invoke('pty_kill', { id }).then(() => killed = true);
      await new Promise(r => setTimeout(r, 100));
      const start = performance.now();
      await window.__TAURI__.window.getCurrentWindow().innerSize();
      await invoke('pty_resize', { id: 'sibling-test', cols: 90, rows: 25 });
      results.push({ elapsed: performance.now() - start, killed });
      await kill;
    }
    return { elapsed: Math.max(...results.map(r => r.elapsed)), killed: results[0].killed };
  }), pause(12000).then(() => { throw new Error('Pane close did not finish within 12 seconds'); })]);
  assert.equal(result.killed, false, 'The window and sibling PTY must respond while slow pane cleanup is still running');
  assert.ok(result.elapsed < 600, `Cleanup blocked the window/PTY map for ${result.elapsed.toFixed(0)} ms`);
  console.log(`PASS running/exited pane close: window and sibling resize respond in ${result.elapsed.toFixed(0)} ms during 1500 ms cleanup`);
  await page.evaluate(async ({ node, cwd }) => {
    const { invoke, Channel } = window.__TAURI__.core;
    window.replacedExited = false;
    const unlisten = await window.__TAURI__.event.listen('pty-exit:replacement-test', () => window.replacedExited = true);
    for (let i = 0; i < 2; i++) {
      const out = new Channel();
      out.onmessage = data => { if (data.includes('\x1b[6n')) void invoke('pty_write', { id: 'replacement-test', data: '\x1b[1;1R' }).catch(() => {}); };
      await invoke('pty_spawn', { id: 'replacement-test', cwd, argv: [node, '-e', 'setInterval(() => {}, 1000)'], cols: 80, rows: 24, onOut: out });
      await invoke('pty_write', { id: 'replacement-test', data: '\x1b[1;1R' });
    }
    await new Promise(r => setTimeout(r, 100));
    await invoke('pty_resize', { id: 'replacement-test', cols: 90, rows: 25 });
    unlisten();
    await invoke('pty_kill', { id: 'replacement-test' });
  }, { node: process.execPath, cwd: dir });
  assert.equal(await page.evaluate(() => window.replacedExited), false, 'An old process waiter must not remove or mark its replacement dead');
  // A process that never reads stdin must not freeze the window or other panes.
  const paste = page.evaluate(() => window.__TAURI__.core.invoke('pty_write', { id: 'sibling-test', data: ('x'.repeat(1000) + '\r').repeat(2000) }).catch(() => {})).catch(() => {});
  await pause(300);
  const windowResponse = await Promise.race([
    page.evaluate(() => window.__TAURI__.window.getCurrentWindow().innerSize()).then(() => true),
    pause(2000).then(() => false),
  ]);
  assert.ok(windowResponse, 'A blocked terminal input write must not block the window event loop');
  console.log('PASS window responds while a 2 MB input write is blocked');
  await page.evaluate(() => window.__TAURI__.event.emitTo('main', 'tauri://close-requested'));
  await pause(100);
  const responsive = await page.evaluate(async () => {
    const start = performance.now();
    await window.__TAURI__.window.getCurrentWindow().innerSize();
    return performance.now() - start;
  });
  assert.ok(responsive < 600, `App shutdown blocked the window for ${responsive.toFixed(0)} ms`);
  assert.equal(await Promise.race([exit, pause(15000).then(() => 'timeout')]), 0, 'Window close must finish');
  console.log('PASS app shutdown remains responsive while cleaning up the remaining PTY');
  assert.equal([].concat(hosts()).length, 0, 'App shutdown must release every console host it created');
  await paste;
} finally {
  if (!exited) {
    spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    await Promise.race([exit, pause(2000)]);
  }
  if (browser) await Promise.race([browser.close().catch(() => {}), pause(2000)]);
}
