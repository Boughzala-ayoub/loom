// Run: node scripts/native-setup-check.mjs (Windows; add --install to test the pip fallback too).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.scripts.pretauri, 'node scripts/setup-native.mjs', 'Tauri must prepare the ignored libclang dependency before Cargo starts');
const cache = join(root, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const fixture = mkdtempSync(join(cache, 'native-setup-'));
const primary = join(fixture, 'main');
const worktree = join(fixture, 'fresh worktree');
const dll = 'src-tauri/.build/clang/native/libclang.dll';
const env = { ...process.env };
delete env.LIBCLANG_PATH;
const git = (...args) => execFileSync('git', args, { cwd: primary, env, stdio: 'pipe' });
try {
  mkdirSync(join(primary, 'scripts'), { recursive: true });
  mkdirSync(join(primary, 'src-tauri/.build/clang/native'), { recursive: true });
  copyFileSync(join(root, dll), join(primary, dll));
  copyFileSync(join(root, 'scripts/setup-native.mjs'), join(primary, 'scripts/setup-native.mjs'));
  writeFileSync(join(primary, '.gitignore'), 'src-tauri/.build/\n');
  git('init');
  git('add', '.');
  git('-c', 'user.name=Native setup test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Test fixture');
  git('worktree', 'add', '-b', 'fresh', worktree);
  assert.equal(existsSync(join(worktree, dll)), false, 'Git must leave the ignored dependency behind');
  const run = (extra = {}) => execFileSync(process.execPath, [join(worktree, 'scripts/setup-native.mjs')], { cwd: worktree, env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' });
  assert.match(run(), /Reused libclang/);
  assert.equal(existsSync(join(worktree, dll)), true, 'Setup must repair a fresh worktree');
  assert.equal(run(), '', 'An already prepared worktree must need no installation');
  assert.equal(run({ LIBCLANG_PATH: join(primary, 'src-tauri/.build/clang/native') }), '');
  assert.throws(() => run({ LIBCLANG_PATH: join(fixture, 'missing') }), /LIBCLANG_PATH/, 'A broken override must fail before Cargo');
  execFileSync('python', ['-c', 'import ctypes,sys; ctypes.CDLL(sys.argv[1]).clang_createIndex', join(worktree, dll)], { stdio: 'inherit' });
  if (process.argv.includes('--install')) {
    const clone = join(fixture, 'fresh clone');
    git('clone', '--local', primary, clone);
    execFileSync(process.execPath, [join(clone, 'scripts/setup-native.mjs')], { cwd: clone, env, stdio: 'inherit' });
    execFileSync('python', ['-c', 'import ctypes,sys; ctypes.CDLL(sys.argv[1]).clang_createIndex', join(clone, dll)], { stdio: 'inherit' });
    console.log('PASS: fresh clone installs a loadable libclang wheel');
  }
  console.log('PASS: fresh worktree repaired, repeat setup skipped, overrides respected, libclang loads');
} finally {
  // mkdtemp owns this directory under the workspace cache, including its disposable Git repository.
  assert.equal(dirname(resolve(fixture)), cache);
  rmSync(fixture, { recursive: true, force: true });
}
