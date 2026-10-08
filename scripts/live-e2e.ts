import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = resolve('.');
const keyPath = process.env.AUTOUM_TEST_KEY_FILE;
if (!keyPath) throw Error('Set AUTOUM_TEST_KEY_FILE to a private file containing the authorized OpenCode key.');
const key = (await readFile(keyPath, 'utf8')).trim();
const directory = await mkdtemp(join(tmpdir(), 'autoum-live-'));
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
const agentDir = join(directory, 'agent'), profile = join(directory, 'profile');
await mkdir(join(agentDir, 'pi'), { recursive: true, mode: 0o700 });
await writeFile(join(agentDir, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key }, 'opencode-go': { type: 'api_key', key } }), { mode: 0o600 });
const chatId = crypto.randomUUID();
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skillPaths: [], extensionPaths: [], decisionModel: { provider: 'opencode', id: 'jev-1.13-free' }, chats: [{ id: chatId, title: 'Live E2E', workspace: 'Personal', provider: 'opencode', model: process.env.AUTOUM_TEST_MODEL || 'space-bunny-free', mode: 'all', messages: [], requests: [], cwd: directory, thinking: 'off' }] }));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Autoum live fixture</title><h1>Ready</h1><button id="reveal" onclick="document.querySelector(\'h1\').textContent=\'E2E success 731\'">Reveal test result</button><button id="reset" onclick="document.querySelector(\'h1\').textContent=\'Ready\'">Reset</button>'); });
await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { env: { ...process.env, AUTOUM_PROFILE_ONLY: '1', AUTOUM_DATA_DIR: agentDir, AUTOUM_PROFILE_DIR: profile }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 420, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`, '--no-first-run'], env: { ...process.env, AUTOUM_DISABLE_ACCOUNT_DETECTION: '1' } });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const web = await context.newPage(); await web.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
  const localPath = join(directory, 'lesson.html');
  await writeFile(localPath, '<title>Private local lesson</title><h1>Local verification 942</h1><button id="solution" onclick="document.querySelector(\'h1\').textContent=\'Local solution 628\'">Reveal solution</button>');
  const local = await context.newPage(); await local.goto(pathToFileURL(localPath).href);
  const tabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url })));
  const webId = tabs.find(t => t.url === web.url())!.id, localId = tabs.find(t => t.url === local.url())!.id;
  const panel = await context.newPage(); const { extensionId } = JSON.parse(await readFile('dist/build.json', 'utf8'));
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  await panel.getByRole('combobox', { name: 'Permission mode' }).waitFor({ timeout: 30000 });
  const rpc = async (type: string, data: any) => panel.evaluate(async ({ type, data }) => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }); const id = crypto.randomUUID();
    return new Promise<any>((yes, no) => { port.onMessage.addListener(p => { if (p.reply !== id) return; port.disconnect(); p.error ? no(Error(p.error)) : yes(p.data); }); port.postMessage({ id, type, data }); });
  }, { type, data });
  const run = async (text: string) => {
    await rpc('send', { chatId, text });
    for (let attempt = 0; attempt < 3600; attempt++) {
      const state = await rpc('state', {}); const chat = state.chats.find((c: any) => c.id === chatId);
      if (!chat.busy) { assert.equal(chat.error, '', 'Live provider task must finish without an error'); return chat; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Live task did not finish within three minutes');
  };
  const main = await run(`This is an authorized local end-to-end test. Use the browser tool to snapshot tab ${localId}, click its Reveal solution button, snapshot again, and report the exact new heading. Only interact with this test tab.`);
  if (await local.locator('h1').textContent() !== 'Local solution 628') {
    const files = execFileSync('find', [join(agentDir, 'pi/sessions'), '-name', '*.jsonl'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const messages = (await Promise.all(files.map(f => readFile(f, 'utf8')))).join('\n').replaceAll(key, '[REDACTED]');
    await mkdir(join(root, 'test-results'), { recursive: true });
    await writeFile(join(root, 'test-results/live-failure.json'), JSON.stringify({ heading: await local.locator('h1').textContent(), replies: main.messages.filter((m: any) => m.role === 'assistant'), transcript: messages }, null, 2), { mode: 0o600 });
    console.error('Live agent did not change the fixture. A redacted diagnostic is saved in test-results/live-failure.json.');
  }
  assert.equal(await local.locator('h1').textContent(), 'Local solution 628');
  assert.ok(main.messages.some((m: any) => m.role === 'assistant' && m.text.includes('628')), 'Main model observed the changed local page');
  const fast = await run(`On test tab ${webId}, use the fast_browser tool with one click step intent "click Reveal test result", and expectedText "E2E success 731". Do not use another tool to perform the click. If the tool reports uncertainty, report that instead. Report whether the fast tool verified success.`);
  assert.equal(await web.locator('h1').textContent(), 'E2E success 731', 'Real Jev selected and clicked the observed button');
  await run('Give me a detailed guide to the local browser test we just performed: explain the initial heading, the Reveal solution button, how we observed the result, and how the separate fast-browser step selects a control and verifies success. Include sections and useful troubleshooting details. Use only our observed fixture facts; do not open any external websites.');
  const report = (await worker.evaluate(async () => chrome.tabs.query({}))).find(t => t.url?.includes('/artifacts/' + chatId + '/'));
  assert.ok(report?.active && report.groupId! >= 0, 'A detailed answer defaults to an actively opened, grouped HTML report');
  const reportPage = context.pages().find(p => p.url() === report.url)!;
  await reportPage.locator('h1').waitFor(); assert.ok((await reportPage.locator('body').innerText()).includes('628'), 'Report uses the observed fixture result');
  await reportPage.screenshot({ path: join(root, 'test-results/live-html-output.png') });
  const sessionFiles = execFileSync('find', [join(agentDir, 'pi/sessions'), '-name', '*.jsonl'], { encoding: 'utf8' }).trim().split('\n');
  const transcript = (await Promise.all(sessionFiles.map(f => readFile(f, 'utf8')))).join('\n');
  assert.ok(transcript.includes('"toolName":"fast_browser"') || transcript.includes('"name":"fast_browser"'));
  assert.ok(transcript.includes('"verified":true') || transcript.includes('\\"verified\\":true'));
  await panel.screenshot({ path: join(root, 'test-results/live-sidebar.png') });
  await writeFile(join(root, 'test-results/live-e2e.json'), JSON.stringify({ date: new Date().toISOString(), provider: 'opencode', mainModel: process.env.AUTOUM_TEST_MODEL || 'space-bunny-free', classifier: 'jev-1.13-free', localHtml: true, realAgentActions: true, fastBrowserVerified: true, longOutputHtml: true, reportActiveAndGrouped: true, assistantReplies: fast.messages.filter((m: any) => m.role === 'assistant').length }, null, 2));
  console.log('Live OpenCode E2E passed: local HTML interaction, Jev selection/action/verification and default long-output HTML.');
} finally { await context.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
