// Build first: npm run build, then cargo build --features tauri/custom-protocol
// Real agents, real API calls (two short turns each): Claude, Codex and
// OpenCode panes in the real app, read back through the overview.
//  1. A first turn that runs ~20 s: while it works, each card says Working and
//     shows the prompt; when it ends, Waiting and the reply.
//  2. A question tool prompt: the card turns Waiting while the turn is still
//     open, with the question on screen.
// The work folder is fixed so each agent's folder-trust answer sticks; the
// first run answers those prompts with Enter. Screenshots go to SHOTS (default:
// the check's folder).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const exe = resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/debug/loom.exe');
const pause = ms => new Promise(r => setTimeout(r, ms));
const dir = join(tmpdir(), 'loom-harness-check');
const work = join(dir, 'work');
const shots = process.env.SHOTS || dir;
mkdirSync(work, { recursive: true });
if (!existsSync(join(work, '.git'))) execFileSync('git', ['init', '-q', work]); // Restoring a thread asks git about it.
const AGENTS = ['claude', 'codex', 'opencode'];
const profile = join(dir, `p-${Date.now()}.json`);
writeFileSync(profile, JSON.stringify({ repos: [work], threads: [{ repo: work, dir: work, name: 'harness', branch: '', panes: AGENTS.map(cmd => ({ cmd })), layout: 'cols' }], ui: { sideOpen: false, thread: 0 } }));
writeFileSync(profile.replace(/\.json$/, '.window.json'), JSON.stringify({ main: { width: 1500, height: 900, x: 40, y: 40, prev_x: 40, prev_y: 40, maximized: false, fullscreen: false, visible: true, decorated: true } }));
async function until(what, fn, ms = 6000, every = 250) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  throw new Error('Timed out: ' + what);
}

const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(exe, [profile], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
const exit = new Promise(r => child.once('exit', r));
child.stderr.on('data', d => process.stderr.write(d)); // a panic says so here
child.once('exit', (code, signal) => console.log(`[loom exited at ${new Date().toLocaleTimeString()}: code ${code}, signal ${signal}]`));
const endpoint = `http://127.0.0.1:${port}`;
await until('webview', () => fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false), 30000);
const browser = await chromium.connectOverCDP(endpoint);
const page = await until('main page', () => browser.contexts()[0].pages().find(p => !p.url().includes('overlay')), 15000);

