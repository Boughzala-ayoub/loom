// The phone page from dist/ in headless Chrome, with only /api mocked: every
// view at 320 to 1280 px (and 901, just past the two-column breakpoint) must
// fit its width, and the regressions from the phone remote review stay fixed:
// late git replies, a cut-off answer to a change, Activity drafts, the startup
// list, Cancel, and sends or hunk actions that complete after you moved on.
// Notifications on this phone: the real service worker gets a push through
// the DevTools protocol (headless Chrome can't reach a push service, so only
// the subscription is made up) and a tap opens the agent.
// Run `npm run build` first. Screenshots go to
// node_modules/.cache/remote-ui-check. Set PLAYWRIGHT_MODULE to an installed
// playwright module path if it isn't local, and REMOTE_DIST to serve a build
// other than dist/.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const out = resolve('node_modules/.cache/remote-ui-check');
mkdirSync(out, { recursive: true });
const dist = resolve(process.env.REMOTE_DIST || 'dist');
const server = createServer((req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    // remote.rs serves these two from outside dist/.
    const file = path === '/sw.js' ? resolve('src-tauri/src/remote-sw.js') : path === '/icon.png' || path === '/badge.png' ? resolve(`src-tauri/icons${path}`)
      : resolve(dist, path === '/' ? 'remote.html' : path.slice(1));
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.statusCode = 404; res.end('missing'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
assert.equal((await fetch(base)).status, 200, 'the page must be served');
console.log('HTTP 200, bundle', readFileSync(resolve(dist, 'remote.html'), 'utf8').match(/assets\/remote-[^" ]+\.js/)[0]);
// A fake microphone (a beep) that needs no prompt: the phone's dictation records from it.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

const pause = ms => new Promise(r => setTimeout(r, ms));
// Two pictures as a phone hands them over, drawn by Chrome: a PNG screenshot and a JPEG photo.
const [PNG, JPG] = await (async () => {
  const page = await browser.newPage();
  const urls = await page.evaluate(() => ['image/png', 'image/jpeg'].map((type, i) => {
    const c = document.createElement('canvas');
    Object.assign(c, { width: 360, height: 240 });
    const g = c.getContext('2d');
    g.fillStyle = i ? '#3a6ea5' : '#d97757';
    g.fillRect(0, 0, 360, 240);
    g.fillStyle = '#fff';
    g.font = 'bold 72px sans-serif';
    g.fillText(i ? 'JPEG' : 'PNG', 40, 150);
    return c.toDataURL(type, 0.9);
  }));
  await page.close();
  return urls.map(url => ({ url, buffer: Buffer.from(url.split(',')[1], 'base64') }));
})();
const files = (...pics) => pics.map((pic, i) => ({ name: `shot-${i}.${pic === JPG ? 'jpg' : 'png'}`, mimeType: pic === JPG ? 'image/jpeg' : 'image/png', buffer: pic.buffer }));
async function until(what, f, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(25)) if (await f()) return;
  assert.fail(`timed out: ${what}`);
}
function thread(id, name, agent = 'claude') {
  return { id, name, repo: `C:/projects/${name}`, dir: `C:/projects/${name}`, branch: `loom/${name}`, state: 'idle', layout: 'cols', zoomed: null, front: id === 'a', changed: { add: 2, del: 1, files: 3 },
    panes: [{ id: `${id}1`, ref: `${name}:1`, sid: `s-${id}1`, stableId: `k-${id}1`, threadId: id, agent, state: 'idle', title: 'A long agent task title for the phone', lastOutput: '2026-10-06T10:00:00.000Z', model: 'sonnet[1m]', notify: 'inherit', context: { usedTokens: 20000, windowTokens: 200000, remainingPercent: 90 } }] };
}
const file = (path, x = ' ', y = 'M') => ({ path, x, y, add: 2, del: 1 });
const own = id => (id === 'a' ? 'alpha' : 'beta');
const status = id => ({ thread: id, name: id === 'a' ? 'Alpha' : 'Beta', branch: `loom/${id}`, upstream: `origin/loom/${id}`, ahead: 1, behind: 1, midway: 'rebase',
  staged: [file('staged.txt', 'M', ' ')], unstaged: [file(`${own(id)}.txt`), file('conflict.txt', 'U', 'U')], untracked: [file('new.txt', '?', '?')],
  commits: [{ sha: 'abc1234', subject: 'A recent commit message with a useful description' }] });
const question = pane => ({ question: ['May I change this file?'], options: ['Yes, go ahead', 'No, keep it'], keys: ['1', '2'], rev: `menu-${pane}` });
const patch = name => `diff --git a/${name} b/${name}\nindex 1234567..7654321 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old ${name}\n+new ${name}\n`;
// The PC as procs.rs reads it, protected processes with numbers too: chrome × 34, 60 svchosts, a name 60
// characters long, and a CPU that moves with each read (state.procsReads counts them).
const LONG = 'Contoso.Enterprise.Synchronization.BackgroundWorkersHost.x64';
assert.equal(LONG.length, 60);
const MB = 2 ** 20;
function reading(state) {
  const n = (state.procsReads = (state.procsReads ?? 0) + 1);
  return { cpu: 20 + (n % 4) * 9.5, memory: { used: 13.3 * 1024 * MB, total: 15.6 * 1024 * MB, commit: 29.3 * 1024 * MB, limit: 47.6 * 1024 * MB }, uptime: 3 * 86400 + 4 * 3600 + 120,
    procs: [
      ...Array.from({ length: 34 }, (_, i) => ({ pid: 1000 + i, name: 'chrome.exe', cpu: 0.6, memory: (40 + i) * MB })),
      { pid: 4, name: 'System', cpu: 0.4, memory: 12288 }, // 12 KB
      { pid: 236, name: 'Secure System', cpu: 0, memory: 66 * MB },
      { pid: 3960, name: 'Memory Compression', cpu: 0, memory: 215 * MB },
      { pid: 6396, name: 'MsMpEng.exe', cpu: 1.8, memory: 387 * MB },
      { pid: 7001, name: `${LONG}.exe`, cpu: 12.3, memory: 2.2 * 1024 * MB },
      ...Array.from({ length: 60 }, (_, i) => ({ pid: 2000 + i * 4, name: 'svchost.exe', cpu: i % 7 ? 0 : 0.1, memory: (2 + (i % 9)) * MB })),
      { pid: 9001, name: 'loom.exe', cpu: 2.2, memory: 310 * MB },
    ] };
}
// The servers the panes run, as the strip reads them: a long name first (the widest strip, in every view),
// and a five-digit port.
const SERVER = 'Contoso.Enterprise.Synchronization';
const SERVERS = [{ port: 3000, pane: 'a1', name: SERVER }, { port: 8000, pane: 'b1', name: 'python' }, { port: 45678, pane: 'b1', name: 'node' }];
// The phones paired with Loom (loomctl remote's devices): this one, whose id is the start of its token's SHA-256
// as remote.rs keeps it, one with a long name, and one paired before Loom kept names and times.
const MINE = createHash('sha256').update('fixture-token').digest('hex').slice(0, 12);
const PHONE = 'Samsung Galaxy S24 Ultra · Chrome 141 on Android 15 (work profile)';
const DEVICES = () => [
  { id: 'a1b2c3d4e5f6', name: PHONE, paired: Date.now() - 40 * 864e5, seen: Date.now() - 3 * 36e5, push: true },
  { id: MINE, name: 'Pixel 8 · Chrome', paired: Date.now() - 3 * 864e5, seen: Date.now(), push: true },
  { id: '0f9e8d7c6b5a', name: '', paired: null, seen: null, push: false },
];
/** What loomctl's parseArgs (src/cli.ts) reads from a git call: its words, and the --options before a bare --. */
function parsed(argv) {
  const at = argv.indexOf('--'), head = at < 0 ? argv : argv.slice(0, at);
  return { words: [...head.filter(w => !w.startsWith('--')), ...(at < 0 ? [] : argv.slice(at + 1))], flags: head.filter(w => w.startsWith('--')) };
}
// Two of the PC's own themes (main.ts THEMES), dark and light, as loomctl theme hands them to the phone.
const mainTs = readFileSync('src/main.ts', 'utf8');
const palette = label => JSON.parse(mainTs.match(new RegExp(`label: "${label}",[\\s\\S]*?vars: (\\{[^}]*\\})`))[1].replace(/,\s*\}$/, '}'));

/** A page whose /api answers like Loom. `hold` keeps a `git <thread> <action>` reply until state.held[it]() runs. */
// RFC 8291's example public key: any P-256 point does for a subscription that is made up.
const PUSH_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
/** push: true for a phone that may get notifications, 'old-key' for one subscribed before Loom's key changed. */
async function context(width, token = true, push = false) {
  const state = { calls: [], changedTitle: false, startups: [{ label: 'Claude', cmd: 'claude' }, { label: 'Codex', cmd: 'codex' }], hold: new Set(), held: {}, corruptSend: false, refuseSend: false, errors: [], push: { on: false, sub: null }, booted: 1, updated: false, restarts: 0, zoomed: new Set(),
    // The PC's mic menu (main.ts langs, prefixes), and what the mocked whisper hears in each clip posted to /api/dictate.
    dictation: { langs: [{ label: 'English', code: 'en', on: true }, { label: 'auto', code: '', on: false }, { label: 'French', code: 'fr', on: false }], prefixes: [{ text: '/prompt ', enter: false, on: true }, { text: '', enter: false, on: false }] },
    heard: 'run the tests', clips: [],
    // What reached /api/image, and failImage: Loom refuses the next one.
    images: [] };
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, permissions: ['microphone'] });
  if (token) await ctx.addInitScript(() => localStorage.setItem('loom-token', 'fixture-token'));
  // The microphone, watched: how long MediaRecorder ran (window.recorded), the stream the page got (window.opened),
  // and getUserMedia held open while window.holdMic, until window.releaseMic(). Faults: window.failStart, an
  // encoder that refuses to start; window.endBeforeStart, a stream whose tracks end before recording begins.
  await ctx.addInitScript(() => {
    const { start, stop } = MediaRecorder.prototype;
    // window.delayStop: a recorder made while it is set fires its stop event that many ms late.
    const onstop = Object.getOwnPropertyDescriptor(MediaRecorder.prototype, 'onstop');
    Object.defineProperty(MediaRecorder.prototype, 'onstop', { configurable: true, get() { return onstop.get.call(this); }, set(fn) {
      const late = window.delayStop || 0;
      onstop.set.call(this, fn && (e => setTimeout(() => fn.call(this, e), late)));
    } });
    MediaRecorder.prototype.start = function (...a) {
      if (window.failStart) throw new DOMException('The encoder could not start', 'NotSupportedError');
      window.recorded = { at: performance.now() };
      return start.apply(this, a);
    };
    MediaRecorder.prototype.stop = function (...a) { if (window.recorded) window.recorded.ms = performance.now() - window.recorded.at; return stop.apply(this, a); };
    const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => {
      const s = await ask(c);
      window.opened = s;
      if (window.holdMic) await new Promise(r => (window.releaseMic = r));
      if (window.endBeforeStart) s.getTracks().forEach(t => t.stop());
      return s;
    };
  });
  if (push) {
    await ctx.grantPermissions(['notifications'], { origin: base });
    // Headless Chrome can't reach a push service: the subscription is made up, the worker is real.
    await ctx.addInitScript(oldKey => {
      const made = (endpoint, key) => ({ endpoint, options: { applicationServerKey: key },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; }, async unsubscribe() { sub = null; sessionStorage.removeItem('test-sub-key'); return true; } });
      // Kept across reloads, as a browser keeps it. 'old-key': one made with a key Loom has since replaced.
      const kept = sessionStorage.getItem('test-sub-key');
      let sub = kept ? made('https://push.example/sub/1', Uint8Array.from(kept.split(',').map(Number)).buffer)
        : oldKey ? made('https://push.example/sub/old', new Uint8Array(65).fill(4).buffer) : null;
      PushManager.prototype.subscribe = async function (o) {
        sessionStorage.setItem('test-subscribes', String(Number(sessionStorage.getItem('test-subscribes') ?? 0) + 1));
        sessionStorage.setItem('test-sub-key', Array.from(new Uint8Array(o.applicationServerKey)).join());
        return (sub = made('https://push.example/sub/1', new Uint8Array(o.applicationServerKey).buffer));
      };
      PushManager.prototype.getSubscription = async function () { return sub; };
    }, push === 'old-key');
  }
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    // A clip: 16-bit samples at 16 kHz, so 32 KB a second; an empty one only warms the model.
    if (new URL(req.url()).pathname === '/api/dictate') {
      const body = req.postDataBuffer() ?? Buffer.alloc(0);
      const samples = new Int16Array(body.buffer, body.byteOffset, body.length >> 1);
      const clip = { bytes: body.length, lang: new URL(req.url()).searchParams.get('lang'), auth: req.headers().authorization, peak: samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0) };
      state.clips.push(clip);
      if (state.revoked) return route.fulfill({ status: 401, json: { ok: false, error: 'Pair this phone again.' } });
      if (body.length && state.hold.delete('dictate')) await new Promise(r => (state.held.dictate = r));
      // dictateDelay: the clip takes that long to arrive and be heard (a slow uplink); an aborted one gets no answer.
      if (body.length && state.dictateDelay) await pause(state.dictateDelay);
      // failNext: whisper fails on the next clip.
      if (body.length && state.failNext) {
        state.failNext = false;
        await route.fulfill({ json: { ok: false, error: 'whisper failed' } });
        return void (clip.answered = true);
      }
      // heard: the text, or a function of the clip's size that ties each text to its recording.
      await route.fulfill({ json: { ok: true, text: body.length ? (typeof state.heard === 'function' ? state.heard(body.length) : state.heard) : '' } }).catch(() => {});
      return void (clip.answered = true);
    }
    // An image: its bytes as the body, its path on the PC as the answer (remote.rs image).
    if (new URL(req.url()).pathname === '/api/image') {
      const n = state.images.push({ bytes: req.postDataBuffer() ?? Buffer.alloc(0), type: req.headers()['content-type'], auth: req.headers().authorization });
      if (state.hold.delete('image')) await new Promise(r => (state.held.image = r));
      // imageDelay: the body takes that long to arrive (a slow uplink), and an aborted upload gets no answer.
      if (state.imageDelay) await pause(state.imageDelay);
      if (state.failImage) { state.failImage = false; return route.fulfill({ status: 415, json: { ok: false, error: 'Loom takes PNG, JPEG, WebP and GIF images.' } }); }
      return route.fulfill({ json: { ok: true, path: `C:\\Users\\test\\AppData\\Roaming\\dev.ayoub.loom\\phone-images\\${n}-ab12cd34.png` } }).catch(() => {});
    }
    const c = req.postDataJSON();
    state.calls.push(c);
    // loomctl takes --commits=N out of the words; the phone sends it before every git action.
    if (c.cmd === 'git' && Array.isArray(c.argv) && /^--commits=\d+$/.test(c.argv[1])) c.commits = +c.argv.splice(1, 1)[0].slice(10);
    if (req.url().endsWith('/pair')) return route.fulfill({ json: { ok: true, token: 'fixture-token' } });
    // revoked: this phone was unpaired on the PC, so every call answers 401.
    if (state.revoked) return route.fulfill({ status: 401, json: { ok: false, error: 'Pair this phone again.' } });
    if (req.url().endsWith('/api/push')) {
      if (c.off) state.push = { on: false, sub: null };
      if (c.subscription) state.push = { on: true, sub: c.subscription };
      return route.fulfill({ json: { ok: true, key: PUSH_KEY, on: state.push.on } });
    }
    if (typeof c.cmd !== 'string' || !Array.isArray(c.argv) || !c.argv.every(v => typeof v === 'string')) return route.fulfill({ status: 400, json: { ok: false, error: 'Send a command, its words, and optionally stdin and a key.' } });
    if (c.cmd === 'send' || c.cmd === 'submit') {
      if (state.hold.delete('submit')) await new Promise(r => (state.held.submit = r));
      // The change ran, then the connection broke in the middle of its answer.
      if (state.corruptSend) { state.corruptSend = false; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":' }); }
      if (state.refuseSend) { state.refuseSend = false; return route.fulfill({ json: { ok: false, error: 'That pane is busy.' } }); }
      // loseAcks: Loom takes the next one, but every answer to its key, the retries' too, breaks off.
      if (state.loseAcks === true) state.loseAcks = c.key;
      if (state.loseAcks && c.key === state.loseAcks) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":' });
    }
    // failThreads: the next that many reads of the threads never reach Loom; offline: nothing does.
    if (state.offline || (c.cmd === 'threads' && state.failThreads > 0)) { state.failThreads--; return route.abort('failed'); }
    if (c.cmd === 'threads' && state.hold.delete('threads')) await new Promise(r => (state.held.threads = r));
    // Every threads read waits while blocked: unblock() lets them all go.
    if (c.cmd === 'threads' && state.blocked) await new Promise(r => state.blocked.push(r));
    // A command's next reply waits for state.held[cmd]() (menu, status). An agent's question comes with
    // its screen (read --menu), so holding menu holds that read.
    const holdAs = c.cmd === 'read' && c.argv.includes('--menu') ? 'menu' : c.cmd;
    if (holdAs !== 'show' && state.hold.delete(holdAs)) await new Promise(r => (state.held[holdAs] = r));
    let data;
    const threads = [thread('a', 'Alpha'), thread('b', 'Beta', 'codex')];
    if (state.omp) threads[1].panes[0].agent = 'omp';
    // siblings: Alpha:2 runs Codex (sameKind: a second Claude) beside Alpha:1's Claude. closeFirst: Alpha:1 closed
    // on the PC, so the sibling is Alpha:1 now.
    if (state.siblings) {
      threads[0].panes.push({ ...threads[0].panes[0], id: 'a2', ref: 'Alpha:2', sid: state.sharedSid ? 's-a1' : 's-a2', stableId: 'k-a2', agent: state.sameKind ? 'claude' : 'codex' });
      if (state.closeFirst) { threads[0].panes.shift(); threads[0].panes[0].ref = 'Alpha:1'; }
    }
    if (state.added) threads[0].panes.push({ ...threads[0].panes[0], id: 'a3', ref: 'Alpha:2', sid: 's-a3', stableId: 'k-a3' }); // added on the PC
    if (state.renamed) { threads[0].name = 'Renamed'; threads[0].panes[0].ref = 'Renamed:1'; }
    // Another thread named Alpha: its Claude is Alpha:1 too.
    if (state.twins) threads.push(thread('c', 'Alpha'));
    // extra: that many more threads, a list longer than the screen.
    for (let i = 0; i < (state.extra ?? 0); i++) threads.push(thread(`x${i}`, `Extra${i}`));
    if (state.changedTitle) threads[1].panes[0].title = 'Another agent has changed its title';
    if (state.shell) threads[1].panes[0].agent = 'shell';
    // Loom restarted on the PC (restartPc): the same agents, with new pane ids and the sids saved with them.
    if (state.newIds) for (const t of threads) t.panes[0].id = `new-${t.panes[0].id}`;
    // again: restarted that many times more (new-a1, again-new-a1, again-again-new-a1).
    if (state.again) for (const t of threads) t.panes[0].id = 'again-'.repeat(state.again) + t.panes[0].id;
    // A pane closed on the PC, or from before a restart, isn't Loom's (main.ts cliPane).
    if ((c.cmd === 'send' || c.cmd === 'submit') && !threads.some(t => t.panes.some(p => p.id === c.argv[0]))) return route.fulfill({ json: { ok: false, error: `No thread "${c.argv[0]}". loomctl threads lists them.` } });
    switch (c.cmd) {
      case 'status': data = { phone: !!state.phone, agents: state.startups.map(s => s.label), booted: state.booted, updated: state.updated }; break;
      case 'window': if (c.argv[0] === 'phone') state.phone = !state.phone; data = { window: c.argv[0], phone: !!state.phone }; break;
      case 'relaunch': {
        // --booted names the Loom to restart (main.ts relaunch): the Loom that replaced it gets a retry
        // with none of the old one's keys, and restarts nothing.
        if (c.argv.includes('--booted') && c.argv[c.argv.indexOf('--booted') + 1] !== String(state.booted)) { data = { stopping: [], booted: state.booted }; break; }
        state.restarts++;
        // Loom takes it and goes: the answer is cut off, and the retry reaches the Loom that replaced it.
        if (state.loseRestartReply) { state.loseRestartReply = false; state.booted++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":' }); }
        // The restarted Loom answers a moment later, started anew.
        if (!state.holdRestart) setTimeout(() => state.booted++, 1500);
        data = { stopping: [], booted: state.booted }; break;
      }
      case 'threads': data = threads; break;
      // zoom toggles; show says whether the pane already fills its thread (main.ts paneData).
      case 'show': state.pcFront = c.argv[0]; data = { zoomed: state.zoomed.has(c.argv[0]) }; break;
      case 'zoom': state.zoomed.delete(c.argv[0]) || state.zoomed.add(c.argv[0]); data = { zoomed: state.zoomed.has(c.argv[0]) }; break;
      case 'messages': data = threads.map(t => ({ pane: t.panes[0].id, user: 'Please review the changes and check the real behavior.', agent: 'The review is ready. This is a sample response.' })); break;
      case 'menu': data = question(c.argv[0]); break;
      case 'read': data = { text: state.screen ?? 'sample screen', cols: 120, rows: [{ runs: [{ x: 0, text: state.screen ?? 'sample screen' }] }], ...(c.argv.includes('--menu') ? { menu: question(c.argv[0]) } : {}) }; break;
      // theme: { name, scheme, vars }, a real palette the PC wears (the default's vars are the page's own).
      case 'theme': data = state.theme ? [{ ...state.theme, current: true }] : ['loom', 'nord', 'light'].map((name, i) => ({ name, scheme: i === 2 ? 'light' : 'dark', current: i === 0, vars: {} })); break;
      // The task manager's reading comes from remote.rs itself, not loomctl (core.ts run's path).
      case 'procs': if (!req.url().endsWith('/api/procs')) return route.fulfill({ status: 404, json: { ok: false, error: 'Not found.' } }); data = reading(state); break;
      // So is the strip's (lib.rs status_reading): servers sorted by port, state.servers or SERVERS, and state.cpu.
      case 'bar': if (!req.url().endsWith('/api/bar')) return route.fulfill({ status: 404, json: { ok: false, error: 'Not found.' } });
        data = { cpu: state.cpu ?? 23.4, memory: { used: 13.3 * 1024 * MB, total: 15.6 * 1024 * MB }, remote: null, servers: state.servers ?? SERVERS }; break;
      // planUsage: the PC's Plan usage, 'on' unless a test turns it off.
      case 'set': if (c.argv[0] === 'plan-usage' && c.argv[1]) state.planUsage = c.argv[1]; data = { sound: 'on', taskbar: 'on', overlay: 'background', awake: 'off', 'plan-usage': state.planUsage ?? 'on', font: '13' }; break;
      case 'notify': data = { all: 'on', kinds: { finish: true, fail: true, blocked: true }, newPanes: 'inherit' }; break;
      // devices: the phones as a newer Loom lists them (an older one has none); revoke <id> removes one, bare all.
      // refuseRevoke: Loom can't save the change.
      case 'remote':
        if (c.argv[0] === 'revoke') {
          if (state.refuseRevoke) return route.fulfill({ json: { ok: false, error: "Loom couldn't save the paired phones." } });
          state.devices = c.argv[1] ? state.devices?.filter(d => d.id !== c.argv[1]) : [];
        }
        data = { phones: state.devices?.length ?? 1, address: 'https://pc.tailnet.example', port: 7420, ...(state.devices ? { devices: state.devices } : {}) }; break;
      case 'trash': data = [{ at: 'C:/Users/test/loom/trash/old-project', branch: 'old-branch' }]; break;
      case 'usage': data = Object.fromEntries(['claude', 'codex'].map(k => [k, { tier: 'pro', fetchedAt: new Date().toISOString(), limits: [{ label: 'session', percent: 35, severity: '', resetsAt: new Date(Date.now() + 3600000).toISOString() }] }])); break;
      case 'context': data = { ctx: c.argv[0] === 'a1' ? 20000 : 55000, est: 0, buckets: [{ label: 'Messages', tokens: 10000 }, { label: 'Tools', tokens: 10000 }], series: [10000, 15000, 20000], drops: [] }; break;
      case 'startups':
        if (c.argv[0] === 'add') state.startups.push({ label: c.argv[1], cmd: c.argv.slice(2).join(' ') });
        if (c.argv[0] === 'remove') state.startups = state.startups.filter(s => s.label !== c.argv[1]);
        data = state.startups; break;
      case 'close-plan': data = { rev: 'plan', lost: { tracked: 1, commits: 1 } }; break;
      case 'dictation': {
        // As main.ts runs it: lang and prefix pick (adding a new one), --enter sets a prefix's ⏎, remove drops one.
        const d = state.dictation, at = c.argv.indexOf('--enter');
        const [how, ...rest] = at < 0 ? c.argv : c.argv.slice(0, at);
        const words = rest.join(' ').trim(), code = words === 'auto' ? '' : words;
        if (how === 'lang') { const l = d.langs.find(x => x.code === code) ?? (d.langs.push({ label: code, code }), d.langs.at(-1)); d.langs.forEach(x => (x.on = x === l)); }
        if (how === 'prefix') {
          const p = d.prefixes.find(x => x.text.trim() === words) ?? (d.prefixes.push({ text: words ? `${words} ` : '', enter: false }), d.prefixes.at(-1));
          if (at >= 0) p.enter = c.argv[at + 1] === 'on';
          d.prefixes.forEach(x => (x.on = x === p));
        }
        if (how === 'remove') {
          const [what, ...name] = rest, list = what === 'lang' ? d.langs : d.prefixes, w = name.join(' ').trim();
          const i = list.findIndex(x => (what === 'lang' ? x.code === (w === 'auto' ? '' : w) : x.text.trim() === w));
          if (i >= 0 && list.length > 1) { const [gone] = list.splice(i, 1); if (gone.on) list[0].on = true; }
        }
        data = d; break;
      }
      case 'git': {
        const [id, action = 'status'] = c.argv;
        const held = `${id} ${action}`;
        if (state.hold.delete(held)) await new Promise(r => (state.held[held] = r));
        if (action === 'diff') data = { diff: patch(`${own(id)}.txt`) };
        else if (action === 'show') data = { diff: `commit abc1234\nAuthor: Tester <test@example.com>\nDate: Tue Oct 6 10:00:00 2026 +0100\n\n    A sample commit\n\n ${own(id)}.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n${patch(`${own(id)}.txt`)}` };
        else if (action === 'files') data = { files: [`${own(id)}.txt`, 'src/deep/path.txt'] };
        else if (action === 'file') data = { text: c.argv.at(-1) === 'big.txt' ? Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') : `${own(id)} one\ntwo\nthree\n` };
        else if (action === 'branches') data = state.branchList ?? { current: `loom/${id}`, branches: [`loom/${id}`, 'feature/next'] };
        else if (action === 'stashes') data = { stashes: [{ ref: 'stash@{0}', sha: '5a1c0de5a1c0de5a1c0de5a1c0de5a1c0de5a1c', message: `WIP on loom/${id}: abc1234 A saved change` }] };
        else data = status(id);
        // history: the thread has that many commits, and the phone gets the --commits it asked for.
        if (data.commits && state.history) {
          data.commits = Array.from({ length: Math.min(state.history, c.commits) }, (_, i) => ({ sha: `c${i}`, subject: `Commit ${i}` }));
          data.moreCommits = state.history > c.commits;
        }
        // gitChurn: an agent in the thread writes a new file before each read.
        if (action === 'status' && state.gitChurn) data.untracked.push(file(`made-${state.gitChurn++}.txt`, '?', '?'));
        // flagFile: a new file named like one of git's options. committed: nothing is staged after a commit.
        if (data.untracked && state.flagFile) data.untracked.push(file('--staged', '?', '?'));
        if (action === 'commit') (state.committed ??= new Set()).add(id);
        if (data.staged && state.committed?.has(id)) data.staged = [];
        break;
      }
      case 'new': data = threads[0]; break;
      default: data = {};
    }
    // A held show answers late with what was true when it was asked.
    if (c.cmd === 'show' && state.hold.delete('show')) await new Promise(r => (state.held.show = r));
    await route.fulfill({ json: { ok: true, data } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => state.errors.push(e.message));
  return { ctx, page, state };
}
const sheetButton = (page, text) => page.locator('#sheet').getByRole('button', { name: text, exact: true });
/** Picks images from the phone with the image button under `scope`, as its chooser would hand them over. */
async function attach(page, scope, ...pics) {
  await page.locator(scope).getByRole('button', { name: 'Add an image', exact: true }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sheetButton(page, 'Photo or file').click()]);
  await chooser.setFiles(Array.isArray(pics[0]) ? pics[0] : files(...pics));
}
async function close(page) { if (await page.locator('#sheet').isVisible()) await sheetButton(page, 'Cancel').click(); }
async function goto(page, hash, ready) { await page.goto(base + '/' + hash); await page.locator(ready).first().waitFor(); }
const git = (state, action) => state.calls.filter(c => c.cmd === 'git' && c.argv[1] === action);
// Loom restarts on the PC: every pane a new id (a1 is new-a1), its sid kept. As in Loom, where a pane id
// begins with when it was made (main.ts uid), the new Loom boots after a1 and b1 were made, before new-a1.
const restartPc = state => Object.assign(state, { newIds: true, booted: parseInt('new', 36) });
const header = page => page.locator('#pane .who b').innerText();
const unblock = state => { const waiting = state.blocked; state.blocked = null; for (const go of waiting) go(); };

// --- Every view fits its width -------------------------------------------------------
let checks = 0;
const overflow = [];
async function fits(page, width, name) {
  await page.waitForTimeout(80);
  const dim = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  if (dim.scroll > dim.width) overflow.push({ width, name, ...dim });
  checks++;
  if (width === 375 || width === 901) await page.screenshot({ path: resolve(out, `${width}-${name}.png`), fullPage: true });
}
/** A finger's worth: every control shown under `root` is at least 44 px tall. */
async function taps(page, width, root) {
  const small = await page.evaluate(r => [...document.querySelectorAll(`${r} button, ${r} input`)].filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.outerHTML.slice(0, 80)), root);
  assert.deepEqual(small, [], `${width}: controls under 44 px in ${root}`);
}
/** The strip floats on its own: 8 px and more above the tab bar on a phone, in the list's column when wide,
 * New thread above it, every part a finger tall, and a long name cut short rather than pushing CPU and RAM
 * out. `end`: the list's last agent, scrolled to, stays above it. */
async function stripFits(page, width, name, end = false) {
  await page.locator('#strip:not([hidden]) .ss-pc').waitFor();
  await taps(page, width, '#strip');
  const s = await page.evaluate(end => {
    const box = e => e?.checkVisibility() ? e.getBoundingClientRect() : null; // fixed: no offsetParent
    if (end) { scrollTo(0, document.documentElement.scrollHeight); document.querySelector('#list').scrollTop = 1e6; }
    const cap = document.querySelector('#strip .ss-cap'), nm = document.querySelector('#strip .ss-name');
    return { strip: box(document.querySelector('#strip')).toJSON(), tabs: box(document.querySelector('nav#tabs')).toJSON(), fab: box(document.querySelector('.fab'))?.toJSON(),
      pc: box(document.querySelector('#strip .ss-pc')).right, capRight: box(cap).right, spills: cap.scrollWidth > cap.clientWidth, cut: nm ? nm.scrollWidth > nm.clientWidth : null,
      vals: [...document.querySelectorAll('#strip .ss-val')].map(v => v.textContent), last: end ? box([...document.querySelectorAll('#list .agent')].at(-1)).bottom : null };
  }, end);
  if (width < 900) assert.ok(s.strip.bottom <= s.tabs.top - 8 && s.strip.left >= 11.5 && s.strip.right <= width - 11.5, `${width} ${name}: the strip floats apart from the tabs ${JSON.stringify([s.strip, s.tabs])}`);
  else assert.ok(s.strip.left >= 84 && s.strip.right <= 84 + 380, `${width} ${name}: the strip sits in the list's column ${JSON.stringify(s.strip)}`);
  if (s.fab) assert.ok(s.fab.bottom <= s.strip.top - 8, `${width} ${name}: New thread sits above the strip`);
  assert.ok(!s.spills && s.pc <= s.capRight, `${width} ${name}: CPU and RAM stay inside the strip`);
  if (width <= 375 && s.cut !== null) assert.ok(s.cut, `${width} ${name}: the long server name is cut short`);
  assert.deepEqual(s.vals, ['23%', '85%'], `${width} ${name}: CPU and RAM`);
  if (end) assert.ok(s.last <= s.strip.top, `${width} ${name}: the list's last agent scrolls clear of the strip (${s.last} > ${s.strip.top})`);
}
try {
  for (const width of (process.env.REMOTE_WIDTHS || '320,375,768,901,1024,1280').split(',').map(Number)) {
    const { ctx, page } = await context(width, false);
    await goto(page, '', '#pairing form'); await fits(page, width, 'pairing'); await ctx.close();
    const { ctx: c2, page: p, state } = await context(width);
    await goto(p, '', '#list .agent'); await stripFits(p, width, 'threads', true); await fits(p, width, 'threads');
    // An OMP pane shows OMP's mark.
    state.omp = true; await goto(p, '', '#list .agent');
    assert.ok(await p.evaluate(() => [...document.querySelectorAll('#list svg.ico path')].some(e => e.getAttribute('d') === 'M0 1.5h24v4.5H0zM3 6h6v10.5H3zM13.5 6h6v16.5h-6z')), `${width}: OMP's mark in the list`);
    assert.equal(await p.locator('#list .agent', { hasText: 'omp' }).count(), 1, `${width}: the list names OMP`);
    await fits(p, width, 'threads-omp');
    // omp finds it by name, in Threads and in Activity.
    await p.fill('#list input[type=search]', 'omp');
    await until(`${width}: omp finds OMP in Threads`, async () => (await p.locator('#list .agent').count()) === 1 && (await p.locator('#list .agent', { hasText: 'omp' }).count()) === 1);
    await p.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    await until(`${width}: omp finds OMP in Activity`, async () => (await p.locator('#list .card').count()) === 1 && (await p.locator('#list .card', { hasText: 'Beta / omp' }).count()) === 1);
    await fits(p, width, 'activity-omp');
    await p.fill('#list input[type=search]', 'claude');
    await until(`${width}: claude still finds Claude`, async () => (await p.locator('#list .card').count()) === 1 && (await p.locator('#list .card', { hasText: 'Alpha / claude' }).count()) === 1);
    await p.locator('#list .seg button').filter({ hasText: 'Threads' }).click();
    state.omp = false; await goto(p, '', '#list .agent');
    await p.locator('#list .thread-top .icon-btn').first().click(); await fits(p, width, 'thread-menu');
    await sheetButton(p, 'Rename').click(); await fits(p, width, 'rename'); await close(p);
    await p.locator('#list .seg button').filter({ hasText: 'Activity' }).click(); await p.locator('#list .card').first().waitFor(); await fits(p, width, 'activity');
    await attach(p, '#list .card >> nth=0', PNG); await p.locator('#list .card .shot').first().waitFor(); await fits(p, width, 'activity-image'); await taps(p, width, '#list .reply-box');
    await goto(p, '#/pane/a1', '#screen .line'); await fits(p, width, 'pane-question');
    // A phone gives an agent the whole screen, strip and tabs gone; wide, the strip stays in the list's column.
    assert.equal(await p.locator('#strip').isVisible(), width >= 900, `${width}: the strip beside an agent`); await p.click('#keys-btn'); await fits(p, width, 'keyboard');
    await p.locator('#keys [data-key=fn]').click(); await fits(p, width, 'function-keys'); await p.click('#more'); await p.locator('#sheet.on').waitFor(); await fits(p, width, 'pane-menu'); await close(p);
    // Dictating: the recording bar in the box's place, then the Dictation sheet from ⋯.
    await p.click('#mic'); await p.locator('#rec .info b', { hasText: '0:01' }).waitFor(); await fits(p, width, 'recording'); await taps(p, width, '#rec'); await p.getByRole('button', { name: 'Cancel dictation' }).click();
    await p.click('#more'); await p.locator('#sheet button', { hasText: 'Dictation · English · /prompt' }).click(); await p.locator('#sheet.on .dict-row').first().waitFor(); await fits(p, width, 'dictation-sheet'); await taps(p, width, '#sheet'); await sheetButton(p, 'Done').click();
    // Images: the sheet that adds one, then two waiting over the box, each with its remove.
    await p.click('#image-btn'); await p.locator('#sheet.on').waitFor(); await fits(p, width, 'image-menu'); await taps(p, width, '#sheet'); await close(p);
    await attach(p, '#prompt', PNG, JPG); await p.locator('#dock .shot').nth(1).waitFor(); await fits(p, width, 'images-waiting'); await taps(p, width, '#dock');
    await goto(p, '#/pane/zz1/Alpha%3A1', '#pane .who b:has-text("This agent is gone")'); await fits(p, width, 'pane-gone');
    await goto(p, '#/new', '#new form'); await fits(p, width, 'new-thread'); await p.locator('#new [data-kind=checkout]').click(); await fits(p, width, 'new-folder');
    await goto(p, '#/changes/a', '#changes .file'); await fits(p, width, 'changes'); await p.locator('#changes .picker').click(); await fits(p, width, 'thread-picker'); await close(p);
    // Every section folded, each title still a finger tall with its Stage all, then open again.
    for (const name of ['Staged', 'Changes', 'New files', 'Recent commits']) await p.locator('#changes .fold-head', { hasText: name }).click();
    await until(`${width}: all folded`, async () => (await p.locator('#changes .files').count()) === 0); await fits(p, width, 'changes-folded'); await taps(p, width, '#changes .section-title');
    for (const name of ['Staged', 'Changes', 'New files', 'Recent commits']) await p.locator('#changes .fold-head', { hasText: name }).click();
    await until(`${width}: all open`, async () => (await p.locator('#changes .files').count()) === 4);
    await p.locator('#changes .file .icon-btn').first().click(); await fits(p, width, 'file-menu'); await sheetButton(p, 'Discard changes').click(); await fits(p, width, 'discard-confirm'); await close(p);
    await p.locator('#changes .file').filter({ hasText: 'conflict.txt' }).first().locator('.icon-btn').click(); await fits(p, width, 'conflict-menu'); await close(p);
    await p.locator('#changes .midway button', { hasText: 'Skip' }).click(); await p.locator('#sheet.on').waitFor(); await fits(p, width, 'skip-confirm'); await close(p);
    await p.locator('#changes [aria-label="Git actions"]').click(); await fits(p, width, 'git-menu'); await sheetButton(p, 'Switch branch').click(); await p.locator('#sheet .item').first().waitFor(); await fits(p, width, 'branches'); await sheetButton(p, 'New branch…').click(); await fits(p, width, 'branch-form'); await close(p);
    for (const [i, name] of ['\u00a0approved', 'approved\u00a0', 'approved', 'heads/approved'].entries()) {
      const names = ['approved', '\u00a0approved', 'approved\u00a0', 'heads/approved'];
      state.branchList = { current: name, branches: names };
      await p.locator('#changes [aria-label="Git actions"]').click(); await sheetButton(p, 'Switch branch').click();
      const rows = p.locator('#sheet .item'); await rows.last().waitFor();
      const labels = await rows.allTextContents();
      for (const b of names) assert.ok(labels.includes(b === name ? `${b} (current)` : b), `exact phone label ${JSON.stringify(b)}`);
      await fits(p, width, `branches-identity-${i}`);
      await p.screenshot({ path: resolve(out, `${width}-branches-identity-${i}.png`), fullPage: true });
      const before = git(state, 'switch').length;
      await rows.nth(labels.indexOf(`${name} (current)`)).click();
      assert.equal(git(state, 'switch').length, before, 'current branch is not switched');
      await close(p);
      state.branchList.current = 'other';
      await p.locator('#changes [aria-label="Git actions"]').click(); await sheetButton(p, 'Switch branch').click();
      await rows.last().waitFor(); const select = (await rows.allTextContents()).indexOf(name); assert.ok(select >= 0);
      await rows.nth(select).click();
      await until('exact branch switch', () => git(state, 'switch').length === before + 1);
      assert.deepEqual(git(state, 'switch').at(-1).argv, ['a', 'switch', name]);
      await close(p);
    }
    delete state.branchList;
    await p.locator('#changes [aria-label="Git actions"]').click(); await sheetButton(p, 'Restore a stash').click(); await p.locator('#sheet .pair').waitFor(); await fits(p, width, 'stashes'); await close(p);
    await p.locator('#changes .commit-row .icon-btn').first().click(); await fits(p, width, 'commit-menu'); await close(p);
    // 60 commits: 10 and "Show more commits", then all 60 asked for and listed, and no button; another thread starts at 10.
    // "Show fewer commits", there past 10, goes back to 10.
    state.history = 60; await p.locator('#changes [aria-label="Refresh"]').click();
    const more = p.locator('#changes .more-rows', { hasText: 'Show more commits' }), fewer = p.locator('#changes .more-rows', { hasText: 'Show fewer commits' });
    await until(`${width}: 10 commits and more`, async () => (await p.locator('#changes .commit-row').count()) === 10 && await more.isVisible() && !(await fewer.count()));
    await fits(p, width, 'commits-more'); await taps(p, width, '#changes .body');
    await more.click();
    await until(`${width}: 60 commits`, async () => (await p.locator('#changes .commit-row').count()) === 60 && !(await more.count()) && await fewer.isVisible());
    assert.equal(git(state, 'status').at(-1).commits, 60, 'the phone asks for the commits it shows');
    await fits(p, width, 'commits-all');
    await fewer.click();
    await until(`${width}: back to 10 commits`, async () => (await p.locator('#changes .commit-row').count()) === 10 && await more.isVisible() && !(await fewer.count()));
    assert.equal(git(state, 'status').at(-1).commits, 10, 'Show fewer commits asks for 10');
    await more.click(); await until(`${width}: 60 commits again`, async () => (await p.locator('#changes .commit-row').count()) === 60);
    await p.evaluate(() => { location.hash = '#/changes/b'; });
    await until(`${width}: Beta starts at 10`, async () => (await p.locator('#changes .picker b').textContent()).includes('Beta') && (await p.locator('#changes .commit-row').count()) === 10);
    assert.equal(git(state, 'status').at(-1).commits, 10, 'another thread asks for 10');
    await p.evaluate(() => { location.hash = '#/changes/a'; }); await until(`${width}: Alpha again`, async () => (await p.locator('#changes .picker b').textContent()).includes('Alpha'));
    delete state.history;
    for (const sec of ['unstaged', 'staged', 'untracked']) { await goto(p, `#/diff/a/${sec}/alpha.txt`, '#diff .hunk'); await fits(p, width, `diff-${sec}`); }
    await goto(p, '#/commit/a/abc1234', '#diff .commit-head'); await fits(p, width, 'commit');
    await goto(p, '#/files/a', '#files .list-row'); await fits(p, width, 'files'); await goto(p, '#/file/a/alpha.txt', '#diff .r'); await fits(p, width, 'file');
    await goto(p, '#/usage', '#usage .provider'); await stripFits(p, width, 'usage'); await fits(p, width, 'usage'); await goto(p, '#/context/a1', '#context .bars'); await fits(p, width, 'context');
    state.planUsage = 'off'; await goto(p, '#/usage', '#usage .provider:has-text("Plan usage is off")'); await fits(p, width, 'usage-plan-off'); await taps(p, width, '#usage .provider'); state.planUsage = 'on';
    await goto(p, '#/settings', '#settings .group'); await stripFits(p, width, 'settings'); await fits(p, width, 'settings');
    await p.locator('#settings .setting', { hasText: 'Language and prefix' }).locator('button').click(); await p.locator('#sheet.on .dict-row').first().waitFor(); await fits(p, width, 'settings-dictation'); await sheetButton(p, 'Done').click(); await p.locator('#settings .setting').filter({ hasText: 'Theme' }).locator('button').click(); await fits(p, width, 'themes'); await close(p);
    await p.getByRole('button', { name: 'Unpair all', exact: true }).click(); await fits(p, width, 'unpair-confirm'); await close(p);
    // The paired phones, each with its Remove: none, this one alone, then three with a long name, which is cut
    // short with its bell and Remove still on screen.
    for (const n of [0, 1, 3]) {
      state.devices = n === 1 ? DEVICES().filter(d => d.id === MINE) : DEVICES().slice(0, n);
      await p.evaluate(() => (location.hash = '#/')); // Settings opened again reads the phones
      await goto(p, '#/settings', '#settings .group');
      await until(`${width}: ${n} phones listed`, async () => (await p.locator('#settings .setting', { hasText: 'All phones' }).count()) === 1 && (await p.locator('#settings .setting.phone').count()) === n);
      await fits(p, width, `settings-phones-${n}`);
    }
    await taps(p, width, '#settings .setting.phone');
    const long = await p.evaluate(name => {
      const row = [...document.querySelectorAll('#settings .setting.phone')].find(r => r.querySelector('b span').textContent === name);
      const span = row.querySelector('b span'), bell = row.querySelector('b svg').getBoundingClientRect(), remove = row.querySelector('.icon-btn').getBoundingClientRect();
      return { cut: span.scrollWidth > span.clientWidth, bell: bell.right <= remove.left, remove: remove.right <= innerWidth && remove.width >= 44 };
    }, PHONE);
    assert.ok(long.bell && long.remove, `${width}: the long name's bell and Remove stay on screen`);
    if (width <= 375) assert.ok(long.cut, `${width}: the long name is cut short`);
    await p.getByRole('button', { name: `Remove ${PHONE}`, exact: true }).click(); await fits(p, width, 'phone-remove-confirm'); await close(p);
    delete state.devices;
    assert.deepEqual(state.errors, [], `${width}: errors in the page`);
    await c2.close();
  }
  assert.deepEqual(overflow, [], 'no view may be wider than the window');
  console.log(`PASS ${checks} views fit their width`);

  // --- The strip above the tabs --------------------------------------------------------------
  // Its server opens that pane, +2 lists all three and each opens its own, CPU and RAM open the task manager.
  // A server whose pane the phone hasn't read waits, none says "No servers", it reads every 3 s and shows a
  // new reading, and a list longer than the screen scrolls its last agent clear of it.
  for (const width of [375, 1024]) {
    const { ctx, page, state } = await context(width);
    const hash = () => page.evaluate(() => location.hash);
    await goto(page, '', '#list .agent');
    await page.locator('#strip:not([hidden]) .ss-server').waitFor();
    assert.deepEqual([await page.locator('#strip .ss-name').innerText(), await page.locator('#strip .ss-port').innerText(), await page.locator('#strip .ss-count').innerText()], [SERVER, ':3000', '+2']);
    await page.locator('#strip .ss-server').click();
    await until(`${width}: the server opens its pane`, async () => (await hash()) === '#/pane/a1');
    await goto(page, '', '#list .agent');
    await page.locator('#strip .ss-more').click();
    await page.locator('#sheet.on .ss-row').nth(2).waitFor();
    const rows = await page.evaluate(() => [...document.querySelectorAll('#sheet .ss-row')].map(r => [r.querySelector('b').textContent, r.querySelector('small').textContent, r.querySelector('.ss-port').textContent]));
    assert.deepEqual(rows, [[SERVER, 'Alpha · pane 1', ':3000'], ['python', 'Beta · pane 1', ':8000'], ['node', 'Beta · pane 1', ':45678']]);
    await page.waitForTimeout(250); // the sheet's way in, before a screenshot
    await fits(page, width, 'strip-servers'); await taps(page, width, '#sheet');
    await page.locator('#sheet .ss-row').nth(1).click();
    await until(`${width}: a listed server opens its pane`, async () => (await hash()) === '#/pane/b1' && await page.locator('#sheet').isHidden());
    await goto(page, '', '#list .agent');
    await page.locator('#strip .ss-pc').click();
    await page.locator('#sheet.on.tasks-sheet .proc').first().waitFor();
    await page.locator('#sheet').getByRole('button', { name: 'Close', exact: true }).click();
    // A pane the phone hasn't read yet: its server waits for a reading that has it. None at all: "No servers".
    state.servers = [{ port: 3000, pane: 'zz9', name: 'ghost' }, { port: 8000, pane: 'b1', name: 'python' }];
    await until(`${width}: an unknown pane's server waits`, async () => (await page.locator('#strip .ss-name').innerText()) === 'python' && !(await page.locator('#strip .ss-more').count()), 5000);
    state.servers = [];
    await page.locator('#strip .ss-none', { hasText: 'No servers' }).waitFor({ timeout: 5000 });
    await stripFits(page, width, 'no-servers'); await fits(page, width, 'strip-none');
    // Every 3 s, and a new reading shows.
    const reads = () => state.calls.filter(c => c.cmd === 'bar').length;
    const first = reads();
    await page.waitForTimeout(6500);
    assert.ok(reads() - first >= 2 && reads() - first <= 3, `${width}: two or three reads in 6.5 s, not ${reads() - first}`);
    state.cpu = 71.6;
    await page.locator('#strip .ss-val', { hasText: '72%' }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#strip .ss-fill').first().evaluate(e => e.style.width), '72%');
    // A list longer than the screen.
    Object.assign(state, { cpu: undefined, servers: undefined, extra: 12 });
    await goto(page, '', '#list .agent');
    await until(`${width}: 14 threads`, async () => (await page.locator('#list .agent').count()) === 14);
    await stripFits(page, width, 'long-list', true);
    await page.screenshot({ path: resolve(out, `${width}-strip-long-list.png`) });
    assert.deepEqual(state.errors, [], `${width}: errors in the page`);
    await ctx.close();
  }
  // In a light theme the strip wears the PC's colours too.
  {
    const { ctx, page, state } = await context(375);
    state.theme = { name: 'paper', scheme: 'light', vars: palette('paper') };
    await goto(page, '', '#list .agent');
    await stripFits(page, 375, 'paper');
    assert.equal(await page.locator('#strip .ss-cap').evaluate(e => getComputedStyle(e).backgroundColor), await page.evaluate(() => { const d = document.createElement('div'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--raise'); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }));
    await page.screenshot({ path: resolve(out, '375-strip-paper.png') });
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS the strip: its server and each listed one open their pane, CPU and RAM the task manager; unknown panes wait, none says so; read every 3 s; a long list scrolls clear; light theme');

  // --- The task manager (Settings, On the PC) -----------------------------------------------
  // In a dark and a light theme at every width: the modal fits, a 60-character name is cut short with its
  // numbers on screen, and chrome × 34 opens to its processes.
  const openTasks = async page => {
    await goto(page, '#/settings', '#settings .group');
    await page.locator('#settings .setting', { hasText: 'Task manager' }).getByRole('button', { name: 'Open' }).click();
    await page.locator('#sheet.on .proc').first().waitFor();
    await page.waitForTimeout(250); // the sheet's way in, before a screenshot
  };
  const names = page => page.locator('#sheet .proc .name').allInnerTexts();
  for (const [theme, scheme] of [['woad', 'dark'], ['paper', 'light']]) {
    for (const width of (process.env.REMOTE_WIDTHS || '320,375,768,901,1024,1280').split(',').map(Number)) {
      const { ctx, page, state } = await context(width);
      state.theme = { name: theme, scheme, vars: palette(theme) };
      await openTasks(page);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), scheme);
      await fits(page, width, `tasks-${theme}`);
      await taps(page, width, '#sheet');
      const long = await page.evaluate(long => {
        const row = [...document.querySelectorAll('#sheet .proc')].find(r => r.querySelector('.name').textContent === long);
        const name = row.querySelector('.name'), nums = [...row.querySelectorAll('.num')], list = document.querySelector('#sheet .procs');
        return { cut: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis', shown: nums.map(n => n.textContent),
          right: Math.max(...nums.map(n => n.getBoundingClientRect().right)), edge: Math.min(innerWidth, list.getBoundingClientRect().right), scroll: list.scrollWidth, width: list.clientWidth };
      }, LONG);
      assert.deepEqual(long.shown, ['12.3%', '2.2 GB'], `${width}: the long name's numbers`);
      assert.ok(long.right <= long.edge, `${width} ${theme}: the long name pushes its numbers off the list (${long.right} > ${long.edge})`);
      assert.ok(long.scroll <= long.width, `${width} ${theme}: the list scrolls sideways (${long.scroll} > ${long.width})`);
      if (width <= 375) assert.ok(long.cut, `${width}: the long name must be cut short with an ellipsis`);
      if (width !== 1024) await page.screenshot({ path: resolve(out, `${width}-tasks-${theme}.png`) });
      const chrome = page.locator('#sheet .proc', { hasText: 'chrome' });
      assert.equal(await chrome.locator('.n').innerText(), '× 34');
      assert.deepEqual(await chrome.locator('.num').allInnerTexts(), ['20.4%', '1.9 GB'], 'chrome summed');
      await chrome.click();
      await until('chrome opens to its processes', async () => (await page.locator('#sheet .pid').count()) === 34);
      await fits(page, width, `tasks-open-${theme}`);
      if (width !== 1024) await page.screenshot({ path: resolve(out, `${width}-tasks-open-${theme}.png`) });
      assert.deepEqual(state.errors, [], `${width}: errors in the page`);
      await ctx.close();
    }
  }
  assert.deepEqual(overflow, [], 'no view may be wider than the window');
  {
    const { ctx, page, state } = await context(375);
    const reads = () => state.calls.filter(c => c.cmd === 'procs').length;
    await openTasks(page);
    // By CPU, then by memory; the filter keeps what matches.
    assert.deepEqual((await names(page)).slice(0, 2), ['chrome', LONG]);
    await page.locator('#sheet .seg button', { hasText: 'Memory' }).click();
    assert.deepEqual((await names(page)).slice(0, 2), [LONG, 'chrome']);
    await page.fill('#sheet input[type=search]', 'CHROM');
    assert.deepEqual(await names(page), ['chrome']);
    await page.fill('#sheet input[type=search]', 'nothing like it');
    await page.locator('#sheet .procs .hint').waitFor();
    await page.fill('#sheet input[type=search]', '');
    // Every 2 s while it is open, each reading a point on the CPU line.
    const first = reads();
    await page.waitForTimeout(4500);
    assert.ok(reads() - first >= 2 && reads() - first <= 3, `two or three reads in 4.5 s, not ${reads() - first}`);
    assert.ok((await page.locator('#sheet .spark polyline').getAttribute('points')).split(' ').length >= 3, 'the CPU line grows');
    await page.screenshot({ path: resolve(out, '375-tasks-line.png') });
    // Out of view, no reads; back in view, reads again.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300); // one already on its way may land
    const hidden = reads();
    await page.waitForTimeout(4500);
    assert.equal(reads(), hidden, 'no reads while the page is hidden');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await until('reads again in view', () => reads() > hidden, 4000);
    // Offline: the last numbers stay, and the line under them says why they don't move.
    state.offline = true;
    await page.locator('#sheet .quiet.error').waitFor({ timeout: 6000 });
    assert.ok((await page.locator('#sheet .proc').count()) > 0, 'the last reading stays');
    state.offline = false;
    await until('answering again', async () => !(await page.locator('#sheet .quiet.error').count()), 6000);
    // Closed: no more reads.
    await page.locator('#sheet').getByRole('button', { name: 'Close', exact: true }).click();
    const closed = reads();
    await page.waitForTimeout(4500);
    assert.equal(reads(), closed, 'no reads once it is closed');
    // Unpaired on the PC while it is open: the pairing form, the modal gone, no more reads.
    await openTasks(page);
    state.revoked = true;
    await page.locator('#pairing').waitFor({ state: 'visible', timeout: 6000 });
    await until('the modal goes', () => page.locator('#sheet').isHidden(), 4000);
    const gone = reads();
    await page.waitForTimeout(4500);
    assert.equal(reads(), gone, 'no reads once unpaired');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS the task manager fits every width in woad and paper, cuts a 60-character name short, sums and opens groups, sorts and filters, reads every 2 s only while open and in view, and keeps its last numbers offline');

  // --- A late git reply stays with its own thread -------------------------------------
  for (const width of [375, 1024]) {
    const { ctx, page, state } = await context(width);
    await goto(page, '#/changes/b', '#changes .file');
    state.hold.add('a status');
    await page.evaluate(() => (location.hash = '#/changes/a'));
    await until('Alpha asks for its status', () => state.held['a status']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a status']();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#changes .picker b').innerText(), 'Beta');
    assert.equal(await page.locator('#changes .file').filter({ hasText: 'alpha.txt' }).count(), 0, "Alpha's late status must not draw under Beta");
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).locator('.icon-btn').click();
    await sheetButton(page, 'Stage').click();
    await until('the stage', () => git(state, 'stage').length);
    assert.deepEqual(git(state, 'stage')[0].argv, ['b', 'stage', '--unstaged', '--', 'beta.txt']);

    // A diff: Alpha's late patch must not take Beta's diff screen and its hunk buttons.
    state.hold.add('a diff');
    await page.evaluate(() => (location.hash = '#/diff/a/unstaged/alpha.txt'));
    await until('Alpha asks for its diff', () => state.held['a diff']);
    await page.evaluate(() => (location.hash = '#/diff/b/unstaged/beta.txt'));
    await page.locator('#diff .hunk').first().waitFor();
    state.held['a diff']();
    await page.waitForTimeout(400);
    assert.ok(!(await page.locator('#diff').innerText()).includes('alpha'), "Alpha's late diff must not draw under Beta");
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until('the hunk', () => git(state, 'apply').length);
    const hunk = git(state, 'apply')[0];
    assert.deepEqual(hunk.argv, ['b', 'apply', '-', '--cached']);
    assert.match(hunk.stdin, /beta\.txt/);

    // A change asked in one thread draws nothing once another thread is on show.
    await goto(page, '#/changes/a', '#changes .file');
    state.hold.add('a fetch');
    await page.locator('#changes [aria-label="Git actions"]').click();
    await sheetButton(page, 'Fetch').click();
    await until('Alpha fetches', () => state.held['a fetch']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a fetch']();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#changes .file').filter({ hasText: 'alpha.txt' }).count(), 0, "Alpha's fetch must not draw under Beta");
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS late git replies stay with their thread: status, diff, hunk and change');

  // --- Cancel answers nothing ------------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/changes/a', '#changes .file');
    await page.locator('#changes [aria-label="Git actions"]').click();
    await sheetButton(page, 'Switch branch').click();
    await sheetButton(page, 'New branch…').click();
    await sheetButton(page, 'Cancel').click();
    await goto(page, '', '#list .agent');
    await page.locator('#list .thread-top .icon-btn').first().click();
    await sheetButton(page, 'Rename').click();
    await sheetButton(page, 'Cancel').click();
    await page.waitForTimeout(500);
    assert.deepEqual(git(state, 'switch'), [], 'Cancel must not switch branches');
    assert.deepEqual(state.calls.filter(c => c.cmd === 'rename'), [], 'Cancel must not rename');
    assert.equal(await page.locator('#toast.error').isVisible(), false);
    await ctx.close();
  }
  console.log('PASS Cancel sends nothing: new branch and rename');

  // --- A cut-off answer to a change is asked again with its key -------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    state.corruptSend = true;
    await page.fill('#prompt textarea', 'Please do this once');
    await page.click('#prompt button.primary');
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor({ timeout: 8000 });
    let sent = state.calls.filter(c => c.cmd === 'submit');
    assert.equal(sent.length, 2, 'one retry after the cut-off answer');
    assert.ok(sent[0].key && sent[0].key === sent[1].key, 'the retry carries the first key');
    assert.equal(await page.inputValue('#prompt textarea'), '');
    // Loom refusing is an answer: shown, never retried.
    state.refuseSend = true;
    await page.fill('#prompt textarea', 'Refuse this');
    await page.click('#prompt button.primary');
    await page.locator('#toast.error').filter({ hasText: 'That pane is busy.' }).waitFor();
    await page.waitForTimeout(2000);
    sent = state.calls.filter(c => c.cmd === 'submit');
    assert.equal(sent.length, 3, 'a refusal is not retried');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a cut-off answer retries with its key; a refusal does not');

  // --- The startup list follows Settings -------------------------------------------------
  {
    const { ctx, page } = await context(375);
    const options = async () => {
      await page.evaluate(() => (location.hash = '#/new'));
      await page.locator('#new form').waitFor();
      return page.locator('#new .mix-name').allTextContents();
    };
    const settings = () => goto(page, '#/settings', '#settings input[aria-label=Name]');
    await settings();
    await page.fill('#settings input[aria-label=Name]', 'New Agent');
    await page.fill('#settings input[aria-label=Command]', 'newagent');
    await page.locator('#settings form button.primary').click();
    await page.getByRole('button', { name: 'Remove New Agent' }).waitFor();
    await page.getByRole('button', { name: 'Remove Codex' }).click();
    await page.getByRole('button', { name: 'Remove Codex' }).waitFor({ state: 'detached' });
    assert.deepEqual(await options(), ['Claude', 'New Agent'], 'New Thread offers what Settings lists');
    await page.evaluate(() => (location.hash = '#/'));
    await page.locator('#list .thread-top .icon-btn').first().click();
    assert.deepEqual(await page.locator('#sheet select[aria-label=Agent] option').allTextContents(), ['Claude', 'New Agent'], 'Add Agent too');
    await close(page);
    await settings();
    for (const name of ['Claude', 'New Agent']) {
      await page.getByRole('button', { name: `Remove ${name}` }).click();
      await page.getByRole('button', { name: `Remove ${name}` }).waitFor({ state: 'detached' });
    }
    assert.deepEqual(await options(), [], 'an emptied list offers nothing');
    await ctx.close();
  }
  console.log('PASS New Thread and Add Agent offer the startups Settings lists, down to none');

  // --- New thread: cards, a count per startup, what creating will do --------------------------
  // Agents above terminals, Claude alone to begin with, the summary following every field, at most 16 panes,
  // one loomctl new --mix with the whole pick, and the pick kept for next time on this phone.
  for (const width of [320, 375, 768, 1024, 1280]) {
    const { ctx, page, state } = await context(width);
    state.startups.push({ label: 'PowerShell', cmd: '' }, { label: 'a-very-long-custom-command --with --flags', cmd: 'node tools/long.js' });
    await goto(page, '#/new', '#new .mix-row');
    const text = sel => page.locator(sel).innerText();
    const counts = () => page.evaluate(() => [...document.querySelectorAll('#new .mix-row')].map(r => `${r.querySelector('.mix-name').textContent}=${r.querySelector('output').textContent}`));
    assert.deepEqual(await page.locator('#new .mix-list h2').allTextContents(), ['Agents', 'Terminals']);
    assert.deepEqual(await counts(), ['Claude=1', 'Codex=0', 'PowerShell=0', 'a-very-long-custom-command --with --flags=0']);
    assert.equal(await page.locator('#new [data-kind=worktree]').getAttribute('aria-pressed'), 'true');
    assert.equal(await text('#new button.primary'), 'Create worktree');
    assert.equal(await text('#new .new-summary'), 'Name the thread: the name becomes its branch and its folder.');
    assert.ok(await page.getByRole('button', { name: 'One less Codex' }).isDisabled(), 'nothing to take away from 0');
    await page.fill('#new input[name=name]', 'Fix login!');
    await page.getByRole('button', { name: 'One more Codex' }).click();
    await page.getByRole('button', { name: 'One more Codex' }).click();
    await page.getByRole('button', { name: 'One more PowerShell' }).click();
    const repo = await page.locator('#new select[name=project]').inputValue();
    assert.equal(await text('#new .new-path'), repo);
    assert.equal(await text('#new .new-summary'), `Loom will create loom/fix-login off HEAD, check it out in ~\\loom\\${repo.split(/[\\/]/).pop()}\\fix-login, then start Claude, 2 Codex and PowerShell there. A name already in use gets -2, -3… added.`);
    await page.fill('#new input[name=base]', 'main');
    assert.match(await text('#new .new-summary'), /off main,/);
    await fits(page, width, 'new-mix'); await taps(page, width, '#new');
    await page.screenshot({ path: resolve(out, `${width}-new-worktree.png`) });
    // Create stays in reach at the foot of the screen while the form scrolls.
    const foot = await page.locator('#new .new-actions').boundingBox();
    assert.ok(Math.abs(foot.y + foot.height - page.viewportSize().height) <= 1, `${width}: Create sits at the foot (${foot.y + foot.height})`);
    // 16 at most: every + gives way, a − brings them back.
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'One more Claude' }).click();
    assert.equal((await counts())[0], 'Claude=13');
    assert.equal(await page.locator('#new .mix-row button:last-child:not(:disabled)').count(), 0, 'no + past 16');
    await page.getByRole('button', { name: 'One less Claude' }).click();
    assert.equal(await page.locator('#new .mix-row button:last-child:disabled').count(), 0, 'one under 16: every + again');
    await page.locator('#new button.primary').click();
    await until(`${width}: created`, async () => state.calls.some(c => c.cmd === 'new'));
    const made = state.calls.find(c => c.cmd === 'new').argv;
    assert.deepEqual([made[0], made[1], JSON.parse(made[2]), ...made.slice(3)], [repo, '--mix', { Claude: 12, Codex: 2, PowerShell: 1 }, '--name', 'Fix login!', '--base', 'main']);
    await until(`${width}: the first pane opens`, async () => (await page.evaluate(() => location.hash)).startsWith('#/pane/'));
    // This folder: no name, no base, and a project already open only switches.
    await page.reload();
    await goto(page, '#/new', '#new .mix-row');
    assert.deepEqual(await counts(), ['Claude=12', 'Codex=2', 'PowerShell=1', 'a-very-long-custom-command --with --flags=0'], 'the last pick comes back');
    await page.locator('#new [data-kind=checkout]').click();
    assert.equal(await text('#new button.primary'), 'Open checkout');
    assert.ok(!(await page.locator('#new input[name=name]').isVisible()) && !(await page.locator('#new input[name=base]').isVisible()));
    assert.match(await text('#new .new-summary'), /^Alpha already has C:\/projects\/Alpha open\. Loom will switch to it and start nothing new\.$/);
    await page.selectOption('#new select[name=project]', '');
    await page.fill('#new input[name=folder]', 'D:\\elsewhere');
    assert.equal(await text('#new .new-summary'), 'Loom will open D:\\elsewhere as it is, then start 12 Claude, 2 Codex and PowerShell there.');
    assert.ok(!(await page.locator('#new .new-path').isVisible()), 'a typed folder shows no path line');
    await page.getByRole('button', { name: 'One more a-very-long-custom-command --with --flags' }).click();
    // The view as you see it, top and foot: a full-page shot draws the pinned bar and button mid-page.
    for (const [at, y] of [['top', 0], ['foot', 1e6]]) {
      await page.evaluate(y => scrollTo(0, y), y);
      await page.screenshot({ path: resolve(out, `${width}-new-thread-${at}.png`) });
    }
    await fits(page, width, 'new-checkout'); await taps(page, width, '#new');
    assert.deepEqual(state.errors, [], `${width}: errors in the page`);
    await ctx.close();
  }
  console.log('PASS New thread: agents then terminals, a count each up to 16 panes, the summary follows the form, one new --mix, the pick kept');

  // --- An Activity reply survives the cards being rebuilt --------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const reply = page.locator('#list .reply input[aria-label="Reply to Alpha:1"]');
    await reply.fill('Please keep this unsent reply');
    await reply.evaluate(i => { i.focus(); i.setSelectionRange(7, 11); });
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    const after = await reply.evaluate(i => ({ value: i.value, focused: document.activeElement === i, start: i.selectionStart, end: i.selectionEnd }));
    assert.deepEqual(after, { value: 'Please keep this unsent reply', focused: true, start: 7, end: 11 }, 'the draft, its focus and its selection survive');
    await reply.press('Enter');
    await until('the reply', () => state.calls.some(c => c.cmd === 'submit'));
    assert.equal(state.calls.find(c => c.cmd === 'submit').stdin, 'Please keep this unsent reply');
    await until('the box empties', async () => (await reply.inputValue()) === '');
    state.changedTitle = false;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await reply.inputValue(), '', 'a sent reply is no draft');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS an Activity reply keeps its text, focus and selection across a rebuild');

  // --- A reply that completes late clears only itself ------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const reply = page.locator('#list .reply input[aria-label="Reply to Alpha:1"]');
    await reply.fill('First reply');
    state.hold.add('submit');
    await reply.press('Enter');
    await until('the first reply is on its way', () => state.held.submit);
    await reply.fill('New draft while first reply is sending');
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    state.held.submit();
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(state.calls.find(c => c.cmd === 'submit').stdin, 'First reply');
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'the first reply must not take the newer draft with it');
    state.changedTitle = false;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'the newer draft survives the next rebuild');
    // Refused, it stays too.
    state.refuseSend = true;
    await reply.press('Enter');
    await page.locator('#toast.error').filter({ hasText: 'That pane is busy.' }).waitFor();
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    assert.equal(await reply.inputValue(), 'New draft while first reply is sending', 'a refused reply stays a draft');

    // The agent's own message box: the same.
    await goto(page, '#/pane/a1', '#screen .line');
    await page.fill('#prompt textarea', 'First message');
    state.hold.add('submit');
    await page.click('#prompt button.primary');
    await until('the first message is on its way', () => state.held.submit);
    await page.fill('#prompt textarea', 'Next message');
    state.held.submit();
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#prompt textarea'), 'Next message', 'the first message must not take the next one with it');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a send that completes late clears only what it sent: Activity reply and message box');

  // --- A hunk action that completes after you left redraws nothing ------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/diff/a/unstaged/alpha.txt', '#diff .hunk');
    // On the same screen it reloads the diff, as before.
    const reads = git(state, 'diff').length;
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until('the diff reloads', () => git(state, 'diff').length === reads + 1);
    await page.locator('#diff .hunk').first().waitFor();
    // Left for Beta's file, it leaves that alone.
    state.hold.add('a apply');
    await page.locator('#diff .hunk button').filter({ hasText: 'Stage' }).first().click();
    await until("Alpha's hunk is on its way", () => state.held['a apply']);
    await page.evaluate(() => (location.hash = '#/file/b/beta.txt'));
    await until("Beta's file", async () => (await page.locator('#diff').innerText()).includes('beta one'));
    const before = git(state, 'diff').length;
    state.held['a apply']();
    await page.locator('#toast').filter({ hasText: 'Staged the hunk' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(git(state, 'diff').length, before, 'no reload of the diff that was left');
    assert.equal(await page.locator('#diff .who b').innerText(), 'beta.txt');
    assert.ok(!(await page.locator('#diff').innerText()).includes('alpha'), "Alpha's patch must not appear under beta.txt");
    assert.equal(await page.locator('#diff .hunk').count(), 0, 'no hunk buttons on a file');
    // Stage this file, then off to Beta's changes: it must not go Back from there.
    await goto(page, '#/diff/a/untracked/new.txt', '#diff .hunk');
    state.hold.add('a stage');
    await page.locator('#diff button').filter({ hasText: 'Stage this file' }).click();
    await until('the file is on its way', () => state.held['a stage']);
    await page.evaluate(() => (location.hash = '#/changes/b'));
    await page.locator('#changes .file').filter({ hasText: 'beta.txt' }).waitFor();
    state.held['a stage']();
    await page.locator('#toast').filter({ hasText: 'Staged' }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => location.hash), '#/changes/b', 'a late Stage this file must not go Back from another screen');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a hunk or file action that completes after you left redraws and navigates nothing');

  // --- The phone review's fixes (docs/reviews/LOOM_PHONE_REMOTE_REVIEW_CLAUDE_OPUS55_2026-10-06_192346.md) ---
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#question button');
    // One trip a turn: the question comes with the screen, never asked apart (it was read, then menu).
    const since = state.calls.length;
    await page.waitForTimeout(2200);
    const turn = state.calls.slice(since);
    assert.ok(turn.filter(c => c.cmd === 'read').length >= 2 && turn.every(c => c.cmd !== 'read' || c.argv.includes('--menu')), 'the screen is read with its question');
    assert.equal(turn.filter(c => c.cmd === 'menu').length, 0, 'no menu read of its own');
    // ⋯ opens at once (it waited for status), and status still comes.
    state.hold.add('status');
    await page.click('#more');
    await page.locator('#sheet.on').waitFor({ timeout: 1000 });
    await until('status for the window size', () => state.held.status);
    state.held.status();
    await close(page);
    // A toast lets a tap through to Back and ⋯ under it (it took them).
    await page.fill('#prompt textarea', 'go on');
    await page.click('#prompt button.primary');
    await page.locator('#toast').filter({ hasText: 'Sent' }).waitFor();
    assert.deepEqual(await page.evaluate(() => ['#pane .back', '#more'].map(s => {
      const r = document.querySelector(s).getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(s);
    })), [true, true], 'Back and ⋯ take a tap under a toast');
    // Each agent keeps its own message (one box held it for all).
    await page.fill('#prompt textarea', 'for Alpha only');
    await page.evaluate(() => (location.hash = '#/pane/b1'));
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    assert.equal(await page.inputValue('#prompt textarea'), '', "Alpha's message isn't Beta's");
    // The agent opened on the phone comes to the front on the PC and fills its thread; opening one
    // that's still zoomed there leaves it zoomed (zoom toggles).
    await until('Beta zoomed on the PC', () => state.zoomed.has('b1'));
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    assert.equal(await page.inputValue('#prompt textarea'), 'for Alpha only', 'it comes back with Alpha');
    await until('Alpha shown again', () => state.calls.filter(c => c.cmd === 'show' && c.argv[0] === 'a1').length === 2);
    await page.waitForTimeout(300);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'zoom').map(c => c.argv[0]), ['a1', 'b1'], 'each agent zoomed once');
    assert.deepEqual([...state.zoomed], ['a1', 'b1']);
    // A reply lost on the way holds the screen up until its deadline, not for good.
    state.hold.add('menu'); // the next read of the screen never answers
    await until('the read is lost', () => state.held.menu);
    const lost = state.calls.length;
    await until('the screen is read again', () => state.calls.slice(lost).some(c => c.cmd === 'read'), 20000);
    // One lost read of the threads says nothing; Loom out of reach shows the banner over the page, the message box on screen.
    await page.evaluate(() => {
      const banner = document.querySelector('#offline');
      window.bannerShown = false;
      new MutationObserver(() => { if (!banner.hidden) window.bannerShown = true; }).observe(banner, { attributes: true });
    });
    state.failThreads = 1;
    await until('the lost threads read', () => state.failThreads === 0);
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => window.bannerShown), false, 'one lost read shows no banner, not even for a moment');
    state.offline = true;
    await page.locator('#offline').waitFor({ timeout: 8000 });
    const dock = await page.locator('#dock').boundingBox();
    assert.ok(dock.y + dock.height <= 800.5, `the banner pushes nothing: the dock ends at ${dock.y + dock.height} of 800`);
    state.offline = false;
    await page.locator('#offline').waitFor({ state: 'hidden', timeout: 8000 });
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    const { ctx, page, state } = await context(375);
    // A word the phone's keyboard is still composing lands once when the cards are rebuilt meanwhile (it doubled).
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const reply = page.locator('#list .reply input[aria-label="Reply to Alpha:1"]');
    await reply.click();
    await page.keyboard.type('yes ');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'do', selectionStart: 2, selectionEnd: 2 });
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    await cdp.send('Input.imeSetComposition', { text: 'done', selectionStart: 4, selectionEnd: 4 });
    await cdp.send('Input.insertText', { text: 'done' });
    assert.equal(await reply.inputValue(), 'yes done', 'the composed word lands once');
    // Its card, kept while typed in, is drawn anew once the box is left.
    const card = await page.locator('#list .card[data-pane=a1]').elementHandle();
    await reply.blur();
    await page.waitForFunction(c => !c.isConnected, card, { timeout: 5000 });
    // The commit box: a message keeps its caret while an agent writes files in the thread (it jumped to the end).
    await goto(page, '#/changes/a', '#changes .composer textarea');
    const box = page.locator('#changes .composer textarea');
    await box.fill('fix the login bug');
    await box.evaluate(t => { t.focus(); t.setSelectionRange(4, 4); });
    const typed = await box.elementHandle();
    state.gitChurn = 1;
    await page.locator('#changes .file').filter({ hasText: 'made-' }).first().waitFor({ timeout: 14000 });
    assert.deepEqual(await typed.evaluate(t => [t.isConnected, document.activeElement === t, t.selectionStart]), [true, true, 4], 'the same box, focused, its caret where it was');
    // Usage isn't redrawn while nothing on it changed (it was, every 2 s).
    await goto(page, '#/usage', '#usage .provider');
    const provider = await page.locator('#usage .provider').first().elementHandle();
    await page.waitForTimeout(4500);
    assert.ok(await provider.evaluate(e => e.isConnected), 'the same cards after 4.5 s');
    // A big file draws a thousand lines at a time (it drew 20,000 at once).
    await goto(page, '#/file/a/big.txt', '#diff .r');
    assert.equal(await page.locator('#diff .r').count(), 1000);
    const more = page.locator('#diff .more-rows');
    assert.equal(await more.innerText(), 'Show more: 1500 lines left');
    await more.click();
    await more.click();
    assert.equal(await page.locator('#diff .r').count(), 2500);
    assert.equal(await page.locator('#diff .r').last().innerText().then(t => t.includes('line 2500')), true);
    assert.equal(await more.isVisible(), false, 'no button once all are drawn');
    await more.evaluate(b => (b.hidden = false)); // its button, at every width
    for (const width of [320, 375, 768, 901, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(80);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `the paged file fits at ${width}`);
      if (width === 375 || width === 901) await page.screenshot({ path: resolve(out, `${width}-file-paged.png`) });
    }
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS the phone review's fixes: one read for screen and question, ⋯ at once, toasts let taps through, a message per agent, a lost reply gives up, the banner only after two misses and over the page, a composed word lands once, the commit caret stays, Usage stays put, big files in pages");
  // --- Notifications on this phone ----------------------------------------------------------
  {
    const { ctx, page, state } = await context(375, true, true);
    await goto(page, '#/settings', '#settings .group');
    const toggle = page.getByRole('switch', { name: 'Notifications on this phone' });
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await until('the subscription reaches Loom', () => state.push.sub);
    assert.deepEqual(state.push.sub, { endpoint: 'https://push.example/sub/1', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
    await page.getByRole('button', { name: 'Send a test', exact: true }).click();
    await until('the test', () => state.calls.some(c => c.cmd === 'remote' && c.argv.join(' ') === 'push test'));
    assert.equal(await toggle.isChecked(), true);
    for (const width of [320, 375, 768, 901, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await fits(page, width, 'settings-notifications-on');
    }
    await page.setViewportSize({ width: 375, height: 800 });
    assert.match(await page.evaluate(() => navigator.serviceWorker.ready.then(r => r.active.scriptURL)), /\/sw\.js$/);

    // A push, delivered to the worker as Chrome's push service would.
    const cdp = await ctx.newCDPSession(page);
    const regs = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => regs.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    await until('the worker registration', () => regs.some(r => r.scopeURL === `${base}/`));
    const registrationId = regs.find(r => r.scopeURL === `${base}/`).registrationId;
    const deliver = m => cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId, data: JSON.stringify(m) });
    const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data.url })));
    // A link names the pane and its ref (one from before a restart: "After Loom restarts on the PC").
    await deliver({ title: 'Beta:1 · Codex finished · 4 min', body: 'All tests pass.', url: '/#/pane/b1/Beta%3A1', tag: 'b1', at: Date.now() });
    await until('the notification shows', async () => (await shown()).length === 1);
    assert.deepEqual(await shown(), [{ title: 'Beta:1 · Codex finished · 4 min', body: 'All tests pass.', tag: 'b1', url: '/#/pane/b1/Beta%3A1' }]);
    // Loom's mark in the status bar, Loom's logo beside the text.
    assert.deepEqual(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => [new URL(n.badge).pathname, new URL(n.icon).pathname])), [['/badge.png', '/icon.png']]);
    assert.equal((await fetch(`${base}/badge.png`)).status, 200);

    // A tap: the worker sends the open page to the agent.
    await page.evaluate(() => (location.hash = '#/settings'));
    const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
    await sw.evaluate(async () => {
      const [n] = await self.registration.getNotifications();
      // ponytail: a made-up click can't waitUntil (it throws), but the handler's own work still runs.
      try { self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); } catch { /* see above */ }
    });
    await page.waitForFunction(() => location.hash === '#/pane/b1/Beta%3A1');
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    assert.deepEqual(await shown(), [], 'the tapped one closes');

    // Seen since it came: Alpha isn't waiting, so its old notification goes; a new one stays.
    await deliver({ title: 'Alpha:1 · Claude finished', body: 'Done.', url: '/#/pane/a1/Alpha%3A1', tag: 'a1', at: Date.now() - 20000 });
    await deliver({ title: 'Beta:1 · Codex asks', body: 'May I?', url: '/#/pane/b1/Beta%3A1', tag: 'b1', at: Date.now() });
    await until('the seen one closes', async () => (await shown()).map(n => n.tag).join() === 'b1', 6000);
    await page.waitForTimeout(2500);
    assert.deepEqual((await shown()).map(n => n.tag), ['b1'], 'a new one stays');

    // Off: Loom and the browser both let go.
    await goto(page, '#/settings', '#settings .group');
    await toggle.click();
    await until('Loom stops them', () => !state.push.on);
    await page.getByRole('button', { name: 'Send a test', exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS notifications on this phone: subscribe, a push shows, a tap opens the agent, seen ones close, off');
  // --- Restarting Loom from the phone ---------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    state.updated = true;
    await goto(page, '#/settings', '#settings .group');
    const restart = page.getByRole('button', { name: 'Restart to update', exact: true });
    await restart.waitFor();
    await fits(page, 375, 'settings-update-waiting');
    await restart.click();
    await page.locator('#sheet.on').filter({ hasText: 'the new version if you just updated' }).waitFor();
    const reloaded = page.waitForEvent('load', { timeout: 20000 });
    await sheetButton(page, 'Restart').click();
    await page.locator('#offline').filter({ hasText: 'Loom is restarting on the PC' }).waitFor();
    await fits(page, 375, 'restarting');
    state.updated = false; // the new Loom has no update waiting
    await reloaded;
    assert.deepEqual(state.calls.filter(c => c.cmd === 'relaunch').map(c => c.argv), [['--yes', '--booted', '1']]);
    await page.getByRole('button', { name: 'Restart', exact: true }).waitFor();
    assert.equal(await page.locator('#offline').isVisible(), false, 'back: no banner');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS restarting Loom from the phone: the update hint, a confirm, a banner while it restarts, a reload when it is back');
  // --- After Loom restarts on the PC -----------------------------------------------------------
  {
    // A warm tap on a notification sent by the new Loom: its pane id is newer than the list
    // the page read, so the page reads the list before resolving it.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/settings', '#settings .group');
    restartPc(state);
    await page.evaluate(() => (location.hash = '#/pane/new-b1/Beta%3A1'));
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    await page.waitForTimeout(2500);
    const reads = state.calls.filter(c => c.cmd === 'read').map(c => c.argv[0]);
    assert.ok(reads.includes('new-b1') && !reads.includes('b1'), `the new pane is read, never the old one: ${reads}`);
    assert.doesNotMatch(await header(page), /gone/);
    // One the old Loom sent: its pane id is from before the restart, and its sid finds Beta.
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.evaluate(() => (location.hash = '#/pane/b1/Beta%3A1/k-b1'));
    await page.waitForFunction(() => location.hash === '#/pane/new-b1/Beta%3A1/k-b1', null, { timeout: 8000 });
    assert.match(await header(page), /^Beta:1/);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Loom restarts on the PC while an agent is open: it follows the agent to its new pane id,
    // keeps the message being typed, and adds no history entry.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/b1', '#screen .line');
    await page.fill('#prompt textarea', 'half a message');
    const entries = await page.evaluate(() => history.length);
    restartPc(state);
    await page.waitForFunction(() => location.hash === '#/pane/new-b1/Beta%3A1/k-b1', null, { timeout: 8000 });
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    const since = state.calls.length;
    await page.waitForTimeout(1500);
    assert.ok(state.calls.slice(since).some(c => c.cmd === 'read' && c.argv[0] === 'new-b1'));
    assert.ok(!state.calls.slice(since).some(c => c.cmd === 'read' && c.argv[0] === 'b1'), 'the old id is no longer read');
    assert.equal(await page.inputValue('#prompt textarea'), 'half a message');
    assert.equal(await page.evaluate(() => history.length), entries);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Renamed on the PC while open, then Loom restarts: the agent is found by the name it has now.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1/Alpha%3A1', '#screen .line');
    state.renamed = true;
    await page.locator('#pane .who b').filter({ hasText: 'Renamed:1' }).waitFor();
    await page.waitForTimeout(2500); // a list read since the header changed
    restartPc(state);
    await page.waitForFunction(() => location.hash === '#/pane/new-a1/Renamed%3A1/k-a1', null, { timeout: 8000 });
    assert.match(await header(page), /^Renamed:1/);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS after a PC restart: a notification opens the new pane, old or new, and an open agent follows its new id, renamed too');

  // --- Agents' symbols come in the page's own font ---------------------------------------------------
  // A phone's fonts drew Claude's ⏵ and ← as boxes: the screen draws them with Loom Symbols.
  {
    const { ctx, page, state } = await context(375);
    state.screen = '⏵⏵ auto mode on · ← for agents';
    await goto(page, '#/pane/a1', '#screen .line');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#screen .line span' });
    let fonts = [];
    await until('the symbols in Loom Symbols', async () => (({ fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })), fonts.some(f => f.familyName === 'Loom Symbols' && f.isCustomFont && f.glyphCount === 3)))
      .catch(e => { throw new Error(`${e.message}: ${JSON.stringify(fonts)}`); });
    await ctx.close();
    console.log('PASS an agent\'s ⏵ and ← come in Loom Symbols');
  }
  // --- A pane closed on the PC stays gone, and its draft goes to no other agent ----------------------
  {
    const { ctx, page, state } = await context(375);
    state.siblings = true;
    await goto(page, '#/pane/a1/Alpha%3A1', '#screen .line');
    await page.fill('#prompt textarea', 'Draft for Claude');
    state.closeFirst = true; // Alpha:1 closed on the PC: its Codex sibling is Alpha:1 now
    await page.locator('#pane .who b').filter({ hasText: 'This agent is gone' }).waitFor();
    await page.waitForTimeout(2500); // another list read: still gone
    assert.equal(await page.evaluate(() => location.hash), '#/pane/a1/Alpha%3A1');
    assert.equal(await header(page), 'This agent is gone');
    await page.click('#prompt button.primary');
    await page.locator('#toast.error').filter({ hasText: 'No thread "a1"' }).waitFor();
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => c.argv[0]), ['a1'], 'the draft goes to no other agent');
    assert.equal(await page.inputValue('#prompt textarea'), 'Draft for Claude', 'and stays');
    // A link to it, as a notification from before it closed: gone too.
    await goto(page, '#/pane/a1/Alpha%3A1', '#pane .who b:has-text("This agent is gone")');
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => location.hash), '#/pane/a1/Alpha%3A1');
    assert.ok(!state.calls.some(c => c.argv?.[0] === 'a2'), 'nothing is asked of the sibling');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  // Closed, then Loom restarted before the phone looked: the sibling comes back as Alpha:1, a Codex,
  // a second Claude, or one on the same Claude session. No pane has the closed one's stableId, so
  // nothing takes its place or its draft.
  for (const [sibling, set] of [['a Codex', {}], ['a second Claude', { sameKind: true }], ['a Claude on the same session', { sameKind: true, sharedSid: true }]]) {
    const { ctx, page, state } = await context(375);
    Object.assign(state, { siblings: true }, set);
    await goto(page, '#/pane/a1/Alpha%3A1', '#screen .line');
    await page.fill('#prompt textarea', 'Draft intended for the first pane');
    restartPc(Object.assign(state, { closeFirst: true }));
    await page.locator('#pane .who b').filter({ hasText: 'This agent is gone' }).waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => location.hash), '#/pane/a1/Alpha%3A1', `${sibling} must not take its place`);
    await page.click('#prompt button.primary');
    await page.locator('#toast.error').filter({ hasText: 'No thread "a1"' }).waitFor();
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => [c.argv[0], c.stdin]), [['a1', 'Draft intended for the first pane']], `${sibling}: the draft goes to no other agent`);
    assert.equal(await page.inputValue('#prompt textarea'), 'Draft intended for the first pane', 'and stays');
    assert.ok(!state.calls.some(c => c.argv?.[0] === 'new-a2'), 'nothing is asked of the sibling');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Another thread named Alpha has a Claude at Alpha:1 too: the stableId tells them apart.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1/Alpha%3A1', '#screen .line');
    restartPc(Object.assign(state, { twins: true }));
    await page.waitForFunction(() => location.hash === '#/pane/new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    await page.waitForTimeout(1500);
    assert.ok(!state.calls.some(c => c.argv?.[0] === 'new-c1'), 'the twin is never read');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Its address keeps the stableId: after a second restart, the page reloaded from it finds the pane again.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1/Alpha%3A1/k-a1', '#screen .line');
    restartPc(state);
    await page.waitForFunction(() => location.hash === '#/pane/new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    // Hidden, the page reads nothing more until the reload.
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
    state.again = 1;
    await page.reload();
    await page.waitForFunction(() => location.hash === '#/pane/again-new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    assert.match(await header(page), /^Alpha:1/);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // A page showing a missing pane it knows no stableId for: a link for that same id with its stableId finds it.
    const { ctx, page, state } = await context(375);
    restartPc(state);
    state.again = 1;
    await goto(page, '#/pane/new-a1/Alpha%3A1', '#pane .who b:has-text("This agent is gone")');
    await page.evaluate(() => (location.hash = '#/pane/new-a1/Alpha%3A1/k-a1'));
    await page.waitForFunction(() => location.hash === '#/pane/again-new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    assert.match(await header(page), /^Alpha:1/);
    // And one it knows: a later link without the stableId doesn't forget it.
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    state.again = 2; // a third start
    await page.waitForTimeout(2500); // a list read while Settings is up
    await page.evaluate(() => (location.hash = '#/pane/again-new-a1/Alpha%3A1'));
    await page.waitForFunction(() => location.hash === '#/pane/again-again-new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    assert.match(await header(page), /^Alpha:1/);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a pane closed on the PC stays gone and keeps its draft, after an unseen restart too, whatever shares its name or session; the stableId follows the pane, in its address across restarts and reloads, and from a link for the id on show');

  // --- A link read late shows nothing once you moved on -------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1/Alpha%3A1', '#screen .line');
    restartPc(state);
    // A notification from the new Loom names a pane the list doesn't have: the list is read first, and held.
    state.hold.add('threads');
    await page.evaluate(() => (location.hash = '#/pane/new-b1/Beta%3A1'));
    await until('the list read for the link', () => state.held.threads);
    await page.evaluate(() => (location.hash = '#/pane/a1/Alpha%3A1'));
    // Meanwhile the next read finds Alpha's new pane.
    await page.waitForFunction(() => location.hash === '#/pane/new-a1/Alpha%3A1/k-a1', null, { timeout: 8000 });
    state.held.threads();
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => location.hash), '#/pane/new-a1/Alpha%3A1/k-a1');
    assert.match(await header(page), /^Alpha:1/, "Beta's late link must not take the screen");
    await page.fill('#prompt textarea', 'For Alpha');
    await page.click('#prompt button.primary');
    await until('the message', () => state.calls.some(c => c.cmd === 'submit'));
    assert.equal(state.calls.find(c => c.cmd === 'submit').argv[0], 'new-a1');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Beta open, then Settings; Loom restarts on the PC; a notification asks for Alpha. Reading the list
    // first must not follow Beta, the agent open before, in Alpha's place.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/b1/Beta%3A1', '#screen .line');
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    restartPc(state);
    const since = state.calls.length;
    await page.evaluate(() => (location.hash = '#/pane/new-a1/Alpha%3A1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => location.hash), '#/pane/new-a1/Alpha%3A1', 'the address asked for');
    assert.match(await header(page), /^Alpha:1/);
    await page.fill('#prompt textarea', 'For Alpha');
    await page.click('#prompt button.primary');
    await until('the message', () => state.calls.some(c => c.cmd === 'submit'));
    assert.equal(state.calls.find(c => c.cmd === 'submit').argv[0], 'new-a1');
    assert.ok(!state.calls.slice(since).some(c => c.argv?.[0] === 'new-b1'), 'Beta is never shown');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Beta open; Alpha:2 is added on the PC and its notification tapped before the list has it. While the
    // list is read, nothing typed, pressed, chosen or asked reaches Beta, and the message stays; then it
    // goes to Alpha:2.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/b1/Beta%3A1', '#screen .line');
    await page.click('#keys-btn');
    Object.assign(state, { added: true, blocked: [] });
    await page.evaluate(() => (location.hash = '#/pane/a3/Alpha%3A2/k-a3'));
    await until('the list read for the link', () => state.blocked.length);
    const since = state.calls.length;
    await page.fill('#prompt textarea', 'Message intended for Alpha:2');
    await page.click('#prompt button.primary');
    await page.locator('#keys [data-key=tab]').click();
    await page.locator('#keys input').pressSequentially('x');
    await page.waitForTimeout(500);
    assert.deepEqual(state.calls.slice(since).filter(c => c.argv?.includes('b1')), [], 'nothing reaches Beta');
    assert.equal(await page.locator('#question').isVisible(), false, "Beta's question is gone");
    await page.click('#more');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#sheet').isVisible(), false, 'no pane actions');
    assert.equal(await page.inputValue('#prompt textarea'), 'Message intended for Alpha:2', 'what was typed stays');
    assert.equal(await header(page), 'Opening the agent');
    for (const width of [320, 375, 768, 901, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await fits(page, width, 'notification-pending');
    }
    await page.setViewportSize({ width: 375, height: 800 });
    unblock(state);
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:2' }).waitFor();
    await page.click('#prompt button.primary');
    await until('the message', () => state.calls.some(c => c.cmd === 'submit'));
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => [c.argv[0], c.stdin]), [['a3', 'Message intended for Alpha:2']]);
    assert.ok(!state.calls.some(c => c.argv?.includes('b1') && c.key && c.cmd !== 'show' && c.cmd !== 'zoom'), 'Beta was never changed, past opening it');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // The same, left before the list came: back to Beta, the late read opens nothing, and Beta takes the message.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/b1/Beta%3A1', '#screen .line');
    Object.assign(state, { added: true, blocked: [] });
    await page.evaluate(() => (location.hash = '#/pane/a3/Alpha%3A2/k-a3'));
    await until('the list read for the link', () => state.blocked.length);
    await page.evaluate(() => (location.hash = '#/pane/b1/Beta%3A1'));
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    unblock(state);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => location.hash), '#/pane/b1/Beta%3A1');
    assert.match(await header(page), /^Beta:1/);
    assert.ok(!state.calls.some(c => c.argv?.includes('a3')), 'Alpha:2 is never opened');
    await page.fill('#prompt textarea', 'For Beta');
    await page.click('#prompt button.primary');
    await until('the message', () => state.calls.some(c => c.cmd === 'submit'));
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => c.argv[0]), ['b1']);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS a link whose list read completes late leaves the screen you moved to; after a restart a link opens its own agent, never the one open before; while a link's pane is looked up nothing reaches the agent open before");

  // --- Beta's question or actions, read late, stay Beta's ---------------------------------------------
  // Beta's question (menu) or its actions sheet (status) answers after you moved on: to a link's pane being
  // looked up, to another agent, or to Settings. Beta's buttons and sheet don't come back, and the ones
  // you then use answer the agent on show.
  for (const [where, hash, target] of [['a link being looked up', '#/pane/a3/Alpha%3A2/k-a3', 'a3'], ['another agent', '#/pane/a1/Alpha%3A1', 'a1'], ['Settings', '#/settings', 'b1']]) {
    for (const late of ['menu', 'status']) {
      const { ctx, page, state } = await context(375);
      await goto(page, '#/pane/b1/Beta%3A1', '#screen .line');
      // Beta's next read of its screen and question, or the status its actions ask for.
      if (late === 'menu') state.hold.add('menu');
      if (late === 'status') { state.hold.add('status'); await page.click('#more'); }
      await until(`Beta's ${late} is asked`, () => state.held[late]);
      Object.assign(state, { added: true }, target === 'a3' ? { blocked: [] } : {}); // Alpha:2 added on the PC since
      await page.evaluate(h => (location.hash = h), hash);
      if (target === 'a3') await until('the list read for the link', () => state.blocked.length);
      if (target === 'a1') await page.locator('#question button').first().waitFor(); // Alpha's own question
      state.held[late]();
      await page.waitForTimeout(500);
      const what = `${late} late, at ${where}`;
      assert.equal(await page.locator('#sheet').isVisible(), false, `${what}: Beta's actions don't open`);
      if (target === 'a3') assert.equal(await page.locator('#question').isVisible(), false, `${what}: Beta's question isn't drawn`);
      // Then the agent on show: Alpha:2 once read, Alpha:1, or Beta again after Settings.
      if (target === 'a3') { unblock(state); await page.locator('#pane .who b').filter({ hasText: 'Alpha:2' }).waitFor(); }
      if (target === 'b1') await page.evaluate(() => (location.hash = '#/pane/b1/Beta%3A1'));
      await page.locator('#question button').first().click();
      await page.click('#more');
      await sheetButton(page, 'Clear the input (Ctrl+U)').click();
      await until(`${what}: the answer and the key`, () => state.calls.some(c => c.cmd === 'choose') && state.calls.some(c => c.cmd === 'keys'));
      assert.deepEqual(state.calls.filter(c => c.cmd === 'choose' || c.cmd === 'keys').map(c => [c.cmd, c.argv[0], c.argv.at(-1)]),
        [['choose', target, `menu-${target}`], ['keys', target, 'ctrl-u']], `${what}: both answer the agent on show`);
      assert.deepEqual(state.errors, []);
      await ctx.close();
    }
  }
  console.log("PASS Beta's question or actions read late, after a link's lookup, another agent or Settings, never come back; the agent on show answers");

  // --- The agent opened on the phone comes up on the PC, once each visit ----------------------------------
  {
    // Back to the same agent after Settings, with the PC moved on meanwhile: it comes up and fills its thread again.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#question button');
    await until('Alpha zoomed on the PC', () => state.zoomed.has('a1'));
    await page.fill('#prompt textarea', 'kept for Alpha');
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    state.pcFront = 'b1'; // someone at the PC brings Beta up and puts Alpha back in its grid
    state.zoomed.delete('a1');
    const since = state.calls.length;
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    await until('Alpha zoomed again', () => state.zoomed.has('a1'));
    assert.equal(state.pcFront, 'a1', 'Alpha in front on the PC again');
    assert.equal(await page.inputValue('#prompt textarea'), 'kept for Alpha', 'the draft stays');
    // The reads every 2 s and every second bring nothing up.
    await page.waitForTimeout(2500);
    assert.deepEqual(state.calls.slice(since).filter(c => c.cmd === 'show' || c.cmd === 'zoom').map(c => `${c.cmd} ${c.argv[0]}`), ['show a1', 'zoom a1']);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // A show answered after you left the agent zooms nothing.
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    state.hold.add('show');
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await until("Alpha's show, held", () => state.held.show);
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    state.held.show();
    await page.waitForTimeout(1000);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'zoom'), [], 'no zoom once you left');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Alpha, Beta, Alpha again: the first visit's show, answered last, leaves Alpha zoomed (zoom toggles).
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    state.hold.add('show');
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await until("the first Alpha show, held", () => state.held.show);
    await page.evaluate(() => (location.hash = '#/pane/b1'));
    await until('Beta zoomed', () => state.zoomed.has('b1'));
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await until('Alpha zoomed', () => state.zoomed.has('a1'));
    state.held.show();
    await page.waitForTimeout(1000);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'zoom').map(c => c.argv[0]), ['b1', 'a1'], "the first visit's late show zooms nothing");
    assert.deepEqual([...state.zoomed].sort(), ['a1', 'b1']);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // A link left and opened again while its agent is looked up: only the last visit shows it, so it comes up once.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/b1/Beta%3A1', '#screen .line');
    await until('Beta zoomed', () => state.zoomed.has('b1'));
    Object.assign(state, { added: true, blocked: [] });
    await page.evaluate(() => (location.hash = '#/pane/a3/Alpha%3A2/k-a3'));
    await until('the list read for the link', () => state.blocked.length);
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    await page.evaluate(() => (location.hash = '#/pane/a3/Alpha%3A2/k-a3'));
    await until('the list read again', () => state.blocked.length >= 2);
    unblock(state);
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:2' }).waitFor();
    await page.waitForTimeout(1000);
    assert.deepEqual(state.calls.filter(c => (c.cmd === 'show' || c.cmd === 'zoom') && c.argv[0] === 'a3').map(c => c.cmd), ['show', 'zoom'], 'Alpha:2 comes up once');
    assert.ok(state.zoomed.has('a3'));
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS the agent opened on the phone comes up on the PC once each visit: again after Settings with its draft, never on the background reads, a show answered after you left or came back zooms nothing, and a link opened again while it is looked up comes up once');

  // --- A restart waits for the Loom that replaces the one asked ----------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/settings', '#settings .group');
    await page.getByRole('button', { name: 'Restart', exact: true }).waitFor();
    // Settings read booted 1; Loom has since restarted on the PC (2). The restart asked now
    // must wait for 3, not reload as soon as it sees 2.
    state.booted = 2;
    state.holdRestart = true;
    await page.evaluate(() => (window.samePage = true));
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await sheetButton(page, 'Restart').click();
    await page.locator('#offline').filter({ hasText: 'Loom is restarting on the PC' }).waitFor();
    await page.waitForTimeout(5000);
    assert.equal(await page.evaluate(() => window.samePage), true, 'no reload while Loom 2, the one asked, still answers');
    const reloaded = page.waitForEvent('load', { timeout: 10000 });
    state.booted = 3;
    await reloaded;
    assert.equal(state.calls.filter(c => c.cmd === 'relaunch').length, 1);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // Loom 1 takes the restart and goes, cutting off its answer. The retry, with the same key, reaches
    // Loom 2, which has none of Loom 1's keys: it must not restart too.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/settings', '#settings .group');
    state.loseRestartReply = true;
    const reloaded = page.waitForEvent('load', { timeout: 20000 });
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await sheetButton(page, 'Restart').click();
    await reloaded;
    await page.getByRole('button', { name: 'Restart', exact: true }).waitFor();
    await page.waitForTimeout(2000);
    const asked = state.calls.filter(c => c.cmd === 'relaunch');
    assert.equal(asked.length, 2, 'the cut-off request is asked again');
    assert.ok(asked[0].key && asked[0].key === asked[1].key, 'with its key');
    assert.deepEqual([state.restarts, state.booted], [1, 2], 'Loom 2 keeps running');
    assert.deepEqual(asked.map(c => c.argv), [['--yes', '--booted', '1'], ['--yes', '--booted', '1']], 'both name Loom 1');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a restart whose answer was lost restarts Loom once: the retry reaches its replacement, which keeps running');
  // Its confirm and the wait, at every width.
  for (const width of [320, 375, 768, 901, 1024, 1280]) {
    const { ctx, page, state } = await context(width);
    state.updated = true;
    state.holdRestart = true;
    await goto(page, '#/settings', '#settings .group');
    await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
    await page.locator('#sheet.on').filter({ hasText: 'Restart Loom?' }).waitFor();
    await page.waitForTimeout(400);
    await fits(page, width, 'restart-confirm');
    await sheetButton(page, 'Restart').click();
    await page.locator('#offline').filter({ hasText: 'Loom is restarting on the PC' }).waitFor();
    await fits(page, width, 'restart-pending');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a restart waits for the Loom that replaces the one asked; its confirm and wait fit every width');

  // --- A subscription made with Loom's old key is replaced at start -------------------------------
  {
    const { ctx, page, state } = await context(375, true, 'old-key');
    // The worker from an earlier visit, then the page as a phone opens it again.
    await page.goto(`${base}/#/settings`);
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    await page.reload();
    const subscribes = () => page.evaluate(() => Number(sessionStorage.getItem('test-subscribes') ?? 0));
    await until('the replacement reaches Loom', () => state.push.sub?.endpoint === 'https://push.example/sub/1');
    await page.getByRole('switch', { name: 'Notifications on this phone', checked: true }).waitFor();
    assert.equal(await subscribes(), 1, 'subscribed again once, with the current key');
    // Already on Loom's key: kept as it is.
    await page.reload();
    await page.locator('#settings .group').first().waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await subscribes(), 1, 'a subscription on the current key is kept');
    assert.equal(state.push.sub.endpoint, 'https://push.example/sub/1');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a subscription made with an old key is replaced at start, one on the current key is kept');

  // --- Dictation (docs/phone-dictation-study.md) ---------------------------------------------------
  const clips = state => state.clips.filter(c => c.bytes > 0);
  const box = page => page.inputValue('#prompt textarea');
  const hide = (page, hidden) => page.evaluate(h => { Object.defineProperty(document, 'hidden', { value: h, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  const micClosed = page => page.waitForFunction(() => window.opened?.getTracks().every(t => t.readyState === 'ended'), null, { timeout: 5000 });
  /** Taps the mic, lets the fake microphone record for `ms` once MediaRecorder runs, and taps stop. */
  async function dictate(page, ms = 1500) {
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.waitForTimeout(ms);
    await page.click('#rec .stop');
  }
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    await dictate(page);
    await until('the text in the box', async () => (await box(page)) === '/prompt run the tests');
    const [warm, clip] = state.clips;
    assert.deepEqual([warm.bytes, warm.lang], [0, null], 'an empty post warms the model as the mic opens');
    const [ms, secs] = [await page.evaluate(() => window.recorded.ms), clip.bytes / 32000];
    assert.ok(clip.bytes % 2 === 0 && Math.abs(secs - ms / 1000) < 0.3, `16-bit samples at 16 kHz: ${clip.bytes} bytes for ${Math.round(ms)} ms`);
    assert.deepEqual([clip.lang, clip.auth], ['en', 'Bearer fixture-token'], "the PC's language, with this phone's token");
    assert.ok(clip.peak > 0, 'the fake microphone was heard');
    await micClosed(page);
    assert.ok(!state.calls.some(c => c.cmd === 'submit'), 'a prefix without ⏎ waits for Send');
    // Onto a draft: after a space, with no prefix.
    await page.fill('#prompt textarea', 'also');
    await dictate(page, 500);
    await until('appended to the draft', async () => (await box(page)) === 'also run the tests');
    // French, then auto, picked in the sheet: the clip's language follows, and auto sends none.
    for (const [row, code, query] of [['French', 'fr', 'fr'], ['auto', '', null]]) {
      await page.click('#more');
      await page.locator('#sheet button', { hasText: 'Dictation ·' }).click();
      await page.locator('#sheet .dict-row .pick', { hasText: row }).click();
      await until(`${row} picked on the PC`, () => state.dictation.langs.find(l => l.on).code === code);
      await page.locator('#sheet .dict-row .pick[aria-pressed=true]', { hasText: row }).waitFor();
      await sheetButton(page, 'Done').click();
      await page.fill('#prompt textarea', '');
      const n = clips(state).length;
      await dictate(page, 500);
      await until(`the ${row} clip`, () => clips(state).length === n + 1);
      assert.equal(clips(state)[n].lang, query);
      await until('its text', async () => (await box(page)) === '/prompt run the tests');
    }
    // ⏎ on the prefix, from the sheet: what was said goes through submit.
    await page.click('#more');
    await page.locator('#sheet button', { hasText: 'Dictation ·' }).click();
    await page.getByRole('button', { name: '/prompt sends what was said' }).click();
    await until('⏎ on the PC', () => state.dictation.prefixes[0].enter);
    await sheetButton(page, 'Done').click();
    await page.fill('#prompt textarea', '');
    await dictate(page, 500);
    await until('the submit', () => state.calls.some(c => c.cmd === 'submit'));
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => [c.argv, c.stdin]), [[['a1', '-'], '/prompt run the tests']]);
    await until('the box empties once sent', async () => (await box(page)) === '');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // A full 6 MiB clip over a 0.2 Mbps uplink takes 252 s, which remote.rs allows (600 s from the first byte),
    // then 30 s of whisper. Clocks run 3000 times fast for the clip's deadline only (the page's other waits
    // are under 150 s): one try must outlast both, so the text lands.
    const { ctx, page, state } = await context(375);
    await ctx.addInitScript(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      window.postBudgets = [];
      AbortSignal.timeout = ms => (ms >= 150_000 ? (window.postBudgets.push(ms), timeout(ms / 3000)) : timeout(ms));
    });
    state.dictateDelay = Math.round((6 * 2 ** 20 * 8 / 200_000 + 30) * 1000 / 3000);
    await goto(page, '#/pane/a1', '#screen .line');
    await dictate(page);
    await until('the slow clip was heard', async () => (await box(page)) === '/prompt run the tests', 15000);
    assert.equal(clips(state).length, 1, 'one try was enough');
    const budgets = await page.evaluate(() => window.postBudgets);
    assert.ok(budgets.length && budgets.every(ms => ms >= 600_000 + 180_000), `each try waits out the server's 600 s and whisper: ${budgets}`);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS dictation: the clip is 16 kHz 16-bit samples with the PC\'s language, the text lands after the prefix or onto a draft, the sheet picks French and auto, and a ⏎ prefix submits it, and a full clip over a 0.2 Mbps uplink is heard in one try');
  {
    // A transcript that comes after you moved on is never sent, ⏎ or not: it waits as its agent's draft.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the clip is on its way', () => state.held.dictate);
    await page.evaluate(() => (location.hash = '#/pane/b1'));
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1' }).waitFor();
    await page.fill('#prompt textarea', 'for Beta');
    state.held.dictate();
    await page.locator('#toast').filter({ hasText: 'What you said to Alpha:1 is in its Message box.' }).waitFor();
    assert.equal(await box(page), 'for Beta', "Beta's box stays Beta's");
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    assert.equal(await box(page), '/prompt run the tests', "Alpha's draft");
    // Left for Settings with Alpha still the agent open: its box takes it, and it isn't sent either.
    await page.fill('#prompt textarea', '');
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the clip is on its way', () => state.held.dictate);
    await page.evaluate(() => (location.hash = '#/settings'));
    await page.locator('#settings .group').first().waitFor();
    state.held.dictate();
    await page.locator('#toast').filter({ hasText: 'What you said to Alpha:1' }).waitFor();
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    assert.equal(await box(page), '/prompt run the tests');
    await page.waitForTimeout(300);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit'), [], 'a late transcript is never sent');
    // Only agents have the mic, as on the PC.
    assert.ok(await page.locator('#mic').isVisible());
    state.shell = true;
    await page.evaluate(() => (location.hash = '#/pane/b1'));
    await page.locator('#pane .who b').filter({ hasText: 'Beta:1 · shell' }).waitFor();
    assert.ok(await page.locator('#mic').isHidden(), 'no mic on a shell');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a late transcript becomes its agent\'s draft, never sent, after another agent or Settings; no mic on a shell');
  {
    // Hiding the page stops the recording and transcribes it, without sending; cancel uploads nothing.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.waitForTimeout(700);
    await hide(page, true);
    await until('the clip goes', () => clips(state).length === 1);
    assert.ok(await page.locator('#rec').isHidden(), 'the bar goes with it');
    await micClosed(page);
    await until('its text', async () => (await box(page)) === '/prompt run the tests');
    await page.waitForTimeout(300);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit'), [], 'what a hidden page caught waits for Send');
    // Hidden while the microphone still opens: it closes once it has, and nothing goes.
    await hide(page, false);
    await page.evaluate(() => Object.assign(window, { holdMic: true, releaseMic: null }));
    await page.click('#mic');
    await page.waitForFunction(() => window.releaseMic);
    await hide(page, true);
    await page.evaluate(() => window.releaseMic());
    await micClosed(page);
    // Leaving the agent stops it too.
    await hide(page, false);
    await page.evaluate(() => (window.holdMic = false));
    await page.fill('#prompt textarea', '');
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.waitForTimeout(500);
    await page.evaluate(() => (location.hash = '#/settings'));
    await until('the clip of the agent left', () => clips(state).length === 2);
    await micClosed(page);
    await page.locator('#toast').filter({ hasText: 'What you said to Alpha:1' }).waitFor();
    // Cancel: the mic closes and nothing is sent to be transcribed.
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b').filter({ hasText: 'Alpha:1' }).waitFor();
    await page.fill('#prompt textarea', '');
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Cancel dictation' }).click();
    await micClosed(page);
    await page.waitForTimeout(800);
    assert.equal(clips(state).length, 2, 'a cancelled clip uploads nothing');
    assert.equal(await box(page), '');
    assert.ok(await page.locator('#rec').isHidden() && (await page.locator('#prompt').isVisible()), 'the box is back');
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit'), []);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS hiding the page or leaving the agent stops and transcribes without sending, a mic still opening closes once open, and cancel uploads nothing');
  {
    // Unpaired mid-dictation: the pairing form takes the screen, and the microphone closes with nothing sent
    // to be transcribed. First on dictation's own 401, the warm-up post's, while the microphone still opens.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    state.revoked = true;
    await page.evaluate(() => Object.assign(window, { holdMic: true, releaseMic: null }));
    await page.click('#mic');
    await page.locator('#pairing').waitFor();
    await page.waitForFunction(() => window.releaseMic);
    await page.evaluate(() => window.releaseMic());
    await micClosed(page);
    assert.ok(await page.locator('#rec').isHidden(), 'no recording bar left behind');
    // Paired again, then unpaired by a loomctl call's 401 (the screen's next read) while a clip records.
    state.revoked = false;
    await page.evaluate(() => (window.holdMic = false));
    await page.fill('#pairing input[name=code]', '123456');
    await page.locator('#pairing form').evaluate(f => f.requestSubmit());
    await page.locator('#screen .line').first().waitFor();
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    state.revoked = true;
    await page.locator('#pairing').waitFor();
    await micClosed(page);
    await page.waitForTimeout(500);
    assert.equal(clips(state).length, 0, 'what was recorded before the unpairing is never sent');
    assert.ok(await page.locator('#rec').isHidden());
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS unpairing on a dictation or loomctl 401 closes the microphone, one still opening included, and sends nothing');
  {
    // A recorder that can't start: its stream's tracks ended first (start() throws), or the encoder refuses
    // with the tracks live. The microphone closes, the box comes back, and the next tap records.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    for (const fault of ['endBeforeStart', 'failStart']) {
      await page.evaluate(f => Object.assign(window, { [f]: true, opened: null }), fault);
      await page.click('#mic');
      await page.waitForFunction(() => window.opened);
      await until(`${fault}: the box is back`, async () => (await page.locator('#rec').isHidden()) && (await page.locator('#prompt').isVisible()), 3000);
      await micClosed(page);
      await page.locator('#toast').filter({ hasText: "The microphone didn't record" }).waitFor();
      await page.evaluate(f => (window[f] = false), fault);
    }
    assert.equal(clips(state).length, 0, 'nothing recorded, nothing sent');
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.waitForTimeout(500);
    // The track ends mid-clip (a call takes the microphone): the recorder stops by itself, and what it
    // caught is transcribed but waits for Send, as when the page hides.
    await page.evaluate(() => window.opened.getTracks().forEach(t => t.stop()));
    await until('its text', async () => (await box(page)) === '/prompt run the tests');
    assert.ok(await page.locator('#rec').isHidden(), 'the bar goes with it');
    await page.waitForTimeout(300);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit'), []);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS a recorder that can't start closes the microphone and gives the box back, the next tap records, and one that stops by itself transcribes without sending");
  {
    // Two clips in flight, the first one's reply held until the second's has come: the text lands in the
    // order it was said, and the mic takes the second clip while the first is transcribing.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    state.heard = 'first sentence';
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the first clip is on its way', () => state.held.dictate);
    const first = state.held.dictate;
    state.heard = 'second sentence';
    await dictate(page, 500);
    await until('the second clip answered', () => clips(state)[1]?.answered);
    await page.waitForTimeout(300);
    assert.equal(await box(page), '', 'the second waits for the first');
    state.heard = 'first sentence';
    first();
    await until('both, in order', async () => (await box(page)) === '/prompt first sentence second sentence');
    // A clip that fails behind a held one costs only itself: the held one lands, and so does the next.
    await page.fill('#prompt textarea', '');
    state.held.dictate = null;
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the third clip is on its way', () => state.held.dictate);
    const third = state.held.dictate;
    state.failNext = true;
    await dictate(page, 500);
    await page.locator('#toast').filter({ hasText: 'whisper failed' }).waitFor();
    state.heard = 'third';
    third();
    await until('the held one lands', async () => (await box(page)) === '/prompt third');
    state.heard = 'fifth';
    await dictate(page, 500);
    await until('the next one lands', async () => (await box(page)) === '/prompt third fifth');
    assert.equal(clips(state).length, 5);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS two clips in flight land in the order they were said when the second is transcribed first, and a failed one holds up nothing');
  {
    // The first clip's recorder stops 2 s late, and the second is recorded and answered meanwhile: the
    // second still lands after it. Each text follows its clip's size, so it stays tied to its recording.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/pane/a1', '#screen .line');
    state.heard = bytes => (bytes > 20000 ? 'first sentence' : 'second sentence');
    await page.evaluate(() => (window.delayStop = 2000));
    await dictate(page, 1000);
    await page.evaluate(() => (window.delayStop = 0));
    await dictate(page, 350);
    await until('both clips', async () => (await box(page)).includes('first sentence') && (await box(page)).includes('second sentence'));
    assert.equal(await box(page), '/prompt first sentence second sentence');
    // A cancelled clip gives its place up: the next one lands.
    await page.fill('#prompt textarea', '');
    await page.evaluate(() => (window.recorded = null));
    await page.click('#mic');
    await page.waitForFunction(() => window.recorded);
    await page.getByRole('button', { name: 'Cancel dictation' }).click();
    await dictate(page, 1000);
    await until('the clip after a cancel', async () => (await box(page)) === '/prompt first sentence');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a clip whose recorder stops late still lands before the clip recorded after it, and a cancelled one holds up nothing');
  {
    // Two clips with a sending prefix, the first transcribed last: each goes as its own message, the second
    // once the first's submit has answered, so neither sentence goes twice.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    const sent = () => state.calls.filter(c => c.cmd === 'submit').map(c => c.stdin);
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the first clip is on its way', () => state.held.dictate);
    const first = state.held.dictate;
    state.heard = 'second sentence';
    await dictate(page, 500);
    await until('the second clip answered', () => clips(state)[1]?.answered);
    state.heard = 'first sentence';
    state.hold.add('submit');
    first();
    await until('the first submit is on its way', () => state.held.submit);
    await page.waitForTimeout(300);
    assert.deepEqual(sent(), ['/prompt first sentence'], 'the second waits for the first to go');
    state.held.submit();
    await until('the second goes', () => sent().length === 2);
    assert.deepEqual(sent(), ['/prompt first sentence', '/prompt second sentence']);
    await until('the box empties', async () => (await box(page)) === '');
    // The first refused: its text stays in the box, and the second is not dropped but joins it there and
    // waits for Send, as after a send whose answer was lost.
    state.held.dictate = null;
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the third clip is on its way', () => state.held.dictate);
    const third = state.held.dictate;
    state.heard = 'fourth sentence';
    await dictate(page, 500);
    await until('the fourth clip answered', () => clips(state)[3]?.answered);
    state.heard = 'third sentence';
    state.refuseSend = true;
    third();
    await until('the fourth joins the third', async () => (await box(page)) === '/prompt third sentence fourth sentence');
    await page.waitForTimeout(300);
    assert.deepEqual(sent().slice(2), ['/prompt third sentence'], 'the box waits for Send');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS two clips with a sending prefix go as two messages, the second once the first has gone, and after a refused one it joins the kept draft and waits for Send');
  {
    // A sending clip whose answers are all lost: Loom took it once (its key's retries add nothing), but the
    // phone can't tell, so its text stays in the box. The next clip joins it there and waits for Send: sent
    // under a new key, the box would give the agent the first sentence twice.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    const submits = () => state.calls.filter(c => c.cmd === 'submit');
    const accepted = () => [...new Map(submits().map(c => [c.key, c.stdin])).values()]; // one task per key, as Loom keeps them
    state.hold.add('dictate');
    await dictate(page, 500);
    await until('the first clip is on its way', () => state.held.dictate);
    const first = state.held.dictate;
    state.heard = 'second sentence';
    await dictate(page, 500);
    await until('the second clip answered', () => clips(state)[1]?.answered);
    state.heard = 'first sentence';
    state.loseAcks = true;
    first();
    await until('four tries with the first key', () => submits().length >= 4, 15000);
    await until('the second clip lands', async () => (await box(page)).includes('second sentence') || submits().length > 4, 15000);
    await page.waitForTimeout(500);
    assert.deepEqual(accepted(), ['/prompt first sentence'], 'the agent got the first sentence once');
    assert.equal(submits().length, 4, 'four tries, all with the first key');
    assert.equal(await box(page), '/prompt first sentence second sentence', 'both sentences wait in the box');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS after a send whose answers were all lost, the next clip waits in the box with it instead of sending it again under a new key');
  {
    // The next clip recorded while the first is being sent: the first's text, on its way, is no draft for the
    // clip to join. Once that send answers, the second goes too, as its own message after the prefix.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    const sent = () => state.calls.filter(c => c.cmd === 'submit').map(c => c.stdin);
    state.heard = 'first sentence';
    state.hold.add('submit');
    await dictate(page, 500);
    await until('the first send is waiting for its answer', () => state.held.submit);
    assert.equal(await box(page), '/prompt first sentence');
    state.heard = 'second sentence';
    await dictate(page, 500);
    await until('the second clip answered', () => clips(state)[1]?.answered);
    await page.waitForTimeout(300);
    assert.equal(await box(page), '/prompt first sentence', 'the second waits for the first send');
    state.held.submit();
    await until('the second goes', () => sent().length === 2);
    assert.deepEqual(sent(), ['/prompt first sentence', '/prompt second sentence']);
    await until('the box empties', async () => (await box(page)) === '');
    // The same, but every answer to the third's send is lost: its text stays, so the fourth, recorded while
    // it was on its way, joins it and waits for Send rather than sending it again under a new key.
    state.heard = 'third sentence';
    state.loseAcks = true;
    await dictate(page, 500);
    await until('the third send is on its way', () => sent().length === 3);
    state.heard = 'fourth sentence';
    await dictate(page, 500);
    await until('the fourth clip lands', async () => (await box(page)).includes('fourth sentence') || sent().length > 6, 15000);
    await page.waitForTimeout(500);
    const accepted = [...new Map(state.calls.filter(c => c.cmd === 'submit').map(c => [c.key, c.stdin])).values()];
    assert.deepEqual(accepted, ['/prompt first sentence', '/prompt second sentence', '/prompt third sentence'], 'the third once');
    assert.equal(sent().length, 6, "four tries with the third's key");
    assert.equal(await box(page), '/prompt third sentence fourth sentence');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS a clip recorded while the one before it is being sent goes too, after its prefix, once that send answers, and waits in the box when the answers to that send are lost');

  // --- The full review's phone findings (docs/reviews/LOOM_FULL_REVIEW_CLAUDE_OPUS55_2026-10-08_113559.md) ---
  const submitted = state => state.calls.filter(c => c.cmd === 'submit').map(c => c.stdin);
  {
    // R4: every path goes after a bare --, so loomctl reads a file named like an option as a file. Delete on a
    // new file named --staged sent `discard --untracked --staged --yes`: every staged change and new file went.
    const { ctx, page, state } = await context(375);
    state.flagFile = true;
    await goto(page, '#/changes/a', '#changes .file');
    const viaSheet = async (name, action, label, confirm) => {
      const n = git(state, action).length;
      await page.locator('#changes .file', { has: page.locator('.open b', { hasText: name }) }).first().locator('.icon-btn').click();
      await sheetButton(page, label).click();
      if (confirm) await sheetButton(page, confirm).click();
      await until(`git ${action}`, () => git(state, action).length === n + 1);
      return git(state, action).at(-1).argv;
    };
    const deleted = await viaSheet('--staged', 'discard', 'Delete', 'Delete');
    assert.deepEqual(parsed(deleted), { words: ['a', 'discard', '--staged'], flags: ['--untracked', '--yes'] }, 'Delete names the file --staged');
    assert.deepEqual(deleted, ['a', 'discard', '--untracked', '--yes', '--', '--staged']);
    assert.deepEqual(await viaSheet('--staged', 'stage', 'Stage'), ['a', 'stage', '--untracked', '--', '--staged']);
    assert.deepEqual(await viaSheet('staged.txt', 'unstage', 'Unstage'), ['a', 'unstage', '--', 'staged.txt']);
    assert.deepEqual(await viaSheet('alpha.txt', 'discard', 'Discard changes', 'Discard'), ['a', 'discard', '--unstaged', '--yes', '--', 'alpha.txt']);
    assert.deepEqual(await viaSheet('conflict.txt', 'resolve', 'Keep ours'), ['a', 'resolve', 'ours', '--', 'conflict.txt']);
    assert.deepEqual(await viaSheet('conflict.txt', 'resolve', 'Keep theirs'), ['a', 'resolve', 'theirs', '--', 'conflict.txt']);
    assert.deepEqual(await viaSheet('conflict.txt', 'stage', 'Mark resolved'), ['a', 'stage', '--', 'conflict.txt']);
    // The reads that name a file: its diff, the whole file, and the diff screen's Stage this file.
    await page.evaluate(() => (location.hash = '#/diff/a/untracked/--staged'));
    await page.locator('#diff button', { hasText: 'Stage this file' }).waitFor();
    assert.deepEqual(git(state, 'diff').at(-1).argv, ['a', 'diff', '--untracked', '--', '--staged']);
    await page.locator('#diff .top button', { hasText: 'Whole file' }).click();
    await until('the whole file', () => git(state, 'diff').at(-1).argv.includes('--full'));
    assert.deepEqual(git(state, 'diff').at(-1).argv, ['a', 'diff', '--untracked', '--full', '--', '--staged']);
    await page.waitForTimeout(300); // drawn again, its Stage this file too
    const stages = git(state, 'stage').length;
    await page.locator('#diff button', { hasText: 'Stage this file' }).click();
    await until('Stage this file', () => git(state, 'stage').length === stages + 1);
    assert.deepEqual(git(state, 'stage').at(-1).argv, ['a', 'stage', '--untracked', '--', '--staged']);
    await page.locator('#toast', { hasText: 'Staged' }).waitFor();
    await page.waitForTimeout(300); // it goes Back to the summary
    await page.evaluate(() => (location.hash = '#/file/a/--staged'));
    await until('the file', () => git(state, 'file').length);
    assert.deepEqual(git(state, 'file')[0].argv, ['a', 'file', '--', '--staged']);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R4: stage, unstage, discard, resolve, diff, file and Stage this file put the path after --, so a file named --staged is that file');
  {
    // R5: a commit lets its message go, stored and on screen, before the summary redraws. Kept, a second tap ran
    // `git add -A` and committed everything Only staged had left out, under the same message.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/changes/a', '#changes .composer textarea');
    const box = page.locator('#changes .composer textarea');
    const commit = page.locator('#changes .composer .row button', { hasText: /^Commit$/ });
    const stored = () => page.evaluate(() => localStorage.getItem('loom-commit-a'));
    await box.fill('Fix the login');
    await page.locator('#changes .composer .seg button', { hasText: 'Only staged' }).click();
    await commit.click();
    await page.locator('#toast', { hasText: 'Committed' }).waitFor();
    assert.equal(await box.inputValue(), '', 'the box is empty');
    assert.equal(await stored(), null, 'so is the stored draft');
    await commit.click();
    await page.waitForTimeout(500);
    assert.deepEqual(git(state, 'commit').map(c => [c.argv.slice(1), c.stdin]), [[['commit', '-', '--staged'], 'Fix the login']], 'a second tap commits nothing');
    // A commit on its way while an agent writes a file, which redraws the box: the redrawn Commit waits too.
    await box.fill('Second change');
    state.hold.add('a commit');
    await commit.click();
    await until('the commit is on its way', () => state.held['a commit']);
    state.gitChurn = 1;
    await page.locator('#changes [aria-label=Refresh]').click();
    await page.locator('#changes .file', { hasText: 'made-1' }).waitFor();
    assert.equal(await commit.isDisabled(), true, 'the redrawn Commit waits for the one on its way');
    state.held['a commit']();
    await until('Commit is back', async () => !(await commit.isDisabled()));
    assert.equal(git(state, 'commit').length, 2);
    assert.equal(await box.inputValue(), '');
    // Amend takes the box's message, and lets it go too.
    await box.fill('Better message');
    await page.locator('#changes [aria-label="Git actions"]').click();
    await sheetButton(page, 'Amend last commit').click();
    await sheetButton(page, 'Amend').click();
    await page.locator('#toast', { hasText: 'Amended' }).waitFor();
    assert.deepEqual(git(state, 'amend').map(c => [c.argv.slice(1), c.stdin]), [[['amend', '--yes', '-'], 'Better message']]);
    assert.equal(await box.inputValue(), '', 'amended: the box is empty');
    assert.equal(await stored(), null);
    // One typed while the commit was on its way stays.
    await box.fill('Third change');
    state.hold.add('a commit');
    await commit.click();
    await until('the third commit is on its way', () => state.held['a commit']);
    await box.fill('Next message, typed meanwhile');
    state.held['a commit']();
    await until('Commit is back', async () => !(await commit.isDisabled()));
    assert.equal(await box.inputValue(), 'Next message, typed meanwhile');
    assert.equal(await stored(), 'Next message, typed meanwhile');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R5: a commit or amend empties the box before the redraw, a second tap commits nothing, a redrawn Commit waits for the one on its way, and a message typed meanwhile stays');
  for (const width of [375, 1280]) {
    // R6: New thread between two agents hands the first one's draft to neither the second nor the void.
    const { ctx, page, state } = await context(width);
    await goto(page, '#/pane/a1', '#screen .line');
    await page.fill('#prompt textarea', 'for alpha only');
    if (width < 900) await page.locator('#pane .back').click();
    await page.locator('#list .fab').click();
    await page.locator('#new form').waitFor();
    if (width < 900) await page.locator('#new .back').click();
    await page.locator('#list .agent[data-id=b1]').click();
    await page.locator('#pane .who b', { hasText: 'Beta:1' }).waitFor();
    assert.equal(await box(page), '', `${width}: Alpha's draft isn't Beta's`);
    await page.click('#prompt button.primary');
    await page.waitForTimeout(300);
    assert.deepEqual(submitted(state), [], 'Send on the empty box sends nothing');
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b', { hasText: 'Alpha:1' }).waitFor();
    assert.equal(await box(page), 'for alpha only', `${width}: Alpha keeps it`);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS R6: visiting New thread keeps each agent's draft its own, at 375 and 1280 px");
  {
    // R7: a clip that lands while a typed send to the same agent is on its way waits for that send. Read before,
    // it joined the text being sent, the box was never cleared, and the next Send gave the agent it again.
    const { ctx, page, state } = await context(375);
    state.dictation.prefixes[0].enter = true;
    await goto(page, '#/pane/a1', '#screen .line');
    await page.fill('#prompt textarea', 'typed message');
    state.hold.add('submit');
    await page.click('#prompt button.primary');
    await until('the typed send is on its way', () => state.held.submit);
    state.heard = 'next message';
    await dictate(page, 500);
    await until('the clip answered', () => clips(state)[0]?.answered);
    await page.waitForTimeout(300);
    assert.equal(await box(page), 'typed message', 'the clip waits for the send');
    state.held.submit();
    await until('the clip goes', () => submitted(state).length === 2);
    assert.deepEqual(submitted(state), ['typed message', '/prompt next message'], 'each once, the clip after its prefix');
    await until('the box empties', async () => (await box(page)) === '');
    // Refused, the typed text stays, and the clip joins it and waits for Send.
    await page.fill('#prompt textarea', 'refused message');
    Object.assign(state, { refuseSend: true, held: {} });
    state.hold.add('submit');
    await page.click('#prompt button.primary');
    await until('the refused send is on its way', () => state.held.submit);
    state.heard = 'more';
    await dictate(page, 500);
    await until('the second clip answered', () => clips(state)[1]?.answered);
    state.held.submit();
    await until('the clip joins the kept text', async () => (await box(page)) === 'refused message more');
    await page.waitForTimeout(300);
    assert.deepEqual(submitted(state), ['typed message', '/prompt next message', 'refused message'], 'nothing more goes');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R7: a clip landing during a typed send waits for it, then goes alone after its prefix, or joins the text a refusal kept');
  {
    // R8: an Activity reply goes once, however often Send or Enter is pressed while it is on its way, a redrawn card too.
    const { ctx, page, state } = await context(375);
    await goto(page, '', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const card = page.locator('#list .card[data-pane=a1]');
    await card.locator('.reply input').fill('looks good');
    state.hold.add('submit');
    await card.locator('.reply button.primary').click();
    await until('the reply is on its way', () => state.held.submit);
    assert.equal(await card.locator('.reply button.primary').isDisabled(), true, 'Send waits for it');
    await card.locator('.reply input').press('Enter');
    await page.locator('#list .find input').focus(); // out of the box, so its card is redrawn
    state.changedTitle = true;
    await page.locator('#list .card').filter({ hasText: 'Another agent has changed its title' }).waitFor({ timeout: 5000 });
    assert.equal(await card.locator('.reply button.primary').isDisabled(), true, "the redrawn card's Send waits too");
    await card.locator('form').evaluate(f => f.requestSubmit());
    await page.waitForTimeout(300);
    state.held.submit();
    await page.locator('#toast', { hasText: 'Sent' }).waitFor();
    await until('Send is back', async () => !(await card.locator('.reply button.primary').isDisabled()));
    assert.deepEqual(submitted(state), ['looks good'], 'one reply');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R8: an Activity reply goes once while it is on its way, its Send waiting, on a redrawn card too');
  {
    // R21: the rebase's Skip asks first, as Abort does.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/changes/a', '#changes .midway');
    const skip = page.locator('#changes .midway button', { hasText: 'Skip' });
    await skip.click();
    await page.locator('#sheet.on h2', { hasText: 'Skip this commit?' }).waitFor({ timeout: 2000 });
    await close(page);
    await page.waitForTimeout(300);
    assert.deepEqual(git(state, 'skip'), [], 'Cancel skips nothing');
    await skip.click();
    await sheetButton(page, 'Skip').click();
    await until('the skip', () => git(state, 'skip').length);
    assert.deepEqual(git(state, 'skip').map(c => c.argv), [['a', 'skip', '--yes']]);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS R21: the rebase's Skip asks first, and Cancel skips nothing");
  {
    // R24: Unpair all, refused, unpairs nothing: this phone keeps its token and its screens (it showed the pairing form).
    const { ctx, page, state } = await context(375);
    await goto(page, '#/settings', '#settings .group');
    state.refuseRevoke = true;
    await page.getByRole('button', { name: 'Unpair all', exact: true }).click();
    await sheetButton(page, 'Unpair all').click();
    await page.locator('#toast.error', { hasText: "Loom couldn't save the paired phones." }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#pairing').isVisible(), false, 'no pairing form');
    assert.equal(await page.evaluate(() => localStorage.getItem('loom-token')), 'fixture-token', 'the token is kept');
    assert.ok(await page.locator('#settings').isVisible());
    // Each phone listed, this one first, and removed one at a time: another goes from the list; this one goes back to pairing.
    state.refuseRevoke = false;
    state.devices = DEVICES();
    await page.evaluate(() => (location.hash = '#/')); // Settings opened again reads the phones
    await goto(page, '#/settings', '#settings .setting.phone');
    const rows = page.locator('#settings .setting.phone');
    const shown = await rows.evaluateAll(rs => rs.map(r => [r.querySelector('b span').textContent, r.querySelector('.what > span').textContent, r.querySelector('b svg')?.getAttribute('aria-label') ?? '']));
    assert.equal(shown[0][0], 'Pixel 8 · Chrome');
    assert.match(shown[0][1], /^This phone · Paired \S+ \S+$/);
    assert.equal(shown[0][2], 'Notifications on');
    assert.deepEqual([shown[1][0], shown[1][2]], [PHONE, 'Notifications on']);
    assert.match(shown[1][1], /^Paired \S+ \S+ · Seen 3h ago$/);
    assert.deepEqual(shown[2], ['A phone', 'Never seen', '']);
    await page.getByRole('button', { name: `Remove ${PHONE}`, exact: true }).click();
    await page.locator('#sheet.on h2', { hasText: `Remove ${PHONE}?` }).waitFor();
    await sheetButton(page, 'Remove').click();
    await until('two phones left', async () => (await rows.count()) === 2);
    assert.deepEqual(state.calls.filter(c => c.cmd === 'remote' && c.argv[0] === 'revoke').map(c => c.argv), [['revoke'], ['revoke', 'a1b2c3d4e5f6']]);
    assert.equal(await page.locator('#pairing').isVisible(), false, 'another phone removed: this one stays');
    await page.getByRole('button', { name: 'Remove Pixel 8 · Chrome', exact: true }).click();
    await sheetButton(page, 'Remove').click();
    await page.locator('#pairing').waitFor({ state: 'visible', timeout: 5000 });
    assert.deepEqual(state.calls.filter(c => c.cmd === 'remote' && c.argv[0] === 'revoke').at(-1).argv, ['revoke', MINE]);
    assert.equal(await page.evaluate(() => localStorage.getItem('loom-token')), null, 'this phone forgot its token');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R24: a refused Unpair all keeps this phone paired; each phone is listed, this one first with its bell, and Remove takes one, this one back to pairing');
  {
    // R26: a context reply that comes after you opened another agent's stays off its screen.
    const { ctx, page, state } = await context(375);
    await goto(page, '#/usage', '#usage .ctx-row');
    state.hold.add('context');
    await page.evaluate(() => (location.hash = '#/context/a1'));
    await until("Alpha's context, held", () => state.held.context);
    await page.evaluate(() => (location.hash = '#/context/b1'));
    await page.locator('#context .limit .label', { hasText: '55k' }).waitFor();
    state.held.context();
    await page.waitForTimeout(600);
    assert.match(await page.locator('#context .who b').innerText(), /^Beta:1/);
    assert.match(await page.locator('#context .limit .label').innerText(), /^55k of/, "Alpha's late numbers stay off Beta's screen");
    // Fit Loom to phone zooms by show's own reply: the list, which says nothing is zoomed, unzoomed the agent it meant to fill.
    await goto(page, '#/pane/a1', '#screen .line');
    await until('Alpha zoomed on the PC', () => state.zoomed.has('a1'));
    await page.click('#more');
    await sheetButton(page, 'Fit Loom to phone').click();
    await page.locator('#toast', { hasText: 'Loom fits the phone now' }).waitFor();
    assert.ok(state.zoomed.has('a1'), 'Alpha still fills its thread');
    assert.deepEqual(state.calls.filter(c => c.cmd === 'zoom').map(c => c.argv[0]), ['a1'], 'zoomed once, on opening it');
    // Back to the desktop size: unzoomed.
    await page.click('#more');
    await sheetButton(page, 'Desktop size on the PC').click();
    await page.locator('#toast', { hasText: 'Loom is back at its desktop size' }).waitFor();
    assert.ok(!state.zoomed.has('a1'), 'unzoomed with the desktop size');
    // One send on its way holds only its own agent's Send.
    await page.fill('#prompt textarea', 'for Alpha');
    state.hold.add('submit');
    await page.click('#prompt button.primary');
    await until("Alpha's send is on its way", () => state.held.submit);
    await page.evaluate(() => (location.hash = '#/pane/b1'));
    await page.locator('#pane .who b', { hasText: 'Beta:1' }).waitFor();
    assert.equal(await page.locator('#prompt button.primary').isDisabled(), false, "Beta's Send doesn't wait for Alpha's");
    await page.fill('#prompt textarea', 'for Beta');
    await page.click('#prompt button.primary');
    await until("Beta's send", () => submitted(state).includes('for Beta'));
    await page.evaluate(() => (location.hash = '#/pane/a1'));
    await page.locator('#pane .who b', { hasText: 'Alpha:1' }).waitFor();
    assert.equal(await page.locator('#prompt button.primary').isDisabled(), true, "Alpha's waits for its own");
    state.held.submit();
    await until("Alpha's Send is back", async () => !(await page.locator('#prompt button.primary').isDisabled()));
    assert.deepEqual(state.calls.filter(c => c.cmd === 'submit').map(c => [c.argv[0], c.stdin]), [['a1', 'for Alpha'], ['b1', 'for Beta']]);
    assert.equal(await box(page), '');
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS R26: a late context reply stays off another agent's screen, Fit Loom to phone zooms by show's reply, and one send on its way holds only its own agent's Send");
  {
    // R28: with Plan usage off on the PC, Usage asks no account (`usage` did, every 5 minutes), says so, and turns it on.
    const { ctx, page, state } = await context(375);
    state.planUsage = 'off';
    await goto(page, '#/usage', '#usage .provider:has-text("Plan usage is off")');
    assert.ok((await page.locator('#usage .ctx-row').count()) > 0, "each agent's context still shows");
    assert.equal(await page.locator('#usage [aria-label=Refresh]').isVisible(), false, 'no refresh of what nobody reads');
    await page.waitForTimeout(2500); // the threads' reads, which redraw Usage
    assert.deepEqual(state.calls.filter(c => c.cmd === 'usage'), [], 'no account is asked');
    await page.locator('#usage .provider').getByRole('button', { name: 'Turn on', exact: true }).click();
    await until('Plan usage on, on the PC', () => state.planUsage === 'on');
    await page.locator('#usage .provider .limit').first().waitFor();
    assert.equal(state.calls.filter(c => c.cmd === 'usage').length, 1);
    assert.equal(await page.locator('#usage .provider', { hasText: 'Plan usage is off' }).count(), 0);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS R28: with Plan usage off, Usage asks no account, says it is off with each agent\'s context still shown, and turns it on');

  // --- Changes sections fold ------------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await goto(page, '#/changes/a', '#changes .file');
    const head = name => page.locator('#changes .fold-head', { hasText: name });
    const rows = () => page.locator('#changes .file').allInnerTexts();
    assert.equal(await head('New files').getAttribute('aria-expanded'), 'true');
    await head('New files').click();
    await until('New files folds', async () => !(await rows()).some(r => r.includes('new.txt')));
    assert.equal(await head('New files').getAttribute('aria-expanded'), 'false');
    assert.ok((await rows()).some(r => r.includes('staged.txt')) && (await rows()).some(r => r.includes('alpha.txt')), 'the other sections stay open');
    // Folded, its Stage all still stages what it holds.
    await page.locator('#changes .section-title', { hasText: 'New files' }).getByRole('button', { name: 'Stage all', exact: true }).click();
    await until('Stage all ran', () => git(state, 'stage').some(c => c.argv.includes('--untracked')));
    // Kept on this phone: still folded after a reload, and on another thread.
    await page.reload();
    await page.locator('#changes .file').first().waitFor();
    assert.equal(await head('New files').getAttribute('aria-expanded'), 'false');
    assert.ok(!(await rows()).some(r => r.includes('new.txt')));
    await goto(page, '#/changes/b', '#changes .file');
    assert.equal(await head('New files').getAttribute('aria-expanded'), 'false', "a fold is the phone's, not the thread's");
    await head('New files').click();
    await until('New files opens', async () => (await rows()).some(r => r.includes('new.txt')));
    await page.screenshot({ path: resolve(out, '375-changes-fold.png') });
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log("PASS Changes: each section folds from its title and opens again, its Stage all still works folded, and the folds stay on this phone across a reload and threads");

  // --- Images from the phone -------------------------------------------------------------
  {
    const { ctx, page, state } = await context(375);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await goto(page, '#/pane/a1', '#screen .line');
    const shots = () => page.locator('#dock .shot').count();
    const clipboard = what => page.evaluate(async ([url, text]) => {
      const item = url ? { 'image/png': await (await fetch(url)).blob() } : { 'text/plain': new Blob([text], { type: 'text/plain' }) };
      await navigator.clipboard.write([new ClipboardItem(item)]);
    }, what);
    // Paste image reads the clipboard itself: Chrome on Android offers no Paste in a text box for an image alone.
    await clipboard([PNG.url]);
    await page.click('#image-btn'); await sheetButton(page, 'Paste image').click();
    await until('the pasted image waits over the box', async () => (await shots()) === 1);
    await clipboard([null, 'just words']);
    await page.click('#image-btn'); await sheetButton(page, 'Paste image').click();
    await page.locator('#toast.error', { hasText: 'The clipboard holds no image.' }).waitFor();
    // The system's Paste, where it does fire with an image (a desktop browser, a keyboard's clipboard).
    await page.evaluate(async url => {
      const dt = new DataTransfer();
      dt.items.add(new File([await (await fetch(url)).blob()], 'pasted.png', { type: 'image/png' }));
      document.querySelector('#prompt textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG.url);
    await until('the pasted file joins it', async () => (await shots()) === 2);
    // Picked from the phone: a photo joins them, a HEIC Loom can't take is refused at once.
    await attach(page, '#prompt', JPG);
    await until('the photo joins them', async () => (await shots()) === 3);
    await attach(page, '#prompt', [{ name: 'IMG_0001.heic', mimeType: 'image/heic', buffer: Buffer.from('....ftypheic') }]);
    await page.locator('#toast.error', { hasText: 'Loom takes PNG, JPEG, WebP and GIF images.' }).waitFor();
    assert.equal(await shots(), 3);
    // Its remove takes one off: the file pasted second.
    await page.getByRole('button', { name: 'Remove image 2', exact: true }).click();
    assert.equal(await shots(), 2);
    await page.screenshot({ path: resolve(out, '375-images-pasted.png') });
    // Each agent keeps its own, as its draft.
    await page.evaluate(() => (location.hash = '#/pane/b1')); await page.locator('#pane .who b', { hasText: 'Beta:1' }).waitFor();
    assert.equal(await shots(), 0, "Alpha's images aren't Beta's");
    await page.evaluate(() => (location.hash = '#/pane/a1')); await page.locator('#pane .who b', { hasText: 'Alpha:1' }).waitFor();
    assert.equal(await shots(), 2, "Alpha's come back with it");
    // An image Loom refuses keeps the message and its images, and sends nothing.
    await page.fill('#prompt textarea', 'what is wrong here?');
    state.failImage = true;
    await page.click('#prompt button.primary');
    await page.locator('#toast.error', { hasText: 'Loom takes PNG' }).waitFor();
    assert.deepEqual(submitted(state), []);
    assert.equal(await shots(), 2);
    assert.equal(await box(page), 'what is wrong here?');
    // Sent: each image as it was, then one message, the text and then their paths.
    state.images.length = 0;
    state.hold.add('image');
    await page.click('#prompt button.primary');
    await until('the first image is on its way', () => state.held.image);
    // One added while they go stays for the next message.
    await attach(page, '#prompt', PNG);
    state.held.image();
    await until('the message went', () => submitted(state).length === 1);
    const path = n => `C:\\Users\\test\\AppData\\Roaming\\dev.ayoub.loom\\phone-images\\${n}-ab12cd34.png`;
    assert.equal(state.images.length, 2);
    assert.deepEqual(state.images.map(i => [i.type, i.auth]), [['image/png', 'Bearer fixture-token'], ['image/jpeg', 'Bearer fixture-token']]);
    assert.ok(state.images[0].bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'the clipboard image is a PNG');
    assert.ok(state.images[1].bytes.equals(JPG.buffer), 'the photo goes byte for byte');
    assert.equal(submitted(state)[0], `what is wrong here? ${path(1)} ${path(2)}`);
    await until('the box is empty but for the image added meanwhile', async () => (await box(page)) === '' && (await shots()) === 1);
    // An image alone: its path is the message.
    await page.click('#prompt button.primary');
    await until('the image went alone', () => submitted(state).length === 2);
    assert.equal(submitted(state)[1], path(3));
    await until('none left', async () => (await shots()) === 0);
    // An Activity reply carries its image the same way.
    await goto(page, '#/', '#list .agent');
    await page.locator('#list .seg button').filter({ hasText: 'Activity' }).click();
    const card = page.locator('#list .card', { has: page.locator('input[aria-label="Reply to Alpha:1"]') });
    await attach(page, '#list .card:has(input[aria-label="Reply to Alpha:1"])', JPG);
    await card.locator('.shot').waitFor();
    await card.locator('.reply input').fill('and this one');
    await card.locator('.reply button.primary').click();
    await until('the reply went', () => submitted(state).length === 3);
    assert.equal(submitted(state)[2], `and this one ${path(4)}`);
    await until("the card's image went with it", async () => (await card.locator('.shot').count()) === 0);
    // A shell's line has no image button: a path there is only a word.
    state.shell = true;
    await goto(page, '#/pane/b1', '#screen .line');
    await until('Beta is a shell', async () => !(await page.locator('#image-btn').isVisible()));
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  {
    // A 20 MiB photo over a 0.5 Mbps uplink takes 336 s, which remote.rs allows (600 s from the first byte).
    // Clocks run 3000 times fast for the upload's deadline only (the page's other waits are under 150 s):
    // each try must outlast the upload, so one try sends it and the message goes.
    const { ctx, page, state } = await context(375);
    await ctx.addInitScript(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      window.uploadBudgets = [];
      AbortSignal.timeout = ms => (ms >= 150_000 ? (window.uploadBudgets.push(ms), timeout(ms / 3000)) : timeout(ms));
    });
    state.imageDelay = Math.round(20 * 2 ** 20 * 8 / 500_000 * 1000 / 3000);
    await goto(page, '#/pane/a1', '#screen .line');
    await page.fill('#prompt textarea', 'Review my photo');
    await attach(page, '#prompt', JPG);
    await page.click('#prompt button.primary');
    await until('the slow photo and its message went', () => submitted(state).length === 1, 15000);
    assert.equal(state.images.length, 1, 'one try was enough');
    const budgets = await page.evaluate(() => window.uploadBudgets);
    assert.ok(budgets.length === 1 && budgets[0] >= 600_000, `each try gives the upload the server's 600 s: ${budgets}`);
    assert.match(submitted(state)[0], /^Review my photo C:\\.*\\1-ab12cd34\.png$/);
    assert.equal(await page.locator('#dock .shot').count(), 0);
    assert.deepEqual(state.errors, []);
    await ctx.close();
  }
  console.log('PASS images: Paste image reads the clipboard, a paste or a pick adds one, a HEIC is refused, a remove takes one off, each agent keeps its own, a refused upload keeps the message, a send carries the paths after the text (or alone) and keeps one added meanwhile, an Activity reply too, a shell has none, and a 20 MiB photo over a 0.5 Mbps uplink goes in one try');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
