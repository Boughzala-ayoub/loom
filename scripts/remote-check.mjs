// The phone remote against the real app: loomctl remote on/pair/revoke, the
// HTTP server's refusals, and the phone app in headless Chrome at 320 to
// 1280 px: a cmd.exe pane, the Changes tab on the temporary repo (a hunk, a
// commit, a branch, a stash), Usage, Settings and its task manager, creating and closing threads,
// and a phone's notifications through a stand-in push service on 127.0.0.1,
// and dictation: a sentence Windows' speech synthesizer says into Chrome's
// fake microphone, through the phone's mic and the real whisper.
// REMOTE_WIDTHS=375 runs one width. Needs a
// build with --features tauri/custom-protocol (loom.exe and loomctl.exe
// beside it, or LOOM_TEST_EXE; a debug one keeps its own data folder) and a
// whisper model in that data folder's models\. A temporary profile and Git
// folder; restores the shared files a test Loom rewrites. The test Loom's
// window shows on the desktop while it runs, and is resized once.
// Set PLAYWRIGHT_MODULE to an installed playwright module path if it isn't local.
// REMOTE_CHECK_DIST=1 gives the browser the page from dist/ instead of
// loom.exe's copy, to try a page change without rebuilding loom.exe. Run the
// final check without it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe');
const ctl = join(dirname(exe), 'loomctl.exe');
assert.ok(existsSync(ctl), `loomctl.exe must sit beside ${exe}`);
const out = resolve('node_modules/.cache/remote-check');
const fromDist = process.env.REMOTE_CHECK_DIST === '1';
mkdirSync(out, { recursive: true });
// A debug build keeps its state apart from the installed Loom's (lib.rs data_dir).
const data = join(process.env.APPDATA, /[\\/]debug[\\/]/.test(exe) ? 'dev.ayoub.loom-dev' : 'dev.ayoub.loom');
const plugin = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins/loom.js');
const shared = [join(data, 'claude-hooks.json'), join(data, 'shell-init.ps1'), plugin]
  .map((file, i) => ({ file, backup: join(out, `${i}-${basename(file)}.backup`), had: existsSync(file) }));
for (const s of shared) if (s.had) copyFileSync(s.file, s.backup);

const dir = mkdtempSync(join(tmpdir(), 'loom-remote-check-'));
// Worktrees go under ~\loom\<repo>, so the repo's name is this run's own.
const repoName = `loom-remote-check-${process.pid}`;
const repo = join(dir, repoName);
mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
spawnSync('git', ['-C', repo, '-c', 'user.email=check@loom', '-c', 'user.name=check', 'commit', '-q', '--allow-empty', '-m', 'start']);
const plain = join(dir, 'plain');
mkdirSync(plain);
const profile = join(dir, 'workspace.json');
writeFileSync(profile, JSON.stringify({ silent: true, ui: { thread: 0 }, threads: [{ repo, dir: repo, branch: '', name: 'alpha', panes: [{ cmd: 'cmd' }] }] }));
// The phone's mic shows on agents only: an OpenCode 1 that only waits stands in for one (Loom runs it through cmd).
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'opencode.cmd'), '@echo off\r\nif "%~1"=="--version" (echo opencode v1.0.0& exit /b 0)\r\nif not "%~1"=="" exit /b 1\r\necho Stand-in agent ready.\r\npowershell -NoProfile -Command Start-Sleep 3600\r\n');
// The sentence the phone dictates, said by Windows' own speech synthesizer: 16-bit, 16 kHz, mono.
const SENTENCE = 'Please run the tests and fix the login bug.';
const speech = join(dir, 'said.wav');
spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono))); $s.Speak('${SENTENCE}'); $s.Dispose()`]);
assert.ok(existsSync(speech), 'System.Speech must say the sentence into a WAV');
const wav = readFileSync(speech);
const at = wav.indexOf('data') + 8;
const pcm = wav.subarray(at, at + (wav.readUInt32LE(at - 4) & ~1));
/** The sentence's words, give or take what base fumbles: whisper heard it if these four are there. */
const heardIt = text => ['please', 'run', 'fix', 'login'].every(w => text.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').includes(w));

const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
};
function loomctl(...args) {
  const env = { ...process.env };
  delete env.LOOM_PIPE; // this check may itself run in a Loom pane
  const r = spawnSync(ctl, ['--profile', profile, ...args], { encoding: 'utf8', env, timeout: 60000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), json };
}
const ok = (...args) => {
  const r = loomctl(...args);
  assert.equal(r.code, 0, `loomctl ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
};
let child;
async function launch() {
  child = spawn(exe, [profile], { stdio: 'ignore', env: { ...process.env, PATH: `${bin};${process.env.PATH}` } });
  for (let i = 0; i < 100; i++) {
    if (loomctl('status').code === 0) return;
    await pause(300);
  }
  assert.fail('Loom must start and answer loomctl');
}
const kill = () => spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });

