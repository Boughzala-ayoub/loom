// node scripts/changes-equivalence-check.mjs, against a built native Loom bundle.
// Throwaway repos in every state the Changes panel reads, each as a main checkout and as a linked
// worktree. The Git reads a refresh made before phase 5 of docs/performance-plan.md and the ones it
// makes now, both through the real app, must give the same file list, upstream, ahead/behind,
// label and midway state.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { parseStatus, parseBranch, upstreamLabel } from '../src/gitparse.ts';

const root = mkdtempSync(join(tmpdir(), 'loom-changes-eq-'));
// Setup runs with its own global config, so the user's signing, hooks or aliases can't get in.
writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = Loom\n\temail = loom@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n');
writeFileSync(join(root, 'break.js'), "const fs = require('fs'); fs.writeFileSync(process.argv[2], 'break\\n' + fs.readFileSync(process.argv[2], 'utf8'));");
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: `node "${join(root, 'break.js').replaceAll('\\', '/')}"` };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
const must = (cwd, ...args) => {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
const fails = (cwd, ...args) => assert.notEqual(git(cwd, ...args).status, 0, `git ${args.join(' ')} was meant to stop`);
const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); must(cwd, 'add', file); must(cwd, 'commit', '-q', '-m', `${file}: ${text.trim()}`); };
const branchOff = (d, name, file, text) => { must(d, 'branch', name); must(d, 'checkout', '-q', name); commit(d, file, text); must(d, 'checkout', '-q', '-'); };

