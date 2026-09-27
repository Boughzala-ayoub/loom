// Diagnostic: real Codex account lookup, no Loom, model prompt, or agent thread.
// Uses the existing login but prints no account details or credentials.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const exe = process.env.CODEX_TEST_EXE || join(process.env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
if (!existsSync(exe)) throw new Error('Set CODEX_TEST_EXE to the installed native codex.exe');
const cache = resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'codex-account-check-'));
const child = spawn(exe, ['app-server'], {
  windowsHide: true, env: { ...process.env, CODEX_SQLITE_HOME: dir },
});
const started = performance.now();
let requested, complete = false;
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
const timeout = setTimeout(() => {
  console.log('FAIL: account/read did not complete within 45 seconds');
  process.exitCode = 1;
  child.kill();
}, 45000);
child.stderr.resume(); // Never print raw logs, which can include account data.
child.stdin.on('error', () => {}); // The exit handler reports an early process exit.
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1 && message.result) {
    console.log(`Initialized in ${Math.round(performance.now() - started)} ms`);
    send({ method: 'initialized', params: {} });
    requested = performance.now();
    send({ id: 2, method: 'account/read', params: { refreshToken: false } });
  }
  if (message.id === 2) {
    complete = true;
    const routingTimeout = message.error?.message === 'workspace routing discovery timed out';
    console.log(JSON.stringify({ accountMs: Math.round(performance.now() - requested),
      ok: !message.error, code: message.error?.code,
      ...(message.error ? { error: routingTimeout ? message.error.message : 'Account lookup failed; details omitted' } : {}),
    }));
    process.exitCode = message.error ? 1 : 0;
    clearTimeout(timeout);
    child.kill();
  }
});
child.on('error', () => { process.exitCode = 1; });
child.on('close', () => {
  clearTimeout(timeout);
  if (!complete) { console.log('FAIL: Codex exited before account/read completed'); process.exitCode = 1; }
  // Only remove this invocation's temporary database directory.
  if (dirname(dir) === cache && basename(dir).startsWith('codex-account-check-'))
    rmSync(dir, { recursive: true, force: true });
});
send({ id: 1, method: 'initialize', params: {
  clientInfo: { name: 'loom_account_probe', version: '1' }, capabilities: { experimentalApi: true },
} });