let browser;
try {
  await launch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const api = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Off until turned on; on, it answers on 127.0.0.1 only.
  let r = ok('--json', 'remote');
  assert.equal(r.json.on, false);
  assert.match(loomctl('remote', 'pair').err, /off/, 'No pairing while the remote is off');
  r = ok('--json', 'remote', 'on', '--port', String(port));
  assert.equal(r.json.listening, true);
  assert.equal(r.json.port, port);
  assert.match(ok('remote').out, /On, at 127\.0\.0\.1:\d+\. 0 phones paired/);
  assert.equal(JSON.parse(readFileSync(profile.replace(/\.json$/, '.remote.json'), 'utf8')).on, true, 'The setting sits beside the profile');
  console.log('PASS remote on, off by default, and its setting saved beside the profile');

  // The server: the page for anyone who reaches it, commands only for a paired phone.
  let res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /id="pairing"/, 'GET / is the phone page, not the desktop page');
  const script = html.match(/src="(\/assets\/remote-[^"]+\.js)"/)[1];
  if (!fromDist) assert.equal(script, readFileSync('dist/remote.html', 'utf8').match(/src="(\/assets\/remote-[^"]+\.js)"/)[1], 'loom.exe must embed the current frontend bundle');
  res = await fetch(base + script, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('cache-control'), /immutable/);
  for (const path of ['/assets/nope.js', '/assets/..%2Findex.html', '/index.html', '/assets/']) {
    assert.equal((await fetch(base + path)).status, 404, `${path} must not be served`);
  }
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [] })).status, 401, 'No token, no commands');
  assert.equal((await api('/api/procs', {})).status, 401, 'No token, no task manager');
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [] }, { Authorization: 'Bearer 00' })).status, 401, 'A made-up token, no commands');
  res = await api('/api/pair', { code: '000000' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /No pairing code is open/);
  let code = ok('--json', 'remote', 'pair').json.pairing;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.match((await (await api('/api/pair', { code: wrong })).json()).error, /Wrong code/);
  res = await api('/api/pair', { code });
  assert.equal(res.status, 200);
  const token = (await res.json()).token;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await api('/api/pair', { code })).status, 403, 'A code pairs one phone');
  const auth = { Authorization: `Bearer ${token}` };
  res = await api('/api/cli', { cmd: 'status', argv: [] }, auth);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.threads, 1);
  assert.equal((await api('/api/cli', { cmd: 'status', argv: 'x' }, auth)).status, 400, 'Words must be a list');
  assert.equal((await api('/api/cli', { cmd: 'status', argv: [], stdin: 5 }, auth)).status, 400, 'stdin must be text');
  // The task manager's reading, from Windows through remote.rs (procs.rs): every process with its numbers, System too.
  res = await api('/api/procs', {}, auth);
  assert.equal(res.status, 200);
  const pc = (await res.json()).data;
  const system = pc.procs.find(p => p.pid === 4);
  assert.ok(system?.name === 'System' && typeof system.cpu === 'number' && system.memory > 0, `System, which no Loom may open: ${JSON.stringify(system)}`);
  assert.ok(pc.procs.some(p => p.pid === child.pid && p.name === 'loom.exe'), 'the test Loom itself');
  assert.ok(pc.memory.used < pc.memory.total && pc.uptime > 0 && pc.cpu >= 0 && pc.cpu <= 100, JSON.stringify({ ...pc, procs: pc.procs.length }));
  console.log(`PASS /api/procs for a paired phone only: ${pc.procs.length} processes, CPU ${pc.cpu}%, System at ${system.cpu}%`);
  assert.match(ok('remote').out, /1 phone paired/);
  assert.ok(!readFileSync(profile.replace(/\.json$/, '.remote.json'), 'utf8').includes(token), 'Only a hash of the token is saved');
  code = ok('--json', 'remote', 'pair').json.pairing;
  for (let i = 0; i < 5; i++) await api('/api/pair', { code: code === '000000' ? '111111' : '000000' });
  assert.equal((await api('/api/pair', { code })).status, 403, 'Five wrong guesses use the code up');
  console.log('PASS the page, its bundle, gzip, refusals without a token, and pairing');

  // Notifications: the worker and icon are served, a phone signs up, and
  // `remote push test` reaches its push service encrypted for it and signed.
  res = await fetch(base + '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /notificationclick/);
  assert.equal((await fetch(base + '/icon.png')).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/badge.png')).headers.get('content-type'), 'image/png');
  assert.equal((await api('/api/push', {})).status, 401, 'No token, no notifications');
  const b64u = buf => Buffer.from(buf).toString('base64url');
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64u(await crypto.subtle.exportKey('raw', ua.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const pushes = [];
  let answer = 201;
  const service = httpServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => { pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) }); res.statusCode = answer; res.end(); });
  });
  await new Promise(r => service.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${service.address().port}/push/phone-1`;
  // loomctl without blocking: the stand-in push service answers from this same process.
  const pushTest = () => new Promise(resolve => {
    const env = { ...process.env };
    delete env.LOOM_PIPE;
    const child = spawn(ctl, ['--profile', profile, '--json', 'remote', 'push', 'test'], { env });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('close', code => resolve({ code, json: (() => { try { return JSON.parse(out); } catch { return undefined; } })() }));
  });
  try {
    let got = await (await api('/api/push', {}, auth)).json();
    assert.equal(got.on, false);
    assert.match(got.key, /^[A-Za-z0-9_-]{87}$/, 'Loom made its key at start');
    assert.equal((await api('/api/push', { subscription: { endpoint, keys: { p256dh: keys.p256dh } } }, auth)).status, 400, 'a subscription needs both keys');
    got = await (await api('/api/push', { subscription: { endpoint, keys } }, auth)).json();
    assert.equal(got.on, true);
    assert.equal(ok('--json', 'remote').json.pushes, 1);
    const first = await pushTest();
    assert.equal(first.code, 0);
    assert.equal(first.json.sent, 1);
    assert.equal(pushes.length, 1);
    const [{ path, headers, body }] = pushes;
    assert.equal(path, '/push/phone-1');
    assert.equal(headers['content-encoding'], 'aes128gcm');
    assert.equal(headers.urgency, 'high');
    assert.equal(headers.topic, 'loom-test');
    assert.equal(headers.ttl, '43200');
    // VAPID: signed with Loom's key, for this push service.
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization);
    assert.equal(k, got.key);
    const [head, claims, sig] = jwt.split('.');
    const verifier = await crypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, Buffer.from(sig, 'base64url'), Buffer.from(`${head}.${claims}`)));
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, new URL(endpoint).origin);
    // RFC 8291, as the phone decrypts it.
    const asPublic = body.subarray(21, 21 + body[20]);
    const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, ua.privateKey, 256);
    const hkdf = async (salt, ikm, info, n) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8);
    const ikm = await hkdf(Buffer.from(keys.auth, 'base64url'), shared, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(keys.p256dh, 'base64url'), asPublic]), 32);
    const salt = body.subarray(0, 16);
    const cek = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
    const plain = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12) }, cek, body.subarray(21 + body[20])));
    const message = JSON.parse(plain.subarray(0, -1));
    assert.equal(message.title, 'Loom');
    assert.equal(message.tag, 'loom-test');
    assert.match(message.url, /^\/#\/pane\/[^/]+\/alpha%3A1\/[0-9a-f-]{36}$/, 'the test opens the first agent, its stableId too');
    // Gone from its push service: Loom forgets it.
    answer = 410;
    assert.notEqual((await pushTest()).code, 0, 'a push no phone got fails');
    assert.equal(ok('--json', 'remote').json.pushes, 0);
    assert.equal((await (await api('/api/push', {}, auth)).json()).on, false);
    // Signed up again, then off from the phone.
    await api('/api/push', { subscription: { endpoint, keys } }, auth);
    assert.equal((await (await api('/api/push', { off: true }, auth)).json()).on, false);
    assert.equal(ok('--json', 'remote').json.pushes, 0);
  } finally {
    service.close();
  }
  console.log('PASS notifications: the worker, a phone signs up, a push reaches its push service encrypted and signed, a gone one is forgotten');

  // The phone page, at every width.
  // A microphone that says the sentence once (%noloop), allowed without a prompt.
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speech}%noloop`] });
  const pageErrors = [];
  const context = async (width, stored) => {
    const c = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: width < 900, hasTouch: width < 900, permissions: ['microphone'] });
    if (stored) await c.addInitScript(t => localStorage.setItem('loom-token', t), stored);
    if (fromDist) await c.route(`${base}/**`, route => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/' && !path.startsWith('/assets/')) return route.continue();
      return route.fulfill({ path: join('dist', path === '/' ? 'remote.html' : path) });
    });
    const page = await c.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => pageErrors.push(e.message));
    return page;
  };
  const fits = async (page, what) => {
    assert.deepEqual(pageErrors, [], `${what}: errors in the page`);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `${what}: the page is ${scroll} px wide in a ${client} px window`);
    // Fingers through a phone: every visible control is at least 44 px tall.
    const small = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')]
      .filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.outerHTML.slice(0, 80)));
    assert.deepEqual(small, [], `${what}: controls under 44 px`);
    await page.screenshot({ path: join(out, `${what.replace(/\W+/g, '-')}.png`) });
  };

  const alpha = page => page.locator('#list .thread', { has: page.locator('.thread-head .name', { hasText: /^alpha/ }) });
  const sheetButton = (page, text) => page.locator('#sheet.on button', { hasText: text });
  const sheetDone = page => page.locator('#sheet').waitFor({ state: 'hidden' });
  const paneName = page => page.locator('#pane .who b').textContent();
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.email=check@loom', '-c', 'user.name=check', ...args], { encoding: 'utf8' });

  // Pairing through the page itself.
  let page = await context(375);
  await page.goto(base);
  await page.locator('#pairing').waitFor();
  await fits(page, '375 pairing');
  code = ok('--json', 'remote', 'pair').json.pairing;
  await page.fill('#pairing input', code);
  await page.click('#pairing button');
  await page.locator('#list .agent').first().waitFor();
  const phoneToken = await page.evaluate(() => localStorage.getItem('loom-token'));
  assert.match(phoneToken, /^[0-9a-f]{64}$/);
  await page.context().close();
  console.log('PASS pairing from the page');

  // Dictation: /api/dictate's refusals, the sentence's samples through the real whisper, then the
  // phone's mic recording it from Chrome's fake microphone, and the Dictation sheet changing the PC.
  {
    const dictate = (body, query = '', headers = auth) => fetch(`${base}/api/dictate${query}`, { method: 'POST', headers, body });
    // A request's head alone, as a socket sends it: refused before any of its body is read.
    const refused = head => new Promise((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => s.write(head));
      let got = '';
      s.on('data', d => (got += d));
      s.on('end', () => resolve(Number(got.split(' ')[1])));
      s.on('error', reject);
    });
    assert.equal((await dictate(new Uint8Array(4), '', {})).status, 401, 'No token, no transcription');
    assert.equal((await dictate(new Uint8Array(4), '?lang=EN')).status, 400, 'A language is a whisper code');
    assert.equal((await dictate(new Uint8Array(3))).status, 400, 'Whole 16-bit samples');
    assert.equal(await refused(`POST /api/dictate HTTP/1.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${(6 << 20) + 2}\r\n\r\n`), 413, 'A clip is 6 MiB at most');
    assert.equal(await refused(`POST /api/dictate HTTP/1.1\r\nContent-Length: ${(1 << 20) + 2}\r\n\r\n`), 413, "A stranger's body stays a prompt's 1 MiB");
    assert.equal(await refused(`POST /api/cli HTTP/1.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${(1 << 20) + 2}\r\n\r\n`), 413, '/api/cli keeps 1 MiB');
    assert.deepEqual(await (await dictate(new Uint8Array(0))).json(), { ok: true, text: '' }, 'An empty clip only loads the model');
    assert.deepEqual(await (await dictate(new Uint8Array(32000))).json(), { ok: true, text: '' }, 'Silence is nothing to transcribe');
    const direct = await (await dictate(pcm, '?lang=en')).json();
    assert.ok(direct.ok && heardIt(direct.text), `whisper heard the sentence's samples: ${JSON.stringify(direct)}`);
    console.log(`PASS /api/dictate: refusals, silence, and "${SENTENCE}" heard as "${direct.text}"`);

    // The phone's mic, on a stand-in agent added for it.
    const tid = ok('--json', 'threads').json[0].id;
    const agent = ok('--json', 'add', tid, '--cmd', 'opencode').json;
    page = await context(375, phoneToken);
    await page.goto(`${base}/#/pane/${encodeURIComponent(agent.id)}`);
    await page.locator('#pane .who b', { hasText: '· opencode' }).waitFor();
    await page.click('#mic');
    await page.locator('#rec').waitFor();
    await page.locator('#rec .info span', { hasText: 'English · /prompt' }).waitFor();
    await fits(page, '375 recording');
    // The whole sentence, and a little of the silence after it.
    await pause(pcm.length / 32 + 700);
    await page.click('#rec .stop');
    await page.waitForFunction(() => document.querySelector('#prompt textarea').value.startsWith('/prompt '), null, { timeout: 90000 });
    const box = await page.inputValue('#prompt textarea');
    assert.ok(heardIt(box), `the phone's box has what whisper heard: ${JSON.stringify(box)}`);
    assert.equal(await page.locator('#rec').isHidden(), true);
    // The sheet picks on the PC: French, then back to English.
    await page.click('#more');
    await sheetButton(page, 'Dictation · English · /prompt').click();
    await page.locator('#sheet.on .dict-row').first().waitFor();
    await fits(page, '375 dictation sheet');
    await page.locator('#sheet .dict-row .pick', { hasText: 'French' }).click();
    const pickedLang = () => ok('--json', 'dictation').json.langs.find(l => l.on).code;
    for (let i = 0; i < 40 && pickedLang() !== 'fr'; i++) await pause(250);
    assert.equal(pickedLang(), 'fr', "The phone's sheet picks the PC's language");
    await page.locator('#sheet .dict-row .pick[aria-pressed=true]', { hasText: 'French' }).waitFor();
    ok('dictation', 'lang', 'en');
    await page.context().close();
    ok('close', agent.id, '--yes');
    console.log(`PASS the phone's mic: the recording bar, "/prompt" and what whisper heard in the box (${JSON.stringify(box)}), and the sheet picking French on the PC`);
  }

  // A file the Changes tab can stage, diff, commit and discard.
  writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  git('add', 'notes.txt');
  const trunk = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  git('commit', '-q', '-m', 'notes');

  for (const width of (process.env.REMOTE_WIDTHS || '320,375,768,1024,1280').split(',').map(Number)) {
    page = await context(width, phoneToken);
    await page.goto(base);
    const thread = alpha(page);
    const row = thread.locator('.agent');
    await row.waitFor();
    await fits(page, `${width} list`);
    // Threads as on the PC; a folded one stays folded on this phone.
    await thread.locator('.thread-head').click();
    await row.waitFor({ state: 'detached' });
    await page.reload();
    await thread.locator('.thread-head[aria-expanded=false]').waitFor();
    assert.equal(await row.count(), 0, 'A folded thread stays folded after a reload');
    await thread.locator('.thread-head').click();
    await thread.locator('.thread-top .icon-btn').click();
    await sheetButton(page, 'Rename').waitFor();
    await fits(page, `${width} thread actions`);
    await sheetButton(page, 'Cancel').click();
    await sheetDone(page);
    // Finding: the box narrows the list.
    await page.fill('#list input[type=search]', 'zzz-nothing');
    await page.locator('#list .empty', { hasText: 'Nothing matches' }).waitFor();
    await page.fill('#list input[type=search]', '');
    await page.click('#list .seg button:has-text("Activity")');
    await page.locator('#list .card').first().waitFor();
    await fits(page, `${width} activity`);
    await page.click('#list .seg button:has-text("Threads")');
    await row.click();
    await page.locator('#screen .line').first().waitFor();
    assert.equal(await paneName(page), 'alpha:1 · shell');
    // A line as wide as the terminal wraps on the phone instead of scrolling sideways.
    const said = `phone-says-hi-${width}-${'x'.repeat(200)}`;
    await page.fill('#prompt textarea', `echo ${said}`);
    await page.click('#prompt button.primary');
    await page.waitForFunction(s => document.querySelector('#screen').textContent.replace(/\s/g, '').split(s).length > 2, said, { timeout: 15000 });
    const sideways = () => page.evaluate(() => { const s = document.querySelector('#screen'); return s.scrollWidth - s.clientWidth; });
    assert.ok(await sideways() <= 0, `${width}: wrapped lines don't scroll sideways`);
    assert.ok(await page.locator('#keys').isHidden(), 'The keys start folded');
    if (width < 900) assert.ok(await page.locator('#tabs').isHidden(), 'Phone: an agent has the whole screen, no tab bar');
    await fits(page, `${width} pane`);
    await page.click('#keys-btn');
    await page.locator('#keys').waitFor();
    await fits(page, `${width} pane keys`);
    // The keyboard types straight into the pane, and Ctrl holds for one key.
    const typed = `typed-${width}`;
    await page.locator('#keys .type').pressSequentially(`echo ${typed}`);
    await page.locator('#keys [data-key=enter]').click();
    await page.waitForFunction(w => document.querySelector('#screen').textContent.split(w).length > 2, typed, { timeout: 15000 });
    await page.locator('#keys [data-key=ctrl]').click();
    assert.equal(await page.locator('#keys [data-key=ctrl]').getAttribute('aria-pressed'), 'true');
    await page.locator('#keys [data-key=end]').click();
    assert.equal(await page.locator('#keys [data-key=ctrl]').getAttribute('aria-pressed'), 'false', 'Ctrl lets go after one key');
    await page.locator('#keys [data-key=fn]').click();
    await page.locator('#keys [data-key=f12]').waitFor();
    await fits(page, `${width} pane keys fn`);
    await page.locator('#keys [data-key=fn]').click();
    await page.click('#keys-btn');
    await page.locator('#keys').waitFor({ state: 'hidden' });
    await page.click('#more');
    await sheetButton(page, "Don't wrap long lines").click();
    await page.waitForFunction(() => !document.querySelector('#screen').classList.contains('wrap'));
    if (width < 600) assert.ok(await sideways() > 0, `${width}: unwrapped, the wide line scrolls sideways`);
    await page.click('#more');
    await sheetButton(page, 'Wrap long lines').click();
    await page.waitForFunction(() => document.querySelector('#screen').classList.contains('wrap'));
    await page.click('#more');
    await sheetButton(page, 'Older lines').waitFor();
    await fits(page, `${width} actions`);
    await sheetButton(page, 'Older lines').click();
    await page.locator('#notice', { hasText: 'Older lines' }).waitFor();
    await page.locator('#notice button', { hasText: 'Back to live' }).click();
    await page.locator('#notice', { hasText: 'Older lines' }).waitFor({ state: 'hidden' });
    // Scrolling up past the screen's top reads the history; back at the bottom, it's live.
    const olderShown = () => page.locator('#notice', { hasText: 'Older lines' }).isVisible();
    await page.locator('#screen').hover();
    for (let i = 0; i < 30 && !(await olderShown()); i++) { await page.mouse.wheel(0, -400); await pause(150); }
    assert.ok(await olderShown(), `${width}: scrolling up reads the history`);
    for (let i = 0; i < 60 && (await olderShown()); i++) { await page.mouse.wheel(0, 800); await pause(150); }
    assert.ok(!(await olderShown()), `${width}: back at the bottom, the screen is live again`);
    if (width >= 900) assert.ok(await page.locator('#list').isVisible(), 'Wide: the list stays beside the pane');
    else {
      assert.ok(!(await page.locator('#list').isVisible()), 'Phone: one view at a time');
      await page.click('#pane .back');
      await row.waitFor();
    }
    await page.click('[aria-label="New thread"]');
    await page.locator('#new form').waitFor();
    await fits(page, `${width} new thread`);
    if (width < 900) await page.click('#new .back');

    // Changes: the thread's git, as the PC's panel shows it.
    writeFileSync(join(repo, 'notes.txt'), `one\ntwo ${width}\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten ${width}\n`);
    writeFileSync(join(repo, `new-${width}.txt`), 'fresh\n');
    await page.click('#tabs a[data-tab=changes]');
    await page.locator('#changes .file', { hasText: 'notes.txt' }).waitFor({ timeout: 20000 });
    await fits(page, `${width} changes`);
    await page.locator('#changes .file', { hasText: 'notes.txt' }).locator('.open').click();
    await page.locator('#diff .hunk').first().waitFor({ timeout: 20000 });
    await fits(page, `${width} diff`);
    // A hunk staged alone: the index holds that change, the tree still has the rest.
    const hunks = await page.locator('#diff .hunk').count();
    await page.locator('#diff .hunk').first().locator('button', { hasText: 'Stage' }).click();
    for (let i = 0; i < 40 && !git('diff', '--cached', '--name-only').stdout.includes('notes.txt'); i++) await pause(250);
    assert.match(git('diff', '--cached', '--name-only').stdout, /notes\.txt/, 'Stage on a hunk stages it');
    if (hunks > 1) assert.match(git('diff', '--name-only').stdout, /notes\.txt/, 'The other hunk stays unstaged');
    if (width < 900) await page.click('#diff .back');
    await page.locator('#changes .file', { hasText: `new-${width}.txt` }).waitFor();
    await page.locator('#changes .file', { hasText: `new-${width}.txt` }).locator('.icon-btn').click();
    await sheetButton(page, 'Stage').click();
    for (let i = 0; i < 40 && !git('diff', '--cached', '--name-only').stdout.includes(`new-${width}.txt`); i++) await pause(250);
    assert.match(git('diff', '--cached', '--name-only').stdout, new RegExp(`new-${width}`), 'A file stages from its menu');
    await page.fill('#changes .composer textarea', `phone commit ${width}`);
    await page.click('#changes .composer button:has-text("Commit") >> nth=0');
    for (let i = 0; i < 40 && !git('log', '--oneline', '-1').stdout.includes(`phone commit ${width}`); i++) await pause(250);
    assert.match(git('log', '--oneline', '-1').stdout, new RegExp(`phone commit ${width}`), 'Commit commits');
    assert.equal(git('status', '--porcelain').stdout.trim(), '', 'All changes went in');
    await page.locator('#changes .commit-row', { hasText: `phone commit ${width}` }).waitFor();
    await page.locator('#changes .commit-row', { hasText: `phone commit ${width}` }).locator('.open').click();
    await page.locator('#diff .commit-head').waitFor({ timeout: 20000 });
    await fits(page, `${width} commit`);
    if (width < 900) await page.click('#diff .back');
    await page.click('#changes [aria-label="Git actions"]');
    await sheetButton(page, 'Switch branch').waitFor();
    await fits(page, `${width} git actions`);
    await sheetButton(page, 'Cancel').click();
    await sheetDone(page);

    await page.click('#tabs a[data-tab=usage]');
    await page.locator('#usage .provider').first().waitFor();
    await fits(page, `${width} usage`);
    await page.click('#tabs a[data-tab=settings]');
    await page.locator('#settings .group').first().waitFor({ timeout: 20000 });
    await fits(page, `${width} settings`);
    await page.locator('#settings .setting', { hasText: 'Theme' }).locator('button').click();
    await page.locator('#sheet.on .swatch').first().waitFor();
    await fits(page, `${width} themes`);
    await sheetButton(page, 'Cancel').click();
    await sheetDone(page);
    await page.locator('#settings .setting', { hasText: 'Task manager' }).locator('button').click();
    await page.locator('#sheet.on .proc', { hasText: 'loom' }).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(250); // the sheet's way in
    await fits(page, `${width} task manager`);
    await sheetButton(page, 'Close').click();
    await sheetDone(page);
    await page.context().close();
    console.log(`PASS ${width} px: threads, finding, folding, thread menu, activity, pane, wrapping, keyboard, send, actions, older lines and scrolling back, new thread, changes (hunk, stage, commit, log), usage, settings, task manager`);
  }

  // Git from the phone and loomctl: refusals without --yes, branches, stashes, discard, PR without GitHub.
  page = await context(375, phoneToken);
  const tid = ok('--json', 'threads').json[0].id;
  assert.match(loomctl('git', tid, 'discard', 'notes.txt').err, /--yes/, 'Discarding asks for --yes');
  assert.match(loomctl('git', tid, 'reset', 'HEAD', '--hard').err, /--yes/, 'A hard reset asks for --yes');
  let status = ok('--json', 'git', tid).json;
  assert.ok(Array.isArray(status.unstaged) && Array.isArray(status.commits) && status.commits.length >= 2, 'git status gives sections and commits');
  writeFileSync(join(repo, 'notes.txt'), 'thrown away\n');
  await page.goto(`${base}#/changes/${encodeURIComponent(tid)}`);
  await page.locator('#changes .file', { hasText: 'notes.txt' }).locator('.icon-btn').click();
  await sheetButton(page, 'Discard changes').click();
  await sheetButton(page, 'Discard').click();
  for (let i = 0; i < 40 && git('status', '--porcelain').stdout.trim(); i++) await pause(250);
  assert.equal(git('status', '--porcelain').stdout.trim(), '', 'Discard, after its confirmation, restores the file');
  await page.click('#changes [aria-label="Git actions"]');
  await sheetButton(page, 'Switch branch').click();
  await sheetButton(page, 'New branch').click();
  await page.locator('#sheet.on input').fill('phone-branch');
  await sheetButton(page, 'Create and switch').click();
  for (let i = 0; i < 40 && git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() !== 'phone-branch'; i++) await pause(250);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'phone-branch', 'A new branch from the phone');
  writeFileSync(join(repo, 'stash-me.txt'), 'later\n');
  await page.click('#changes [aria-label="Git actions"]');
  await sheetButton(page, 'Stash all changes').click();
  for (let i = 0; i < 40 && !git('stash', 'list').stdout.trim(); i++) await pause(250);
  assert.match(git('stash', 'list').stdout, /loom alpha/, 'Stash all changes stashes');
  await page.click('#changes [aria-label="Git actions"]');
  await sheetButton(page, 'Restore a stash').click();
  await sheetButton(page, 'stash@{0}').click();
  for (let i = 0; i < 40 && !existsSync(join(repo, 'stash-me.txt')); i++) await pause(250);
  assert.ok(existsSync(join(repo, 'stash-me.txt')), 'Restoring a stash brings its files back');
  await page.click('#changes [aria-label="Git actions"]');
  await sheetButton(page, 'Create PR').click();
  await page.locator('#toast.error', { hasText: 'not on GitHub' }).waitFor();
  rmSync(join(repo, 'stash-me.txt'));
  git('stash', 'drop');
  console.log('PASS git from the phone: discard after asking, a new branch, stash and restore, PR needs GitHub, loomctl refuses loss without --yes');

  // Settings change the PC: sound, the theme (which the phone wears), text size, the agents list.
  await page.goto(`${base}#/settings`);
  await page.locator('#settings .group').first().waitFor({ timeout: 20000 });
  const sound = ok('--json', 'set').json.sound;
  await page.locator('#settings .setting', { hasText: 'Sound' }).locator('.switch').click();
  for (let i = 0; i < 40 && ok('--json', 'set').json.sound === sound; i++) await pause(250);
  assert.notEqual(ok('--json', 'set').json.sound, sound, 'The sound switch sets it on the PC');
  await page.locator('#settings .setting', { hasText: 'Theme' }).locator('button').click();
  await page.locator('#sheet.on .swatch', { hasText: 'nord' }).click();
  for (let i = 0; i < 40 && !ok('--json', 'theme').json.find(t => t.current)?.name.startsWith('nord'); i++) await pause(250);
  assert.equal(ok('--json', 'theme').json.find(t => t.current).name, 'nord', 'The theme changes on the PC');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg').trim() !== '');
  const font = Number(ok('--json', 'set').json.font);
  await page.click('#settings [aria-label="Larger"]');
  for (let i = 0; i < 40 && Number(ok('--json', 'set').json.font) === font; i++) await pause(250);
  assert.equal(Number(ok('--json', 'set').json.font), font + 1, 'Text size goes up on the PC');
  await page.fill('#settings input[aria-label=Name]', 'phone-tool');
  await page.fill('#settings input[aria-label=Command]', 'cmd /k echo phone');
  await page.click('#settings form button.primary');
  for (let i = 0; i < 40 && !ok('--json', 'startups').json.some(s => s.label === 'phone-tool'); i++) await pause(250);
  assert.ok(ok('--json', 'startups').json.some(s => s.label === 'phone-tool' && s.cmd === 'cmd /k echo phone'), 'A new agent to start');
  await page.click('#settings [aria-label="Remove phone-tool"]');
  for (let i = 0; i < 40 && ok('--json', 'startups').json.some(s => s.label === 'phone-tool'); i++) await pause(250);
  assert.ok(!ok('--json', 'startups').json.some(s => s.label === 'phone-tool'), 'And removed');
  ok('theme', 'loom');
  ok('set', 'font', String(font));
  ok('set', 'sound', sound);
  await page.context().close();
  console.log('PASS settings from the phone: sound, theme on the PC and the phone, text size, agents to start');

  // Creating and closing threads from the phone.
  page = await context(375, phoneToken);
  git('switch', '-q', trunk);
  await page.goto(base + '#/new');
  await page.locator('#new form').waitFor();
  await page.selectOption('#new select[name=project]', repo);
  await page.fill('#new input[name=name]', 'phone-wt');
  await page.selectOption('#new select[name=agent]', 'cmd');
  await page.click('#new button.primary');
  await page.waitForFunction(() => document.querySelector('#pane .who b')?.textContent.endsWith('· shell') && location.hash.startsWith('#/pane/'), null, { timeout: 60000 });
  let threads = ok('--json', 'threads').json;
  const wt = threads.find(t => t.branch === 'loom/phone-wt');
  assert.ok(wt, `A worktree thread on loom/phone-wt: ${JSON.stringify(threads.map(t => t.branch))}`);
  await page.goto(base);
  await page.locator('#list .thread', { has: page.locator('.thread-head .name', { hasText: 'phone-wt' }) }).locator('.thread-top .icon-btn').click();
  await sheetButton(page, 'Close the thread').click();
  await sheetButton(page, 'Close thread').click();
  for (let i = 0; i < 20 && ok('--json', 'threads').json.length !== 1; i++) await pause(250);
  assert.equal(ok('--json', 'threads').json.length, 1, 'Closing the thread from the phone closes it');
  await page.goto(base + '#/new');
  await page.selectOption('#new select[name=project]', '');
  await page.fill('#new input[name=folder]', plain);
  await page.click('#new [data-kind=checkout]');
  assert.ok(!(await page.locator('#new input[name=name]').isVisible()), 'This folder needs no name');
  await page.selectOption('#new select[name=agent]', 'cmd');
  await page.click('#new button.primary');
  await page.waitForFunction(() => location.hash.startsWith('#/pane/'), null, { timeout: 60000 });
  threads = ok('--json', 'threads').json;
  assert.ok(threads.some(t => t.dir === plain), 'This folder opens as a thread');
  ok('close-thread', threads.find(t => t.dir === plain).id, '--yes');
  console.log('PASS a worktree thread and a folder thread from the phone, and closing a thread');

  // Fitting Loom to the phone narrows the pane, and back.
  await page.goto(base);
  await alpha(page).locator('.agent').click();
  await page.locator('#screen .line').first().waitFor();
  const cols = () => ok('--json', 'read', 'alpha:1').json.cols;
  const wide = cols();
  await page.click('#more');
  await sheetButton(page, 'Fit Loom to phone').click();
  await page.locator('#toast', { hasText: 'fits the phone' }).waitFor();
  for (let i = 0; i < 20 && cols() >= wide; i++) await pause(250);
  const narrow = cols();
  assert.ok(narrow < wide && narrow <= 60, `Phone size narrows the pane: ${wide} to ${narrow} columns`);
  assert.equal(ok('--json', 'status').json.phone, true);
  // The page reads the narrower screen and drops its "wider than this screen" notice.
  await page.locator('#notice').waitFor({ state: 'hidden' });
  await fits(page, '375 pane fitted');
  await page.click('#more');
  await sheetButton(page, 'Desktop size on the PC').click();
  await page.locator('#toast', { hasText: 'desktop size' }).waitFor();
  assert.equal(ok('--json', 'status').json.phone, false);
  console.log(`PASS fitting Loom to the phone: ${wide} to ${narrow} columns, and back`);

  // Renaming from the thread's menu.
  await page.goto(base);
  await alpha(page).locator('.thread-top .icon-btn').click();
  await sheetButton(page, 'Rename').click();
  await page.locator('#sheet.on input').fill('alpha-renamed');
  await sheetButton(page, 'Rename').click();
  for (let i = 0; i < 20 && ok('--json', 'threads').json[0].name !== 'alpha-renamed'; i++) await pause(250);
  assert.equal(ok('--json', 'threads').json[0].name, 'alpha-renamed');
  await page.locator('#list .thread-head .name', { hasText: 'alpha-renamed' }).waitFor();
  console.log('PASS renaming a thread from its menu');

  // Restarting from the phone's Settings: Loom closes safely, starts again on
  // the same profile with its threads, and the page reloads from the new one.
  const before = ok('--json', 'status').json.booted;
  const was = ok('--json', 'threads').json[0].panes[0];
  assert.match(was.stableId ?? '', /^[0-9a-f-]{36}$/, 'each pane has a stableId');
  await page.goto(`${base}/#/settings`);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  const reloaded = page.waitForEvent('load', { timeout: 90000 });
  await sheetButton(page, 'Restart').click();
  await page.locator('#offline', { hasText: 'Loom is restarting on the PC' }).waitFor();
  await reloaded;
  const after = ok('--json', 'status').json;
  assert.ok(after.booted > before, 'a new Loom answers');
  assert.equal(after.updated, false, 'nothing replaced its exe');
  assert.equal(ok('--json', 'threads').json[0].name, 'alpha-renamed', 'its threads came back');
  await page.locator('#settings .group').first().waitFor();
  // The new Loom was started by the old one: find it, so the steps below stop it.
  const pids = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='loom.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' }).ProcessId`], { encoding: 'utf8' })
    .stdout.trim().split(/\s+/).map(Number).filter(Boolean);
  assert.equal(pids.length, 1, 'one Loom on the profile: the old one has gone');
  child = { pid: pids[0] };
  // The pane came back with a new id and the stableId saved with it, and a notification's link from
  // before the restart finds it by that.
  const back = ok('--json', 'threads').json[0].panes[0];
  assert.notEqual(back.id, was.id, 'a new id');
  assert.equal(back.stableId, was.stableId, 'the same stableId');
  await page.goto(`${base}/#/pane/${encodeURIComponent(was.id)}/${encodeURIComponent(was.ref)}/${was.stableId}`);
  await page.waitForFunction(h => location.hash === h, `#/pane/${encodeURIComponent(back.id)}/${encodeURIComponent(back.ref)}/${was.stableId}`, { timeout: 15000 });
  assert.ok((await paneName(page)).startsWith(back.ref));
  console.log('PASS restarting Loom from the phone: it closes, starts again on its profile, and the page reloads from it; a pane keeps its stableId and an old link finds it');

  // Revoked, the page asks to pair again.
  ok('remote', 'revoke');
  await page.locator('#pairing').waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('loom-token')), null);
  await page.context().close();
  console.log('PASS revoke unpairs the phone');

  // It starts again with Loom, and off lets the port go.
  kill();
  await pause(1500);
  await launch();
  for (let i = 0; i < 20 && (await fetch(base + '/').then(r => r.status).catch(() => 0)) !== 200; i++) await pause(250);
  assert.equal((await fetch(base + '/')).status, 200, 'A Loom restarted with the remote on listens again');
  ok('remote', 'off');
  assert.equal(await fetch(base + '/').then(() => 'answered').catch(() => 'refused'), 'refused');
  assert.match(ok('remote').out, /^Off/);
  console.log('PASS the remote comes back with Loom, and off closes the port');
} finally {
  await browser?.close().catch(() => {});
  if (child) kill();
  for (const s of shared) {
    if (s.had) copyFileSync(s.backup, s.file);
    else rmSync(s.file, { force: true });
  }
  await pause(1000);
  spawnSync('git', ['-C', repo, 'worktree', 'prune']);
  for (const target of [join(homedir(), 'loom', repoName), dir]) {
    for (let i = 0; ; i++) {
      try { rmSync(target, { recursive: true, force: true }); break; } catch (e) {
        if (i === 10) { console.log('Could not remove', target, e.code); break; }
        await pause(1000);
      }
    }
  }
}
