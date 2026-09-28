// node scripts/git-direct-check.mjs, against a built native Loom bundle. Read-only in your repos.
// The gate for git_direct in lib.rs, which runs Git for Windows' real git.exe for polls instead of
// the cmd\git.exe wrapper: in every thread folder of the saved workspace, each polled command must
// answer the same through the app as through the wrapper, and Git must hand its children the same
// environment. Both sides start from the environment Explorer gives Loom, rebuilt from the registry.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const ps = c => spawnSync('powershell', ['-NoProfile', '-Command', c], { encoding: 'utf8' }).stdout.trim();
const registry = JSON.parse(ps(`$m = [Environment]::GetEnvironmentVariables('Machine'); $u = [Environment]::GetEnvironmentVariables('User'); $o = @{}
  foreach ($k in $m.Keys) { $o[$k] = [Environment]::ExpandEnvironmentVariables($m[$k]) }
  foreach ($k in $u.Keys) { $v = [Environment]::ExpandEnvironmentVariables($u[$k]); if ($k -eq 'Path') { $o[$k] = $o[$k] + ';' + $v } else { $o[$k] = $v } }
  $o | ConvertTo-Json -Compress`));
const explorer = { ...registry };
for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER', 'SystemRoot', 'SystemDrive', 'windir', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC', 'ALLUSERSPROFILE', 'SESSIONNAME'])
  if (process.env[k] !== undefined && explorer[k] === undefined) explorer[k] = process.env[k];
// What git_run adds.
const loomEnv = { ...explorer, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const wrapper = spawnSync('where.exe', ['git'], { env: explorer, encoding: 'utf8' }).stdout.split(/\r?\n/)[0];
assert.match(wrapper, /\\cmd\\git\.exe$/i, `Loom's git must be Git for Windows' cmd\\git.exe wrapper, not ${wrapper}`);
// git_run's result: stdout, or stderr as the error.
const viaWrapper = (dir, args) => {
  const r = spawnSync(wrapper, ['-C', dir, ...args], { env: loomEnv, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: r.stdout } : { err: r.stderr.trim() || `git exited Some(${r.status})` };
};

const root = mkdtempSync(join(tmpdir(), 'loom-git-direct-'));
// Git runs diff.external through its shell with the environment it gives every child, which is what
// a filter or hook would see.
const probe = join(root, 'probe');
const setup = (...args) => assert.equal(spawnSync(wrapper, ['-C', probe, '-c', 'user.name=Loom', '-c', 'user.email=loom@example.com', ...args], { env: loomEnv }).status, 0, args.join(' '));
spawnSync(wrapper, ['init', '-q', probe], { env: loomEnv });
writeFileSync(join(probe, 'a.txt'), 'one\n');
setup('add', 'a.txt');
setup('commit', '-q', '--no-gpg-sign', '-m', 'one');
setup('config', 'diff.external', 'printenv #');
writeFileSync(join(probe, 'a.txt'), 'two\n');

const saved = JSON.parse(readFileSync(join(process.env.APPDATA, 'dev.ayoub.loom', 'workspaces.json'), 'utf8'));
const threads = [...new Map(saved.threads.map(t => [t.dir, t])).values()];
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
writeFileSync(join(root, 'workspace.json'), '{}');
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [join(root, 'workspace.json')], {
  windowsHide: true, stdio: 'ignore', env: { ...explorer, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
// The wrapper side gets the test Loom's environment too.
loomEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { ready = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false); if (!ready) await pause(100); }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const viaApp = (dir, args) => page.evaluate(({ dir, args }) => window.__TAURI__.core.invoke('git_run', { dir, args }).then(ok => ({ ok }), err => ({ err })), { dir, args });

  const env = await viaApp(probe, ['diff', '--ext-diff']);
  assert.ok(env.ok?.includes('MSYSTEM='), `The probe must print Git's environment: ${JSON.stringify(env)}`);
  const expected = viaWrapper(probe, ['diff', '--ext-diff']);
  const only = (a, b) => (a.ok ?? '').split('\n').filter(l => !(b.ok ?? '').split('\n').includes(l));
  assert.deepEqual(env, expected, `Git must hand its children the environment the wrapper gives them. App only: ${JSON.stringify(only(env, expected))}; wrapper only: ${JSON.stringify(only(expected, env))}`);
  console.log('PASS environment Git hands its children');
  // Equal answers would prove nothing if the app had fallen back to the wrapper: catch the git.exe
  // it starts for a poll while that poll waits.
  setup('config', 'diff.external', 'sleep 3 #');
  const slow = viaApp(probe, ['diff', '--ext-diff']);
  await pause(1500);
  const started = ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid} AND Name = 'git.exe'").ExecutablePath`);
  await slow;
  assert.match(started, /\\libexec\\git-core\\git\.exe$/i, `A poll must start the real git.exe, not ${started || 'nothing'}`);
  console.log(`PASS polls start ${started}`);
  let compared = 0;
  for (const th of threads) {
    const branch = viaWrapper(th.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).ok?.trim() || 'HEAD';
    // Every read the app polls.
    const polls = [
      [th.dir, ['status', '--porcelain=v1', '-z', '-uall', '--branch']],
      [th.dir, ['status', '--porcelain=v1', '-z', '-uall']],
      [th.dir, ['diff', '--numstat']], [th.dir, ['diff', '--numstat', '--cached']], [th.dir, ['diff', '--numstat', 'HEAD']],
      [th.dir, ['log', '--oneline', '-10']],
      [th.dir, ['rev-parse', '--abbrev-ref', 'HEAD']], [th.dir, ['rev-parse', '--abbrev-ref', '@{upstream}']],
      [th.repo, ['rev-list', '--count', branch, '--not', `--exclude=${branch}`, '--branches', '--remotes']],
    ];
    for (const [dir, args] of polls) {
      assert.deepEqual(await viaApp(dir, args), viaWrapper(dir, args), `${dir}: git ${args.join(' ')}`);
      compared++;
    }
    console.log(`PASS ${th.dir}`);
  }
  console.log(`PASS ${compared} polls in ${threads.length} saved thread folders answer the same without the wrapper`);
} finally {
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { rmSync(root, { recursive: true, force: true }); break; } catch (e) {
      if (i === 10) { console.log('Could not remove', root, e.code); break; }
      await pause(1000);
    }
  }
}