// WebGL panes draw text on a canvas; xterm's DOM renderer draws rows a test can
// read. No WebGL from the start: a context lost later leaves the DOM rows blank
// until the app draws again, and a static screen (a trust prompt) never does.
const noWebgl = () => page.evaluate(() => {
  if (!document.querySelector('#dashboard-btn')) return false; // still about:blank
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/.test(type) ? null : get.call(this, type, ...a); };
  for (const c of document.querySelectorAll('.pane canvas')) get.call(c, 'webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}).catch(() => false); // the page navigated mid-call
// DOM rows use U+00A0 for blank cells; \s covers it.
const screen = i => page.evaluate(i => document.querySelectorAll('.pane')[i]?.querySelector('.xterm-rows')?.innerText ?? '', i);
const card = agent => page.evaluate(agent => {
  const c = [...document.querySelectorAll('.dashboard-card')].find(c => c.textContent.includes(`harness / ${agent}`));
  if (!c) return null;
  const [you, reply] = [...c.querySelectorAll('.dashboard-message span')].map(s => s.textContent);
  return { status: c.querySelector('.dashboard-status')?.textContent ?? '', you, reply, question: c.querySelector('.dashboard-question')?.textContent ?? '' };
}, agent);
const overview = on => page.evaluate(on => {
  if (document.body.classList.contains('dashboard-open') !== on) document.querySelector('#dashboard-btn').click();
}, on);
const flat = s => s.replace(/\s+/g, '');
const tail = async (i, n = 10) => (await screen(i)).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
async function type(i, text) {
  await page.locator('.pane .xterm').nth(i).click();
  await page.keyboard.type(text);
  await until(`pane ${i} shows the typed prompt`, async () => flat(await screen(i)).includes(flat(text.slice(-12))), 10000)
    .catch(async e => console.log(e.message + '\n' + await tail(i)));
  await pause(800); // Codex takes a fast burst as a paste, and an Enter inside one as a newline.
  await page.keyboard.press('Enter');
}
const log = (...a) => console.log(`[${Math.round(performance.now() / 1000)}s]`, ...a);
const shot = name => page.screenshot({ path: join(shots, `harness-${name}.png`) });
const titlesSeen = new Set();
const sampleTitles = async () => { for (const t of await page.evaluate(() => [...document.querySelectorAll('.pane .pane-title')].map(t => t.textContent)).catch(() => [])) titlesSeen.add(t); };

try {
  await until('app page without WebGL', noWebgl, 15000, 50);
  await page.waitForFunction(n =>document.querySelectorAll('.pane .xterm').length === n, AGENTS.length, { timeout: 20000 });
  // Boot: answer folder-trust prompts, then wait for each screen to settle.
  await Promise.all(AGENTS.map(async (agent, i) => {
    let last = '', same = 0;
    await until(`${agent} ready`, async () => {
      const s = await screen(i);
      if (/trust\s+this\s+folder|Do\s+you\s+trust/i.test(s)) {
        // Claude's default is "No, exit": move to the yes before confirming.
        const selected = s.split('\n').find(l => /[❯›]\s*(\d\.\s*)?\S/.test(l)) ?? '';
        await page.locator('.pane .xterm').nth(i).click();
        await page.keyboard.press(/yes|trust and continue/i.test(selected) ? 'Enter' : 'ArrowDown');
        same = 0;
        await pause(700);
        return false;
      }
      // Blank rows are whitespace, not "". Codex takes about a minute to leave
      // "model: loading" (its trust prompt only comes after), and holds any
      // prompt typed before then as "Waiting for startup".
      same = s.trim() && !/model:\s+loading/.test(s) && s === last ? same + 1 : 0;
      last = s;
      return same >= 6; // 3 s unchanged
    }, 180000, 500).catch(async e => { log(`${e.message}, going on. Screen:\n${await tail(i, 20)}`); await shot(`${agent}-not-ready`); });
  }));
  await shot('booted');
  for (const [i, agent] of AGENTS.entries()) log(`${agent} booted:\n${await tail(i)}`);

  // 1. A first turn long enough to watch.
  const PROMPT = 'Run this exact shell command and wait for it to finish: node -e "setTimeout(()=>{},20000)" -- then reply with exactly PONG and nothing else.';
  for (const i of AGENTS.keys()) await type(i, PROMPT);
  await pause(6000);
  for (const [i, agent] of AGENTS.entries()) log(`${agent} after sending:\n${await tail(i)}`);
  await overview(true);
  const history = Object.fromEntries(AGENTS.map(a => [a, []]));
  const seen = Object.fromEntries(AGENTS.map(a => [a, { workingWithPrompt: false }]));
  await until('every first turn ends', async () => {
    let done = 0;
    for (const agent of AGENTS) {
      const c = await card(agent);
      const line = JSON.stringify(c);
      if (history[agent].at(-1)?.line !== line) history[agent].push({ t: Math.round(performance.now() / 1000), line });
      if (c?.status.startsWith('Working') && c.you?.includes('setTimeout')) seen[agent].workingWithPrompt = true;
      if (c?.status.startsWith('Waiting') && c.reply?.includes('PONG')) done++;
    }
    await sampleTitles();
    return done === AGENTS.length;
  }, 240000, 1000).catch(e => console.log(e.message));
  await shot('turn-done');
  for (const agent of AGENTS) {
    console.log(`\n${agent}:`);
    for (const { t, line } of history[agent]) console.log(`  ${t}s ${line}`);
  }
  const results = {};
  for (const agent of AGENTS) {
    const c = await card(agent);
    results[agent] = { workingWithPrompt: seen[agent].workingWithPrompt, endsWaitingWithReply: !!(c?.status.startsWith('Waiting') && c.reply?.includes('PONG') && c.you?.includes('setTimeout')) };
  }

  // 2. A question tool while the turn stays open.
  await overview(false);
  const ASK = {
    claude: 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Do nothing else.',
    codex: 'Use the request_user_input tool to ask me whether I prefer tea or coffee. Do nothing else.',
    opencode: 'Use the question tool to ask me whether I prefer tea or coffee. Do nothing else.',
  };
  for (const [i, agent] of AGENTS.entries()) await type(i, ASK[agent]);
  await overview(true);
  // Typing acknowledged the first turn's alert, so Waiting now is a new ring.
  // The card shows the question when it reads one, the new prompt otherwise.
  const current = (agent, c) => c?.status.startsWith('Waiting') && (c.question || c.you?.includes(ASK[agent].slice(0, 40)));
  await until('every card waits on its new prompt', async () => (await sampleTitles(), await Promise.all(AGENTS.map(card))).every((c, i) => current(AGENTS[i], c)), 180000, 1000)
    .catch(e => console.log(e.message));
  await pause(2000);
  await shot('question-overview');
  await overview(false);
  for (const [i, agent] of AGENTS.entries()) {
    const c = await card(agent);
    const s = await screen(i);
    results[agent].question = { current: !!current(agent, c), card: c, screenTail: s.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-14).join('\n') };
  }
  await shot('question-panes');
  for (const [i] of AGENTS.entries()) { await page.locator('.pane .xterm').nth(i).click(); await page.keyboard.press('Escape'); }
  const saved = JSON.parse(readFileSync(profile, 'utf8')).threads[0].panes;
  console.log('\nsaved panes:', JSON.stringify(saved.map(p => ({ cmd: p.cmd, sessionId: p.sessionId }))));
  console.log('\nRESULTS', JSON.stringify(results, null, 2));
  console.log('\npane titles seen:', JSON.stringify([...titlesSeen]));
  // Codex titles its pane with the thread id (plus a spinner while working): Loom keeps it, never shows it.
  assert.ok(![...titlesSeen].some(t => /^[0-9a-f]{8}-/.test(t)), 'A codex thread id is not a pane title');
  await pause(1000);
  await page.evaluate(() => window.__TAURI__.event.emitTo('main', 'tauri://close-requested')).catch(() => {});
  await Promise.race([exit, pause(15000)]);
} finally {
  await browser.close().catch(() => {});
  // The agents too: killing loom.exe alone leaves them running.
  if (child.exitCode === null) try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
}