// Each case starts from a checkout on a branch that tracks origin/main, one commit in, and puts it
// in its state. `marker` is the git-dir entry the state must leave, so a broken setup can't pass.
const cases = [
  { name: 'no upstream', make: d => must(d, 'branch', '--unset-upstream') },
  { name: 'ahead', make: d => commit(d, 'a.txt', 'ahead\n') },
  { name: 'behind', make: d => { commit(d, 'c.txt', 'up\n'); must(d, 'push', '-q', 'origin', 'HEAD:main'); must(d, 'reset', '-q', '--hard', 'HEAD~1'); } },
  { name: 'ahead and behind', make: d => { commit(d, 'c.txt', 'up\n'); must(d, 'push', '-q', 'origin', 'HEAD:main'); must(d, 'reset', '-q', '--hard', 'HEAD~1'); commit(d, 'a.txt', 'mine\n'); } },
  { name: 'equal', make: () => {} },
  { name: 'gone upstream', make: d => { must(d, 'push', '-q', 'origin', 'HEAD:refs/heads/gone'); must(d, 'branch', '-q', '--set-upstream-to=origin/gone'); must(d, 'push', '-q', 'origin', '--delete', 'gone'); } },
  { name: 'local branch upstream', make: d => { must(d, 'branch', 'local-base'); must(d, 'branch', '-q', '--set-upstream-to=local-base'); commit(d, 'a.txt', 'ahead of local\n'); } },
  { name: 'detached HEAD', make: d => must(d, 'checkout', '-q', '--detach') },
  { name: 'no commits', unborn: true },
  // A clone of an empty remote: its upstream is gone. The worktree's names one that exists.
  { name: 'no commits, upstream set', unborn: 'upstream' },
  { name: 'merge', marker: 'MERGE_HEAD', make: d => { branchOff(d, 'other', 'a.txt', 'theirs\n'); commit(d, 'a.txt', 'ours\n'); fails(d, 'merge', 'other'); } },
  { name: 'revert', marker: 'REVERT_HEAD', make: d => { commit(d, 'a.txt', 'one\n'); commit(d, 'a.txt', 'two\n'); fails(d, 'revert', '--no-edit', 'HEAD~1'); } },
  { name: 'rebase conflict', marker: 'rebase-merge', make: d => { branchOff(d, 'other', 'a.txt', 'theirs\n'); commit(d, 'a.txt', 'ours\n'); fails(d, 'rebase', 'other'); } },
  { name: 'rebase at break', marker: 'rebase-merge', make: d => { commit(d, 'a.txt', 'picked\n'); must(d, 'rebase', '-q', '-i', 'HEAD~1'); } },
  { name: 'git am', marker: 'rebase-apply', make: d => {
    branchOff(d, 'other', 'a.txt', 'patched\n');
    writeFileSync(join(d, '..', 'fix.patch'), must(d, 'format-patch', '-1', '--stdout', 'other'));
    commit(d, 'a.txt', 'conflicting\n');
    fails(d, 'am', join(d, '..', 'fix.patch'));
  } },
];
const checkouts = [];
for (const [i, c] of cases.entries()) {
  for (const worktree of [false, true]) {
    const base = join(root, `${i}${worktree ? 'w' : 'm'}`);
    mkdirSync(base);
    let d = join(base, 'main');
    if (c.unborn === 'upstream' && !worktree) { must(base, 'init', '-q', '--bare', 'remote.git'); must(base, 'clone', '-q', 'remote.git', 'main'); }
    else if (c.unborn && !worktree) must(base, 'init', '-q', 'main');
    else {
      must(base, 'init', '-q', '--bare', 'remote.git');
      must(base, 'clone', '-q', 'remote.git', 'seed');
      commit(join(base, 'seed'), 'a.txt', 'base\n');
      commit(join(base, 'seed'), 'b.txt', 'base\n');
      must(join(base, 'seed'), 'push', '-q', 'origin', 'main');
      must(base, 'clone', '-q', 'remote.git', 'main');
      if (worktree) {
        const m = d;
        d = join(base, 'wt');
        // worktree add --orphan needs Git 2.42.
        if (!c.unborn) must(m, 'worktree', 'add', '-q', '--track', '-b', 'wt', d, 'origin/main');
        else {
          must(m, 'worktree', 'add', '-q', '--detach', d);
          must(d, 'checkout', '-q', '--orphan', 'orphan');
          if (c.unborn === 'upstream') { must(d, 'config', 'branch.orphan.remote', 'origin'); must(d, 'config', 'branch.orphan.merge', 'refs/heads/main'); }
        }
      }
      c.make?.(d);
    }
    // Something in the file list: an untracked file with a space, and a tracked edit.
    writeFileSync(join(d, 'extra file.txt'), 'x\n');
    if (existsSync(join(d, 'b.txt'))) writeFileSync(join(d, 'b.txt'), 'edited\n');
    const gitDir = resolve(d, must(d, 'rev-parse', '--git-dir').trim());
    if (c.marker) assert.ok(existsSync(join(gitDir, c.marker)), `${c.name}: setup must leave ${c.marker}`);
    checkouts.push({ name: `${c.name}, ${worktree ? 'linked worktree' : 'main checkout'}`, dir: d });
  }
}

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
writeFileSync(join(root, 'workspace.json'), '{}');
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [join(root, 'workspace.json')], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { ready = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false); if (!ready) await pause(100); }
  assert.ok(ready, 'Native webview must start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const midways = {};
  for (const { name, dir } of checkouts) {
    const { before, after } = await page.evaluate(async dir => {
      const { invoke } = window.__TAURI__.core;
      const git = (...args) => invoke('git_run', { dir, args });
      // The reads readChanges made before phase 5, then the ones it makes now.
      const before = await Promise.all([
        git('status', '--porcelain=v1', '-z', '-uall'),
        git('rev-parse', '--abbrev-ref', '@{upstream}').then(s => s.trim(), () => ''),
        git('rev-list', '--left-right', '--count', '@{upstream}...HEAD').then(s => s.trim(), () => ''),
        Promise.all([
          git('rev-parse', '-q', '--verify', 'MERGE_HEAD').then(() => 'merge', () => ''),
          git('rev-parse', '-q', '--verify', 'REVERT_HEAD').then(() => 'revert', () => ''),
          git('rebase', '--show-current-patch').then(() => 'rebase', () => ''),
        ]).then(r => r.find(Boolean) ?? ''),
      ]);
      const after = await Promise.all([git('status', '--porcelain=v1', '-z', '-uall', '--branch'), invoke('git_midway', { dir })]);
      return { before, after };
    }, dir);
    const was = { files: parseStatus(before[0]), upstream: before[1], span: before[2], midway: before[3] };
    const { ask, ...tracking } = parseBranch(after[0]);
    const is = { files: parseStatus(after[0]), ...tracking, midway: after[1] };
    // As readChanges does: with no commits, status can't say whether the upstream exists.
    if (ask) is.upstream = await page.evaluate(dir => window.__TAURI__.core.invoke('git_run', { dir, args: ['rev-parse', '--abbrev-ref', '@{upstream}'] }).then(s => s.trim(), () => ''), dir);
    was.label = upstreamLabel(was.upstream, was.span);
    is.label = upstreamLabel(is.upstream, is.span);
    assert.deepEqual(is, was, `${name}: ${JSON.stringify(after[0].split('\0')[0])}`);
    assert.ok(was.files.length >= 1, `${name}: the file list must not be empty`);
    midways[name] = was.midway;
    console.log(`PASS ${name.padEnd(40)} ${JSON.stringify(after[0].split('\0')[0]).padEnd(46)} ${was.label}${was.midway ? `, ${was.midway}` : ''}`);
  }
  // The states that show a bar, and the two that leave a marker without one.
  for (const where of ['main checkout', 'linked worktree'])
    assert.deepEqual(['merge', 'revert', 'rebase conflict', 'rebase at break', 'git am'].map(c => midways[`${c}, ${where}`]), ['merge', 'revert', 'rebase', '', '']);
  console.log(`PASS ${checkouts.length} checkouts: old and new Changes reads agree`);
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
