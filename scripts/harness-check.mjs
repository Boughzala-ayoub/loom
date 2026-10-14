// Build first: npm run build, then cargo build --features tauri/custom-protocol
// Real agents, real API calls (two short turns each): Claude, Codex,
// OpenCode, Cursor and Grok panes in the real app, read back through the overview.
// HARNESS_AGENTS=cursor,grok (comma-separated) runs only those.
//  1. A first turn that runs ~20 s: while it works, each card says Working and
//     shows the prompt; when it ends, Waiting and the reply.
//  2. A question tool prompt: the card turns Waiting while the turn is still
//     open, with the question on screen.
// Cursor asks before it runs a shell command it hasn't been allowed: in 1 the
// check answers that from the overview's own button, and 2 is such a question.
// Grok asks only before a command on its dangerous list: 2 is an rm -r of a
// folder the check makes, approved from the Overview with "Yes, proceed". Its
// card's first option turns on always-approve for good (~/.grok/config.toml),
// so the check never picks it.
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
mkdirSync(join(work, 'del1'), { recursive: true }); // Grok asks before its rm -r.
const AGENTS = (process.env.HARNESS_AGENTS || 'claude,codex,opencode,cursor,grok').split(',');
const CMDS = { cursor: 'cursor-agent' };
const profile = join(dir, `p-${Date.now()}.json`);
writeFileSync(profile, JSON.stringify({ repos: [work], threads: [{ repo: work, dir: work, name: 'harness', branch: '', panes: AGENTS.map(a => ({ cmd: CMDS[a] ?? a })), layout: 'cols' }], ui: { sideOpen: false, thread: 0 } }));
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
        const selected = s.split('\n').find(l => /[❯›▶]\s*(\d\.\s*)?\S/.test(l)) ?? '';
        await page.locator('.pane .xterm').nth(i).click();
        await page.keyboard.press(/yes|trust and continue|trust this workspace/i.test(selected) ? 'Enter' : 'ArrowDown');
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
  const seen = Object.fromEntries(AGENTS.map(a => [a, { workingWithPrompt: false, answeredInOverview: false }]));
  // Cursor's (or Grok's) approval of the shell command, answered as a person would from its card.
  const runOnce = agent => page.evaluate(agent => {
    const c = [...document.querySelectorAll('.dashboard-card')].find(c => c.textContent.includes(`harness / ${agent}`));
    const b = [...(c?.querySelectorAll('.dashboard-choices button') ?? [])].find(b => /^(Run \(once\)|Yes, proceed)/.test(b.textContent));
    b?.click();
    return !!b;
  }, agent);
  await until('every first turn ends', async () => {
    let done = 0;
    for (const agent of AGENTS) {
      const c = await card(agent);
      const line = JSON.stringify(c);
      if (history[agent].at(-1)?.line !== line) history[agent].push({ t: Math.round(performance.now() / 1000), line });
      if (c?.status.startsWith('Working') && c.you?.includes('setTimeout')) seen[agent].workingWithPrompt = true;
      if ((agent === 'cursor' && /Run this command/.test(c?.question ?? '') || agent === 'grok' && c?.question) && c?.status.startsWith('Waiting') && await runOnce(agent)) seen[agent].answeredInOverview = true;
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
    if (agent === 'cursor' || agent === 'grok') results[agent].answeredInOverview = seen[agent].answeredInOverview;
  }

  // 2. A question tool while the turn stays open.
  await overview(false);
  const ASK = {
    claude: 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Do nothing else.',
    codex: 'Use the request_user_input tool to ask me whether I prefer tea or coffee. Do nothing else.',
    opencode: 'Use the question tool to ask me whether I prefer tea or coffee. Do nothing else.',
    cursor: 'Run this exact shell command: node -e "console.log(42)" -- then reply with the number it printed.',
    grok: 'Run exactly this shell command and nothing else: rm -r del1',
  };
  for (const [i, agent] of AGENTS.entries()) await type(i, ASK[agent]);
  await overview(true);
  // Typing acknowledged the first turn's alert, so Waiting now is a new ring.
  // The card shows the question when it reads one, the new prompt otherwise.
  // Grok asks before any rm -r, so its card must show the question.
  const current = (agent, c) => c?.status.startsWith('Waiting') && (c.question || agent !== 'grok' && c.you?.includes(ASK[agent].slice(0, 40)));
  const later = [];
  const cards = async () => {
    const all = await Promise.all(AGENTS.map(card));
    for (const [i, agent] of AGENTS.entries()) if (later.findLast(l => l.agent === agent)?.line !== JSON.stringify(all[i])) later.push({ agent, t: Math.round(performance.now() / 1000), line: JSON.stringify(all[i]) });
    return all;
  };
  // Grok's card is answered from the Overview as soon as it shows ("Yes, proceed", never option 1:
  // that one saves always-approve in ~/.grok/config.toml). Not later: showing the pane would
  // acknowledge its alert, and an acknowledged card offers no answers.
  const answered = {};
  await until('every card waits on its new prompt', async () => {
    await sampleTitles();
    const all = await cards(), g = AGENTS.indexOf('grok');
    if (g >= 0 && !answered.grok && current('grok', all[g]) && await runOnce('grok')) answered.grok = all[g];
    return all.every((c, i) => answered[AGENTS[i]] || current(AGENTS[i], c));
  }, 180000, 1000).catch(e => console.log(e.message));
  if (answered.grok) results.grok.answerEnds = !!await until('grok ends the answered turn', async () => {
    const c = (await cards())[AGENTS.indexOf('grok')];
    return c?.status.startsWith('Waiting') && !c.question && !!c.reply && c.reply !== 'PONG';
  }, 120000, 1000).catch(e => console.log(e.message));
  await pause(2000);
  await shot('question-overview');
  await overview(false);
  for (const [i, agent] of AGENTS.entries()) {
    const c = answered[agent] ?? await card(agent);
    const s = await screen(i);
    results[agent].question = { current: !!current(agent, c), card: c, screenTail: s.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-14).join('\n') };
  }
  if (AGENTS.includes('grok')) results.grok.answeredInOverview = !!answered.grok;
  await shot('question-panes');
  for (const { agent, t, line } of later) console.log(`  ${t}s ${agent} ${line}`);
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
