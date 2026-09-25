// Git worktrees omit .build. Prepare bindgen's DLL before the Tauri CLI starts Cargo.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, 'src-tauri/.build');
const native = join(build, 'clang/native');
const hasClang = path => existsSync(path) && (statSync(path).isFile()
  ? /(?:^|[\\/])(?:lib)?clang\.dll$/i.test(path)
  : ['libclang.dll', 'clang.dll'].some(name => existsSync(join(path, name))));

try {
  if (process.env.LIBCLANG_PATH) {
    if (!hasClang(process.env.LIBCLANG_PATH)) throw new Error('LIBCLANG_PATH does not point to libclang.dll. Fix or unset it, then retry.');
  } else if (!hasClang(native)) {
    let source;
    try {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      source = join(dirname(resolve(root, common)), 'src-tauri/.build/clang/native/libclang.dll');
    } catch { /* A source archive can install the wheel without Git. */ }
    mkdirSync(native, { recursive: true });
    if (source && existsSync(source)) {
      copyFileSync(source, join(native, 'libclang.dll'));
      console.log('Reused libclang from the main checkout.');
    } else {
      console.log('Preparing libclang for this checkout...');
      const result = spawnSync('python', ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--no-deps', '--upgrade', '--target', build, 'libclang==18.1.1'], { stdio: 'inherit' });
      if (result.error || result.status !== 0 || !hasClang(native)) {
        throw new Error('Could not install libclang. Ensure Python with pip is on PATH, then retry npm run tauri.');
      }
    }
  }
} catch (error) {
  console.error(`Native setup: ${error.message}`);
  process.exitCode = 1;
}
