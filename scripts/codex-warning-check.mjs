// Check a built native bundle with a temporary profile and no model prompt.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const dir = mkdtempSync(join(tmpdir(), 'loom-warning-check-'));
const home = join(dir, 'codex-home');
mkdirSync(home);
writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-key' }));
writeFileSync(join(home, 'config.toml'), `model = "gpt-5.6-terra"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
openai_base_url = "http://127.0.0.1:1/v1"
[projects.${JSON.stringify(dir)}]
trust_level = "trusted"
`);
const profile = join(dir, 'workspace.json');
writeFileSync(profile, JSON.stringify({ threads: [{ repo: dir, dir, name: 'Warning check', panes: [{ cmd: 'codex' }] }], ui: { sideOpen: false, thread: 0 } }));
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}`;
await new Promise(r => server.close(r));
const child = spawn(resolve(process.env.LOOM_TEST_EXE || 'src-tauri/target/release/loom.exe'), [profile], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${new URL(endpoint).port}` },
});
const pause = ms => new Promise(r => setTimeout(r, ms));
let browser, page;
try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false)) break;
    await pause(100);
  }
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await page.waitForSelector('.xterm');
  await page.evaluate(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /webgl/.test(type) ? null : get.call(this, type, ...args); };
    for (const c of document.querySelectorAll('.pane canvas')) get.call(c, 'webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await pause(7000);
  const screen = () => page.locator('.xterm-rows').innerText();
  if (/trust/i.test(await screen())) {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => /GPT-|Use\s+existing\s+model/.test(document.querySelector('.xterm-rows')?.innerText || ''), null, { timeout: 45000 });
  if (/Use\s+existing\s+model/.test(await screen())) {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => {
    const text = document.querySelector('.xterm-rows')?.innerText || '';
    return /Ask\s+Codex/.test(text) && /GPT-/.test(text) && !/loading/i.test(text);
  }, null, { timeout: 45000 }).catch(async e => {
    await page.screenshot({ path: resolve('node_modules/.cache/codex-warning-check.png') });
    throw e;
  });
  await pause(1500);
  await page.screenshot({ path: resolve('node_modules/.cache/codex-warning-check.png') });
  assert.ok(!/\d+warnings?/i.test((await screen()).replace(/\s/g, '')), 'Codex startup must not show a fallback warning');
  console.log('PASS native Codex reaches its prompt without a startup warning');
} finally {
  await page?.evaluate(async () => { await window.__TAURI__.core.invoke('pty_shutdown'); await window.__TAURI__.window.getCurrentWindow().destroy(); }).catch(() => {});
  await browser?.close();
  child.kill();
}
