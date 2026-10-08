import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'); const results = resolve(process.env.AUTOUM_TEST_RESULTS || 'test-results'); await mkdir(results, { recursive: true }); const directory = await mkdtemp(join(tmpdir(), 'autoum-browser-'));
process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
const agentDir = join(directory, 'agent'); const profile = join(directory, 'profile');
await mkdir(join(agentDir, 'pi'), { recursive: true });
const reviewingCredential = (header: unknown, input: any) => header === 'Bearer fixture-local-only' && input.messages.some((m: any) => JSON.stringify(m.content).includes('independently review'));
const authorizations: string[] = []; const requests: any[] = []; const pageErrors: string[] = [];
let steeringWaiting = false; let releaseSteering: (() => void) | undefined;
let releaseScroll: (() => void) | undefined;
let releaseReconnect: (() => void) | undefined;
const scrollFirst = Array.from({ length: 24 }, (_, i) => `Reading paragraph ${i + 1}: Keep this explanation in view while new content arrives.\n\n`).join('');
const scrollLast = Array.from({ length: 12 }, (_, i) => `New paragraph ${i + 1}: Streaming continues below your reading position.\n\n`).join('') + '```js\nconst answer = 42;\n```\n\nMath stays editable: $x^2$.\n';
const longReply = '# Complete long reply\n\n```js\nconst fullAnswer = 42;\n```\n\nMath: $x^2$.\n\n' + Array.from({ length: 1100 }, (_, i) => `Paragraph ${i}: ` + 'Readable saved content. '.repeat(50) + '\n\n').join('') + '\n## End of the full reply\n\n<img src="invalid" onerror="window.__longReplyInjected=true">';
const server = createServer(async (req, res) => {
  if (req.url === '/popup-fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Research popup fixture</title><a id="research-link" href="/fixture?research-child=1" target="_blank">Research source</a>'); return; }
  if (req.url?.split('?')[0] === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Web fixture</title><button id="hello" onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Say hello</button><h1>Ready</h1><input id="name" placeholder="Name"><input type="file" id="upload"><div style="height:2000px">Scroll area</div>'); return; }
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.headers['x-opencode-session'], chatId, 'Every main/review request uses the persisted conversation ID');
  assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0');
  assert.ok(req.headers.authorization === 'Bearer ' + expectedKey || reviewingCredential(req.headers.authorization, JSON.parse(body)), 'Main requests use the selected account; Google review uses its separate reviewer account'); authorizations.push(String(req.headers.authorization));
  const input = JSON.parse(body); requests.push(input);
  const message = input.messages?.filter((m: any) => m.role === 'user').at(-1)?.content || '';
  const prompt = typeof message === 'string' ? message : JSON.stringify(message);
  const reviewing = input.messages.some((m: any) => JSON.stringify(m.content).includes('independently review'));
  if (!reviewing && prompt.includes('PORT RECONNECT')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'reconnect-fixture', object: 'chat.completion.chunk', created: 1, model: 'autoum-fixture', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason }] })}\n\n`;
    res.write(chunk('Research continues while the sidebar reconnects.\n'));
    await new Promise<void>(resolve => { releaseReconnect = resolve; });
    res.end(chunk('Reconnection completed without restarting the task.', 'stop') + 'data: [DONE]\n\n'); return;
  }
  if (!reviewing && prompt.includes('QOL STREAM')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'scroll-fixture', object: 'chat.completion.chunk', created: 1, model: 'autoum-fixture', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason }] })}\n\n`;
    res.write(chunk(scrollFirst));
    await new Promise<void>(resolve => { releaseScroll = resolve; });
    res.write(chunk(scrollLast)); res.end(chunk('', 'stop') + 'data: [DONE]\n\n'); return;
  }
  if (!reviewing && prompt.includes('WAIT FOR STEER')) { steeringWaiting = true; await new Promise<void>(resolve => { releaseSteering = resolve; }); }
  const result = input.messages.at(-1)?.role === 'tool' || prompt.includes('STEER CORRECTION');
  const call = reviewing || result ? undefined : prompt.includes('CLICK')
    ? { action: 'click', tabId: (globalThis as any).fixtureTab, selector: '#hello' }
    : { action: 'snapshot', tabId: (globalThis as any).localTab };
  const memoryCall = !result && !reviewing && prompt.includes('MEMORY TEST PREFERENCE');
  const toolName = memoryCall ? 'memory' : 'browser';
  const toolInput = memoryCall ? { action: 'note', text: 'Prefers illustrated explanations fixture 319' } : call;
  const delta = toolInput ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolInput) } }] }
    : { role: 'assistant', content: reviewing ? '{"decision":"allow"}' : 'Verified the fixture.\n\n[Browser link](' + base + '/fixture)\n\n[Open test page](' + pathToFileURL(join(directory, 'lesson.html')).href + ')'  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'autoum-fixture', choices: [{ index: 0, delta, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolInput ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const chatId = crypto.randomUUID(), historyChatId = crypto.randomUUID(), longChatId = crypto.randomUUID(); let expectedKey = 'fixture-local-only';
await writeFile(join(agentDir, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'fixture-local-only' } }));
await writeFile(join(agentDir, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl: base + '/v1', models: [{ id: 'autoum-fixture', name: 'Autoum fixture', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
const fixtureChat = { id: chatId, title: 'New conversation', workspace: 'Personal', provider: 'opencode', model: 'autoum-fixture', mode: 'ask', messages: [], requests: [], cwd: directory, thinking: 'off' };
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skillPaths: [], extensionPaths: [], activeChatId: chatId, chats: [fixtureChat, { ...fixtureChat, id: historyChatId, title: 'Large history fixture', messages: Array.from({ length: 120 }, (_, i) => ({ role: 'assistant', text: `Historical message ${i}: ` + '🙂'.repeat(8950) })) }, { ...fixtureChat, id: longChatId, title: 'Long reply fixture', messages: [{ role: 'assistant', text: longReply }] }] }));
const googleAccounts = [crypto.randomUUID(), crypto.randomUUID()];
const googleCatalogs = [[{ id: 'flash-high', name: 'Gemini 3.8 Flash (High)' }, { id: 'flash-medium', name: 'Gemini 3.8 Flash (Medium)' }, { id: 'flash-low', name: 'Gemini 3.8 Flash (Low)' }, { id: 'MODEL_PLACEHOLDER_M26', name: 'Claude Opus 5.5 (Thinking)' }, { id: 'gpt-oss-medium', name: 'GPT-OSS 120B (Medium)' }], [{ id: 'pro-high', name: 'Gemini 3.1 Pro (High)' }, { id: 'pro-low', name: 'Gemini 3.1 Pro (Low)' }]];
await writeFile(join(agentDir, 'accounts.json'), JSON.stringify(googleAccounts.map((id, i) => ({ id, provider: 'antigravity', label: i ? 'Google Work fixture' : 'Google Personal fixture', method: 'oauth', configured: true }))));
for (let i = 0; i < googleAccounts.length; i++) { const folder = join(agentDir, 'accounts', googleAccounts[i], 'antigravity'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'models.json'), JSON.stringify(googleCatalogs[i])); }
const acpBinary = join(directory, 'agy-fixture.mjs'), acpLog = join(directory, 'acp.jsonl');
await writeFile(acpBinary, '#!' + process.execPath + '\n' + await readFile('scripts/fixtures/antigravity.mjs', 'utf8'), { mode: 0o700 }); await writeFile(join(directory, 'localharness_external'), 'fixture');
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...process.env, AUTOUM_PROFILE_ONLY: '1', AUTOUM_DATA_DIR: agentDir, AUTOUM_PROFILE_DIR: profile, AUTOUM_DISABLE_ACCOUNT_DETECTION: '1' }, stdio: 'pipe' });
// Native host inherits this test-only flag from its browser. No real account or paid endpoint is used.
const executablePath = process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium');
const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 420, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`, '--no-first-run'],
  env: { ...process.env, AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1', AUTOUM_ANTIGRAVITY_BINARY: acpBinary, AUTOUM_ACP_TEST_LOG: acpLog } });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  const newTab = await context.newPage();
  await newTab.goto('chrome://newtab/');
  await newTab.getByRole('heading', { name: 'Autoum', exact: true }).waitFor();
  assert.equal(await newTab.title(), 'Autoum');
  await newTab.screenshot({ path: join(results, 'newtab.png') });
  await newTab.getByRole('textbox', { name: 'Search or enter address' }).fill(base + '/fixture');
  await newTab.getByRole('button', { name: 'Go', exact: true }).click();
  await newTab.waitForURL(base + '/fixture');
  await newTab.close();
  if (process.platform === 'linux') {
    const appearance = await context.newPage(); await appearance.goto('chrome://settings/appearance');
    // The real profile default is checked independently of page layout/headless window decorations.
    const preferences = JSON.parse(await readFile(join(profile, 'Default/Preferences'), 'utf8')); assert.equal(preferences.browser.custom_chrome_frame, true);
    await appearance.close();
  }
  if (process.env.AUTOUM_TEST_BRANDING === '1') {
    const settings = await context.newPage(); await settings.goto('chrome://settings/help');
    await settings.locator('settings-about-page').getByText('Autoum', { exact: true }).first().waitFor();
    await settings.screenshot({ path: join(results, 'browser-branding.png') });
    await settings.close();
  }
  const web = await context.newPage(); await web.goto(base + '/fixture');
  const localFile = join(directory, 'lesson.html'); await writeFile(localFile, '<title>Local lesson</title><h1>Local HTML teacher lesson</h1><button id="answer" onclick="document.querySelector(\'h1\').textContent=\'Solution shown\'">Reveal solution</button>');
  const local = await context.newPage(); await local.goto(pathToFileURL(localFile).href);
  const ids = await worker.evaluate(async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url })));
  (globalThis as any).fixtureTab = ids.find(t => t.url === base + '/fixture')!.id;
  (globalThis as any).localTab = ids.find(t => t.url === pathToFileURL(localFile).href)!.id;
  const panel = await context.newPage(); panel.setDefaultTimeout(20000); panel.on('pageerror', e => pageErrors.push(e.message));
  panel.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  await panel.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 20000 });
  await panel.getByRole('combobox', { name: 'Permission mode' }).waitFor({ timeout: 20000 });
  const rpc = async (type: string, data: any = {}) => panel.evaluate(async ({ type, data }) => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }); const id = crypto.randomUUID();
    return new Promise<any>((yes, no) => { port.onMessage.addListener(p => { if (p.reply !== id) return; port.disconnect(); p.error ? no(Error(p.error)) : yes(p.data); }); port.postMessage({ id, type, data }); });
  }, { type, data });
  const waitIdle = async () => { for (let attempt = 0; attempt < 2500; attempt++) { const current = (await rpc('state')).chats.find((c: any) => c.id === chatId); if (!current.busy) { assert.equal(current.error, '', 'Native task finishes without error'); return; } await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Native task did not finish'); };
  const browser = async (args: any) => panel.evaluate(async args => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }); const id = crypto.randomUUID();
    return new Promise<any>((yes, no) => { port.onMessage.addListener(p => { if (p.reply !== id) return; port.disconnect(); p.error ? no(Error(p.error)) : yes(p.data); }); port.postMessage({ id, type: 'local_browser', data: args }); });
  }, args);
  assert.equal(await panel.getByText('A little help,', { exact: false }).count(), 0);
  assert.equal(await panel.getByText('Summarize this page', { exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Workspace', exact: true }).count(), 0);
  // Real sidebar Stop must work before the Pi session exists. Hold an actual
  // private MCP SDK helper in initialization; no provider request may escape.
  const startupPids = join(directory, 'startup-pids'), startupGate = join(directory, 'startup-ready');
  await rpc('configure', { mcpServers: [{ name: 'startup', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: startupPids, AUTOUM_MCP_FIXTURE_GATE: startupGate } }] });
  await rpc('send', { chatId, text: 'MCP STARTUP CANCEL' });
  const spawnDeadline = Date.now() + 5000;
  while (!await readFile(startupPids, 'utf8').catch(() => '')) { assert.ok(Date.now() < spawnDeadline, 'MCP startup fixture must spawn'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const startupStop = performance.now();
  await panel.getByRole('button', { name: 'Stop and take over', exact: true }).click();
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 1000 });
  assert.equal(requests.length, 0, 'cancellation before initialization must not start a provider request');
  assert.equal((await rpc('state')).chats.find((c: any) => c.id === chatId).error, '');
  console.log(JSON.stringify({ mcpStartupStopToSendMs: +(performance.now() - startupStop).toFixed(2), providerRequestsAfterStartupStop: requests.length }));
  await writeFile(startupGate, '');
  await rpc('configure', { mcpServers: [] });
  await rpc('view_chat', { chatId: historyChatId });
  const initialHistory = (await rpc('state')).chats.find((c: any) => c.id === historyChatId);
  await panel.locator('.conversation').evaluate(el => { el.scrollTop = 0; });
  await panel.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await panel.getByRole('button', { name: 'Back to latest', exact: true }).waitFor();
  const olderHistory = (await rpc('state')).chats.find((c: any) => c.id === historyChatId);
  assert.ok(olderHistory.historyStart < initialHistory.historyStart);
  assert.ok((await panel.locator('.message .markdown').first().textContent())?.startsWith(`Historical message ${olderHistory.historyStart}:`));
  assert.equal(await panel.locator('.conversation').evaluate(el => el.scrollTop), 0, 'An older bounded page starts at the top');
  await panel.getByRole('button', { name: 'Newer messages', exact: true }).click();
  await panel.getByRole('button', { name: 'Back to latest', exact: true }).waitFor({ state: 'hidden' });
  await panel.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await panel.getByRole('button', { name: 'Back to latest', exact: true }).waitFor();
  await panel.reload(); await panel.getByRole('button', { name: 'Back to latest', exact: true }).waitFor();
  await panel.setViewportSize({ width: 320, height: 900 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await panel.getByRole('button', { name: 'Back to latest', exact: true }).waitFor({ state: 'hidden' });
  await panel.getByRole('button', { name: 'Jump to latest ↓', exact: true }).waitFor({ state: 'hidden' });
  await panel.waitForFunction(() => { const el = document.querySelector('.conversation')!; return el.scrollHeight - el.scrollTop - el.clientHeight < 5; });
  await panel.setViewportSize({ width: 420, height: 900 });
  await rpc('view_chat', { chatId }); await rpc('delete_chat', { chatId: historyChatId, confirm: true });
  await rpc('view_chat', { chatId: longChatId });
  await panel.getByRole('heading', { name: 'Complete long reply', exact: true }).waitFor();
  assert.ok(Buffer.byteLength(longReply) > 1000000, 'The complete reply exceeds the native packet limit');
  assert.equal(await panel.getByRole('heading', { name: 'End of the full reply', exact: true }).count(), 0);
  const longCopy = panel.getByRole('button', { name: 'Copy reply', exact: true });
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('Preserve this long-reply draft');
  await longCopy.click(); await longCopy.getByText('Copied', { exact: true }).waitFor();
  await context.grantPermissions(['clipboard-read'], { origin: base }); await web.bringToFront();
  assert.equal(await web.evaluate(() => navigator.clipboard.readText()), longReply, 'Copy retrieves every chunk without first expanding the reply');
  await panel.bringToFront();
  assert.equal(await panel.getByRole('textbox', { name: 'Message Autoum' }).inputValue(), 'Preserve this long-reply draft');
  await panel.setViewportSize({ width: 320, height: 900 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.getByRole('button', { name: 'Show full message', exact: true }).click();
  await panel.getByRole('heading', { name: 'End of the full reply', exact: true }).waitFor();
  assert.equal(await panel.locator('.message pre code').textContent(), 'const fullAnswer = 42;\n');
  assert.equal(await panel.locator('.message .katex').count(), 1);
  assert.equal(await panel.evaluate(() => (window as any).__longReplyInjected), undefined);
  await panel.getByRole('button', { name: 'Show less', exact: true }).click();
  await panel.getByRole('button', { name: 'Show full message', exact: true }).waitFor();
  assert.equal(await panel.getByRole('heading', { name: 'End of the full reply', exact: true }).count(), 0);
  await panel.setViewportSize({ width: 420, height: 900 });
  await rpc('view_chat', { chatId }); await rpc('delete_chat', { chatId: longChatId, confirm: true });
  await panel.evaluate(async () => { await chrome.fontSettings.setDefaultFontSize({ pixelSize: 20 }); });
  await panel.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === '20px');
  await panel.evaluate(async () => { await chrome.fontSettings.setDefaultFontSize({ pixelSize: 16 }); });
  const legacyResearch = await worker.evaluate(async url => {
    const tab = await chrome.tabs.create({ url, active: false }); const groupId = await chrome.tabs.group({ tabIds: [tab.id!] });
    await chrome.tabGroups.update(groupId, { title: 'Autoum', color: 'green', collapsed: false });
    await chrome.storage.local.set({ ['agentGroup:' + tab.windowId]: groupId }); return tab;
  }, base + '/fixture?legacy-research=1');
  const created = await Promise.all([browser({ action: 'open', url: base + '/fixture?agent=1' }), browser({ action: 'open', url: base + '/fixture?agent=2' })]);
  const grouped = await worker.evaluate(async ids => Promise.all(ids.map(id => chrome.tabs.get(id))), created.map(t => t.tabId));
  assert.ok(grouped[0].groupId >= 0); assert.equal(grouped[0].groupId, grouped[1].groupId);
  assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), grouped[0].groupId)).title, 'Autoum');
  assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), grouped[0].groupId)).collapsed, true, 'Background research starts as one collapsed group');
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), (globalThis as any).fixtureTab)).groupId, -1);
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => browser({ action: 'open', url: base + '/fixture?burst=' + i })));
  const burstTabs = await worker.evaluate(async ids => Promise.all(ids.map(id => chrome.tabs.get(id))), burst.map(t => t.tabId));
  assert.ok(burstTabs.every(t => t.groupId === grouped[0].groupId), 'Concurrent opens reuse exactly one group');
  const userTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const popupSource = await browser({ action: 'open', chatId, active: true, url: base + '/popup-fixture' });
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id), userTab, 'Even an agent’s active:true request must leave the user’s selection alone');
  const popupLoadDeadline = Date.now() + 10000;
  while (!await worker.evaluate(async id => (await chrome.tabs.get(id)).status === 'complete', popupSource.tabId)) { assert.ok(Date.now() < popupLoadDeadline, 'Research popup source must finish loading'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const activeBeforePopup = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  assert.equal((await browser({ action: 'snapshot', chatId })).tabId, popupSource.tabId, 'Implicit actions stay on the research tab after the user switches tabs');
  await browser({ action: 'activate', chatId, tabId: popupSource.tabId });
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id), activeBeforePopup, 'Agent activation cannot steal focus');
  await browser({ action: 'click', chatId, tabId: popupSource.tabId, selector: '#research-link' });
  let popup: chrome.tabs.Tab | undefined;
  for (let attempt = 0; attempt < 100 && !popup; attempt++) {
    popup = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), base + '/fixture?research-child=1');
    if (!popup) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(popup, 'The fixture link opens a real child tab');
  assert.equal(popup.groupId, grouped[0].groupId, 'Research links opening new tabs must stay inside the research group');
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id), activeBeforePopup, 'A research popup must not take the user’s active tab');
  assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), popup.groupId)).collapsed, true, 'A research popup must not expand the research group');
  assert.equal((await browser({ action: 'snapshot', chatId })).tabId, popup.id, 'The child tab becomes this chat’s research target');
  await browser({ action: 'evaluate', chatId, tabId: popupSource.tabId, expression: `window.open(${JSON.stringify(base + '/fixture?research-window=1')}, '_blank', 'popup,width=500,height=400'); true` });
  const windowPopup = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), base + '/fixture?research-window=1');
  assert.ok(windowPopup, 'The scripted popup opens a real tab');
  assert.equal(windowPopup.windowId, popup.windowId, 'Research pop-up windows are returned to the original browser window');
  assert.equal(windowPopup.groupId, popup.groupId, 'Research pop-up windows join the same group');
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id), activeBeforePopup, 'Pop-up windows must preserve the user’s selected tab and window');
  assert.equal((await browser({ action: 'snapshot', chatId })).tabId, windowPopup.id);
  const heldResearch = browser({ action: 'evaluate', chatId, tabId: popupSource.tabId, expression: `window.open(${JSON.stringify(base + '/fixture?held-research=1')}, '_blank'); new Promise(resolve => { window.releaseResearch = resolve; })` });
  void heldResearch.catch(() => {});
  let heldPopup: chrome.tabs.Tab | undefined;
  for (let attempt = 0; attempt < 100 && !heldPopup; attempt++) {
    heldPopup = await worker.evaluate(async ({ url, key }) => { const stored = await chrome.storage.session.get(key); return (await chrome.tabs.query({})).find(tab => tab.url === url && tab.id === stored[key]); }, { url: base + '/fixture?held-research=1', key: 'researchTab:' + chatId });
    if (!heldPopup) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(heldPopup, 'The agent popup is grouped while its evaluation is still pending');
  const personalTab = await worker.evaluate(async () => chrome.tabs.create({ url: 'about:blank', active: true }));
  await worker.evaluate(async tabId => chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'window.releaseResearch(true)' }), popupSource.tabId);
  await heldResearch;
  const personalAfter = await worker.evaluate(async id => chrome.tabs.get(id), personalTab.id!);
  assert.equal(personalAfter.groupId, -1, 'Tabs the user opens while research runs must not be captured by the agent');
  assert.equal(personalAfter.active, true, 'The agent must respect a new user selection while its action is pending');
  await worker.evaluate(async ids => chrome.tabs.remove(ids), [personalTab.id!, heldPopup.id!]);
  await browser({ action: 'close', tabId: windowPopup.id });
  await browser({ action: 'close', tabId: popup.id });
  await assert.rejects(browser({ action: 'snapshot', chatId }), /research tab was closed/, 'A closed research tab must never silently fall back to the user’s tab');
  await worker.evaluate(async id => chrome.tabs.remove(id), popupSource.tabId);
  await worker.evaluate(async id => chrome.tabGroups.update(id, { collapsed: false }), grouped[0].groupId);
  const manuallyExpanded = await browser({ action: 'open', chatId, url: base + '/fixture?manual-expansion=1' });
  assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), grouped[0].groupId)).collapsed, false, 'After migration, the user’s manual expansion choice is preserved');
  await worker.evaluate(async ids => chrome.tabs.remove(ids), [legacyResearch.id!, manuallyExpanded.tabId, ...[...created, ...burst].map(t => t.tabId)]);
  const reopened = await browser({ action: 'open', url: base + '/fixture?regroup=1' });
  assert.ok((await worker.evaluate(id => chrome.tabs.get(id), reopened.tabId)).groupId >= 0, 'Closing a whole group does not break the next open');
  const otherWindow = await worker.evaluate(async () => chrome.windows.create({ url: 'about:blank', focused: true }));
  const outsideWindow = await browser({ action: 'open', url: base + '/fixture?window=2' });
  const otherTab = await worker.evaluate(id => chrome.tabs.get(id), outsideWindow.tabId);
  assert.equal(otherTab.windowId, otherWindow.id); assert.ok(otherTab.groupId >= 0);
  assert.notEqual(otherTab.groupId, (await worker.evaluate(id => chrome.tabs.get(id), reopened.tabId)).groupId, 'Groups belong to their respective windows');
  await worker.evaluate(async id => chrome.windows.remove(id), otherWindow.id!);
  const originalSelection = await rpc('state'); const initialChat = originalSelection.chats.find((c: any) => c.id === chatId);
  const expandedHeight = await panel.locator('footer').evaluate(el => el.getBoundingClientRect().height);
  await panel.getByRole('button', { name: 'Hide model controls', exact: true }).click();
  assert.equal(await panel.getByRole('combobox', { name: 'AI provider' }).isVisible(), false);
  assert.equal(await panel.getByRole('combobox', { name: 'AI account' }).isVisible(), false);
  assert.equal(await panel.getByRole('combobox', { name: 'AI model' }).isVisible(), false);
  assert.equal(await panel.getByRole('combobox', { name: 'Reasoning' }).isVisible(), false);
  assert.equal(await panel.getByRole('combobox', { name: 'Permission mode', exact: true }).isVisible(), true);
  assert.ok(await panel.locator('footer').evaluate(el => el.getBoundingClientRect().height) < expandedHeight);
  const controlsSaveDeadline = Date.now() + 10000;
  while (!await panel.evaluate(async () => (await chrome.storage.local.get('showControls')).showControls === false)) { assert.ok(Date.now() < controlsSaveDeadline, 'Collapsed controls must actually be saved before reload'); await new Promise(resolve => setTimeout(resolve, 20)); }
  await panel.reload(); await panel.getByRole('button', { name: 'Show model controls', exact: true }).waitFor();
  assert.equal(await panel.getByRole('combobox', { name: 'AI model' }).isVisible(), false);
  const restoredSelection = (await rpc('state')).chats.find((c: any) => c.id === chatId);
  assert.equal(restoredSelection.model, initialChat.model); assert.equal(restoredSelection.accountId, initialChat.accountId);
  await panel.screenshot({ path: join(results, 'sidebar-controls-hidden.png') });
  const fileSnapshot = await browser({ action: 'snapshot', tabId: (globalThis as any).localTab });
  assert.ok(fileSnapshot.text.includes('Local HTML teacher lesson'));
  await browser({ action: 'click', tabId: (globalThis as any).localTab, selector: '#answer' });
  assert.equal(await local.locator('h1').textContent(), 'Solution shown');
  const image = await browser({ action: 'screenshot', tabId: (globalThis as any).localTab }); assert.ok(image.image.length > 100);
  await browser({ action: 'type', tabId: (globalThis as any).fixtureTab, selector: '#name', text: 'Autoum works' }); assert.equal(await web.locator('#name').inputValue(), 'Autoum works');
  const upload = join(directory, 'upload.txt'); await writeFile(upload, 'fixture upload');
  await browser({ action: 'upload', tabId: (globalThis as any).fixtureTab, selector: '#upload', paths: [upload] });
  assert.equal(await web.locator('#upload').evaluate((input: HTMLInputElement) => input.files?.[0].name), 'upload.txt');
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('READ LOCAL FILE'); await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByText('Verified the fixture.', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await panel.locator('.message').first().evaluate(el => getComputedStyle(el).fontSize), '18px', 'Chat text is larger by default');
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  // A real streamed SDK reply must not pull readers away from previous content.
  await rpc('send', { chatId, text: 'QOL STREAM' });
  await panel.getByText('Reading paragraph 24:', { exact: false }).waitFor();
  await panel.waitForFunction(() => { const el = document.querySelector('.conversation')!; return el.scrollHeight - el.scrollTop - el.clientHeight < 5; });
  await panel.locator('.conversation').evaluate(el => { el.scrollTop = 100; });
  await panel.getByRole('button', { name: 'Jump to latest ↓', exact: true }).waitFor();
  const readingPosition = await panel.locator('.conversation').evaluate(el => el.scrollTop);
  releaseScroll!(); await waitIdle();
  await panel.getByText('New paragraph 12:', { exact: false }).waitFor();
  assert.ok(Math.abs(await panel.locator('.conversation').evaluate(el => el.scrollTop) - readingPosition) < 5, 'Streaming and final reply preserve the reader’s position');
  await panel.getByRole('button', { name: 'Jump to latest ↓', exact: true }).click();
  await panel.waitForFunction(() => { const el = document.querySelector('.conversation')!; return el.scrollHeight - el.scrollTop - el.clientHeight < 5; });
  await panel.getByRole('button', { name: 'Jump to latest ↓', exact: true }).waitFor({ state: 'hidden' });
  const copy = panel.locator('.message.assistant').last().getByRole('button', { name: 'Copy reply', exact: true });
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('Keep my draft');
  await copy.click(); await copy.getByText('Copied', { exact: true }).waitFor();
  // Grant read only after the real user-gesture write has succeeded.
  await context.grantPermissions(['clipboard-read'], { origin: base });
  await web.bringToFront();
  assert.equal(await web.evaluate(() => navigator.clipboard.readText()), scrollFirst + scrollLast, 'Copy retains exact Markdown, fenced code and LaTeX');
  await panel.bringToFront();
  assert.equal(await panel.getByRole('textbox', { name: 'Message Autoum' }).inputValue(), 'Keep my draft');
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('');
  await rpc('send', { chatId, text: 'MEMORY TEST PREFERENCE: remember my preferred explanation format' });
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal((await rpc('memory_list', { query: 'fixture 319' })).matches, 1, 'Actual SDK saved a memory through the tool');
  await writeFile(join(directory, 'lesson.html'), '<title>Open test page fixture</title><h1>Clickable local lesson</h1>');
  const localLinkPage = context.waitForEvent('page'); await panel.getByRole('link', { name: 'Open test page', exact: true }).first().click();
  const localLinked = await localLinkPage; await localLinked.waitForURL(pathToFileURL(join(directory, 'lesson.html')).href);
  assert.equal(await localLinked.title(), 'Open test page fixture', 'Sanitized Markdown file links open the real local page');
  const linkPage = context.waitForEvent('page'); await panel.getByRole('link', { name: 'Browser link', exact: true }).first().click();
  const linked = await linkPage; await linked.waitForURL(base + '/fixture');
  const linkTab = (await worker.evaluate(async () => chrome.tabs.query({}))).find(t => t.url === base + '/fixture' && t.active);
  assert.equal(linkTab?.groupId, -1, 'User-clicked result links must not expand the research group'); assert.ok(panel.url().startsWith('chrome-extension://'));
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('Solution shown')), 'Real Pi received the local page tool result');
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('WAIT FOR STEER');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor();
  for (let tries = 0; !steeringWaiting && tries < 250; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(steeringWaiting, 'Model request is held while the user steers');
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('STEER CORRECTION: summarize the local lesson');
  await panel.getByRole('button', { name: 'Steer', exact: true }).click();
  await panel.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('[aria-label="Message Autoum"]')?.value);
  // Wait for acknowledgement in persisted host state before releasing the model.
  for (let tries = 0; tries < 100; tries++) {
    const state = await rpc('state');
    if (state.chats.find((c: any) => c.id === chatId).messages.some((m: any) => m.text.startsWith('STEER CORRECTION'))) break;
    if (tries === 99) throw Error('Steering was not accepted');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  releaseSteering!();
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('STEER CORRECTION')), 'Real Pi received the steering message during the existing task');
  await panel.keyboard.press('Control+k');
  await panel.getByRole('combobox', { name: 'AI provider' }).waitFor();
  assert.equal(await panel.getByRole('combobox', { name: 'AI provider' }).evaluate(el => document.activeElement === el), true);
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('CLICK with approval'); await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByRole('dialog', { name: 'Approve action' }).waitFor({ timeout: 15000 }); assert.equal(await web.locator('h1').textContent(), 'Ready');
  await panel.getByRole('combobox', { name: 'Approval permission mode' }).selectOption('auto-review');
  await panel.getByRole('button', { name: 'Allow and save mode' }).click();
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="Permission mode"]')?.value === 'auto-review');
  await web.getByText('Clicked', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByRole('combobox', { name: 'Permission mode' }).selectOption('auto-review');
  await web.evaluate(() => { document.querySelector('h1')!.textContent = 'Ready'; });
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('CLICK the Say hello button'); await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await web.getByText('Clicked', { exact: true }).waitFor({ timeout: 20000 });
  assert.ok(requests.some(r => r.messages.some((m: any) => JSON.stringify(m.content).includes('independently review'))));
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByRole('combobox', { name: 'Permission mode' }).selectOption('ask');
  await web.evaluate(() => { document.querySelector('h1')!.textContent = 'Ready'; });
  await panel.getByRole('textbox', { name: 'Message Autoum' }).fill('CLICK but cancel this request'); await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByRole('dialog', { name: 'Approve action' }).waitFor(); await panel.keyboard.press('Escape');
  await panel.getByRole('dialog', { name: 'Approve action' }).waitFor({ state: 'hidden', timeout: 10000 });
  assert.equal(await web.locator('h1').textContent(), 'Ready');
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.getByText('Fast browsing', { exact: true }).waitFor();
  for (const provider of ['TypeSafe.ai', 'OpenRouter']) {
    const connection = panel.getByRole('region', { name: `${provider} Jev connection` });
    await connection.getByLabel(`${provider} Jev API key`, { exact: true }).fill(`test-only-${provider}`);
    await connection.getByRole('button', { name: 'Connect', exact: true }).click();
    await connection.getByText('Key connected', { exact: true }).waitFor();
    await panel.waitForFunction(label => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value === '', `${provider} Jev API key`);
    assert.equal(await connection.getByLabel(`${provider} Jev API key`, { exact: true }).inputValue(), '');
    await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await connection.getByText('Not connected', { exact: true }).waitFor();
  }
  const opencode = panel.getByRole('region', { name: 'OpenCode Jev connection' });
  await opencode.getByLabel('OpenCode Jev API key', { exact: true }).fill('fixture-local-only');
  await opencode.getByRole('button', { name: 'Replace', exact: true }).click();
  await opencode.getByText('Key connected', { exact: true }).waitFor();
  await panel.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="OpenCode Jev API key"]')?.value === '');
  assert.equal(await opencode.getByLabel('OpenCode Jev API key', { exact: true }).inputValue(), '');
  const memorySettings = panel.getByRole('region', { name: 'Memory settings', exact: true });
  await memorySettings.locator('summary').click();
  await memorySettings.getByLabel('Memory note', { exact: true }).fill('Prefers diagrams fixture 427'); await memorySettings.getByRole('button', { name: 'Save memory', exact: true }).click();
  await memorySettings.getByText('Prefers diagrams fixture 427', { exact: true }).waitFor();
  const savedMemory = (await rpc('memory_list', { query: 'fixture 427' })).entries[0];
  await memorySettings.getByRole('button', { name: 'Edit memory ' + savedMemory.id, exact: true }).click();
  await memorySettings.getByLabel('Memory note', { exact: true }).fill('Prefers detailed diagrams fixture 427'); await memorySettings.getByRole('button', { name: 'Save correction', exact: true }).click();
  await memorySettings.getByText('Prefers detailed diagrams fixture 427', { exact: true }).waitFor();
  assert.equal((await rpc('memory_list', { query: 'Prefers diagrams fixture 427' })).matches, 0);
  const correctedMemory = (await rpc('memory_list', { query: 'fixture 427' })).entries[0]; await memorySettings.getByRole('button', { name: 'Forget memory ' + correctedMemory.id, exact: true }).click();
  await memorySettings.getByText('Prefers detailed diagrams fixture 427', { exact: true }).waitFor({ state: 'hidden' });
  await memorySettings.getByRole('checkbox', { name: 'Remember useful preferences', exact: true }).uncheck(); await memorySettings.getByLabel('Memory context', { exact: true }).selectOption('16');
  await panel.getByLabel('Chat text size', { exact: true }).selectOption('1.25');
  // Visibility controls and font overrides survive a panel reload.
  const state = await rpc('state'); const otherModel = state.providers.find((p: any) => p.id === 'opencode').models.find((m: any) => m.id !== 'autoum-fixture');
  await panel.getByRole('textbox', { name: 'Search models' }).fill(otherModel.id);
  await panel.getByRole('checkbox', { name: 'Show opencode/' + otherModel.id, exact: true }).uncheck();
  assert.ok((await rpc('state')).hiddenModels.opencode.includes(otherModel.id));
  await panel.getByRole('textbox', { name: 'Search models' }).fill('');
  await panel.getByLabel('Font size', { exact: true }).selectOption('custom');
  await panel.getByRole('slider', { name: 'Sidebar font size' }).focus(); await panel.keyboard.press('Home');
  for (let i = 0; i < 12; i++) await panel.keyboard.press('ArrowRight');
  await panel.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === '24px');
  await panel.getByLabel('Appearance').selectOption('dark'); assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
  await panel.screenshot({ path: join(results, 'settings-dark.png') });
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.reload(); await panel.getByRole('combobox', { name: 'Permission mode', exact: true }).waitFor();
  await panel.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === '24px' && document.documentElement.dataset.theme === 'dark');
  assert.equal(await panel.locator('.message').first().evaluate(el => getComputedStyle(el).fontSize), '30px');
  assert.equal((await rpc('state')).memoryEnabled, false); assert.equal((await rpc('state')).memoryLines, 16);
  assert.equal(await panel.getByRole('combobox', { name: 'AI model' }).inputValue(), 'autoum-fixture');
  assert.equal(await panel.locator('select[aria-label="AI model"] option[value="' + otherModel.id + '"]').count(), 0);
  await panel.getByRole('combobox', { name: 'AI model' }).selectOption('autoum-fixture');
  // New chats inherit model/account/mode. Folders can be removed without deleting conversations.
  await panel.getByRole('combobox', { name: 'Permission mode', exact: true }).selectOption('all');
  await panel.getByRole('button', { name: 'New chat', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="Permission mode"]')?.value === 'all');
  assert.equal(await panel.getByRole('combobox', { name: 'AI model' }).inputValue(), 'autoum-fixture');
  const folder = await rpc('create_folder', { name: 'Research' }); const newest = (await rpc('state')).chats.at(-1);
  await rpc('update_chat', { chatId: newest.id, folderId: folder.id }); await rpc('delete_folder', { folderId: folder.id });
  assert.equal((await rpc('state')).chats.find((c: any) => c.id === newest.id).folderId, undefined);
  await rpc('view_chat', { chatId });
  await panel.getByRole('button', { name: 'Chats and folders', exact: true }).click();
  await rpc('update_chat', { chatId, title: 'Most recent message' });
  await rpc('update_chat', { chatId, mode: 'all' }); await rpc('send', { chatId, text: 'READ LOCAL FILE again' });
  await panel.waitForFunction(() => !document.querySelector('.chat-row .pulse'));
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(await panel.locator('.chat-row').first().innerText(), 'Most recent message');
  const chatList = panel.getByRole('region', { name: 'Chats and folders', exact: true });
  await panel.getByRole('button', { name: 'Chat options for New conversation', exact: true }).click();
  await chatList.getByRole('button', { name: 'Pin', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.chat-row')?.textContent === '⌖ New conversation');
  assert.equal(await panel.locator('.chat-row').first().innerText(), '⌖ New conversation', 'Pinned chats lead newer messages');
  await chatList.getByRole('button', { name: 'Archive', exact: true }).click();
  await panel.getByRole('button', { name: 'Chat options for New conversation', exact: true }).waitFor({ state: 'hidden' });
  await chatList.getByRole('button', { name: 'Archived', exact: true }).click();
  await panel.getByRole('button', { name: 'Chat options for New conversation', exact: true }).click();
  await chatList.getByRole('button', { name: 'Restore', exact: true }).click();
  await chatList.getByRole('button', { name: 'Chats', exact: true }).click();
  await panel.getByRole('button', { name: 'Chat options for New conversation', exact: true }).click();
  await chatList.getByRole('button', { name: 'Unpin', exact: true }).click();
  panel.once('dialog', dialog => dialog.dismiss()); await chatList.getByRole('button', { name: 'Delete', exact: true }).click();
  assert.ok((await rpc('state')).chats.some((c: any) => c.id === newest.id), 'Cancelling deletion preserves the chat');
  panel.once('dialog', dialog => dialog.accept()); await chatList.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.getByRole('button', { name: 'Chat options for New conversation', exact: true }).waitFor({ state: 'hidden' });
  assert.ok(!(await rpc('state')).chats.some((c: any) => c.id === newest.id));
  await rpc('view_chat', { chatId });

  await panel.setViewportSize({ width: 320, height: 900 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Large fonts fit a narrow sidebar');
  assert.ok(await panel.getByRole('combobox', { name: 'Permission mode', exact: true }).evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'Permission controls remain visible with large fonts');
  await panel.screenshot({ path: join(results, 'sidebar-large-font.png') });
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.getByLabel('Font size', { exact: true }).selectOption('browser'); await panel.getByLabel('Appearance').selectOption('browser');
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === '16px');
  // Exercise Google model/account controls through the real ACP SDK and a private fixture process.
  await panel.getByRole('combobox', { name: 'AI provider' }).selectOption('antigravity');
  const googleModel = panel.getByRole('combobox', { name: 'AI model' }), reasoning = panel.getByRole('combobox', { name: 'Reasoning', exact: true });
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="AI model"]')?.selectedOptions[0].textContent === 'Gemini 3.8 Flash');
  assert.equal(await googleModel.locator('option').count(), 3); assert.deepEqual(await reasoning.locator('option').evaluateAll(elements => elements.map((e: any) => e.value)), ['low', 'medium', 'high']);
  await reasoning.selectOption('high'); await rpc('send', { chatId, text: 'ACP selection test' }); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByText('ACP fixture used flash-high', { exact: true }).waitFor();
  const acpRequests = () => readFile(acpLog, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)));
  assert.ok((await acpRequests()).some(r => r.method === 'session/set_config_option' && r.params.value === 'flash-high'));
  assert.ok(!(await acpRequests()).find(r => r.method === 'session/prompt').params.prompt[0].text.includes('Saved memory data'), 'Disabled memory is absent from ACP prompts');
  await googleModel.selectOption('MODEL_PLACEHOLDER_M26'); await reasoning.waitFor({ state: 'hidden' });
  await rpc('send', { chatId, text: 'ACP Opus selection test' }); await panel.getByText('ACP fixture used MODEL_PLACEHOLDER_M26', { exact: true }).waitFor(); await waitIdle();
  await googleModel.selectOption('gpt:gpt-oss-120b'); await reasoning.waitFor({ state: 'visible' }); assert.deepEqual(await reasoning.locator('option').evaluateAll(elements => elements.map((e: any) => e.value)), ['medium']);
  await rpc('send', { chatId, text: 'ACP GPT selection test' }); await panel.getByText('ACP fixture used gpt-oss-medium', { exact: true }).waitFor(); await waitIdle();
  await googleModel.selectOption('gemini:gemini-3.8-flash'); await reasoning.selectOption('high');
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh models for Google Personal fixture', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh models for Google Personal fixture', exact: true }).waitFor({ state: 'visible' });
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();

  await panel.getByRole('combobox', { name: 'AI account' }).selectOption(googleAccounts[1]);
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="AI model"]')?.selectedOptions[0].textContent === 'Gemini 3.1 Pro');
  assert.deepEqual(await reasoning.locator('option').evaluateAll(elements => elements.map((e: any) => e.value)), ['low', 'high']);
  await reasoning.selectOption('low'); await rpc('send', { chatId, text: 'ACP work account test' }); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor(); await panel.getByText('ACP fixture used pro-low', { exact: true }).waitFor();
  assert.ok((await acpRequests()).some(r => r.method === 'session/set_config_option' && r.params.value === 'pro-low' && r.profile.includes(googleAccounts[1])));
  await panel.getByRole('combobox', { name: 'AI account' }).selectOption(googleAccounts[0]); await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Reasoning"]')?.value === 'high');
  await panel.reload(); await googleModel.waitFor(); assert.equal(await googleModel.locator('option').count(), 3); assert.equal(await reasoning.inputValue(), 'high');
  await panel.getByRole('combobox', { name: 'AI provider' }).selectOption('opencode'); await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="AI model"]')?.value === 'autoum-fixture');
  assert.equal(await reasoning.isVisible(), false, 'Nonreasoning models have no ineffective picker');
  await panel.getByRole('button', { name: 'Settings', exact: true }).click(); await panel.getByRole('checkbox', { name: 'Remember useful preferences', exact: true }).check(); await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  // Add a second account through the actual settings form, then verify real SDK requests use it.
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  const accountCard = panel.getByRole('region', { name: 'OpenCode Zen accounts', exact: true });
  await accountCard.getByRole('button', { name: 'Add account', exact: false }).click();
  await panel.getByRole('textbox', { name: 'New account label' }).fill('Work fixture');
  await panel.getByLabel('New account API key', { exact: true }).fill('fixture-work-account');
  await panel.getByRole('dialog', { name: 'Connect AI account' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await panel.getByRole('dialog', { name: 'Connect AI account' }).waitFor({ state: 'hidden' });
  const multi = await rpc('state'); const secondAccount = multi.accounts.find((a: any) => a.label === 'Work fixture'); assert.ok(secondAccount);
  assert.equal(multi.accounts.filter((a: any) => a.provider === 'opencode' && a.configured).length, 2);
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await rpc('update_chat', { chatId, accountId: secondAccount.id });
  expectedKey = 'fixture-work-account'; await rpc('send', { chatId, text: 'READ LOCAL FILE as work account' });
  await waitIdle();
  assert.ok(authorizations.includes('Bearer fixture-work-account'), 'The new account actually makes a model request');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('Prefers illustrated explanations fixture 319'), 'A different account receives shared saved memory');
  await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByRole('combobox', { name: 'AI provider' }).selectOption('antigravity');
  await panel.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="AI provider"]')?.value === 'antigravity');
  const reportResearch = await browser({ action: 'open', chatId, url: base + '/fixture?report-research=1' });
  const reportGroup = (await worker.evaluate(id => chrome.tabs.get(id), reportResearch.tabId)).groupId!;
  await worker.evaluate(id => chrome.tabGroups.update(id, { collapsed: true }), reportGroup);
  await rpc('send', { chatId, text: 'ACP MEMORY REPORT' }); await panel.getByText('ACP memory and report saved', { exact: true }).waitFor(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal((await rpc('memory_list', { query: 'fixture 881' })).matches, 1);
  const researchTab = (await worker.evaluate(async () => chrome.tabs.query({}))).find(t => t.url?.includes('/artifacts/' + chatId + '/')); assert.ok(researchTab?.active); assert.equal(researchTab.groupId, -1, 'The finished report opens outside the research group'); assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), reportGroup)).collapsed, true, 'Showing the report keeps the research tabs collapsed');
  // Reopening a report from an older version also removes it from the research lane.
  await worker.evaluate(async ({ tabId, groupId }) => { await chrome.tabs.group({ tabIds: [tabId], groupId }); }, { tabId: researchTab.id!, groupId: reportGroup });
  await rpc('send', { chatId, text: 'ACP MEMORY REPORT' }); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), researchTab.id!)).groupId, -1);
  assert.equal((await worker.evaluate(id => chrome.tabGroups.get(id), reportGroup)).collapsed, true);
  const researchPage = context.pages().find(p => p.url() === researchTab.url)!; await researchPage.getByRole('heading', { name: 'Google research brief', exact: true }).waitFor();
  await researchPage.locator('.katex').waitFor(); assert.equal(await researchPage.locator('.katex-error').count(), 0); assert.ok((await researchPage.locator('main').textContent())?.includes('$49 and another $79'));
  await researchPage.getByLabel('Filter results', { exact: true }).fill('alternative'); assert.equal(await researchPage.locator('.result:visible').count(), 1);
  await researchPage.getByLabel('Filter results', { exact: true }).fill('role'); await researchPage.getByText('Explore the details', { exact: true }).click(); assert.equal(await researchPage.locator('details').getAttribute('open'), '');
  await researchPage.setViewportSize({ width: 320, height: 900 }); assert.ok(await researchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await researchPage.screenshot({ path: join(results, 'research-brief.png') });
  // Stop and steer the actual ACP transport while a prompt is in flight.
  await rpc('send', { chatId, text: 'ACP WAIT: research until corrected' }); await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor();
  for (let i = 0; i < 100; i++) { if ((await acpRequests()).filter(r => r.method === 'session/prompt').some(r => r.params.prompt[0].text.includes('ACP WAIT'))) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  await rpc('send', { chatId, text: 'ACP CORRECTION: summarize only' }); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.ok((await acpRequests()).some(r => r.method === 'session/cancel')); assert.ok((await acpRequests()).some(r => r.method === 'session/prompt' && r.params.prompt[0].text.includes('ACP CORRECTION')));
  await rpc('send', { chatId, text: 'ACP WAIT: cancelled task' }); await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor(); await panel.getByRole('button', { name: 'Stop and take over', exact: true }).click(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  // Google MCP browser mutations obey Ask and Auto-review just like Pi browser tools.
  await web.evaluate(() => document.querySelector('h1')!.textContent = 'Ready'); await rpc('update_chat', { chatId, mode: 'ask' }); await rpc('send', { chatId, text: 'ACP MCP CLICK ' + (globalThis as any).fixtureTab });
  await panel.getByRole('dialog', { name: 'Approve action' }).waitFor(); await panel.getByRole('button', { name: 'Decline', exact: true }).click(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor(); assert.equal(await web.locator('h1').textContent(), 'Ready');
  await rpc('update_chat', { chatId, mode: 'auto-review' }); await rpc('send', { chatId, text: 'ACP MCP CLICK ' + (globalThis as any).fixtureTab }); await web.getByText('Clicked', { exact: true }).waitFor(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  // Close the real worker-side view port during an in-flight SDK stream.
  await rpc('update_chat', { chatId, provider: 'opencode', accountId: 'default:opencode', model: 'autoum-fixture', mode: 'all' }); expectedKey = 'fixture-local-only';
  await worker.evaluate(`globalThis.captureNextSidebarPort = port => { if (port.name === 'autoum-ui') { globalThis.testSidebarPort = port; chrome.runtime.onConnect.removeListener(globalThis.captureNextSidebarPort); } }; chrome.runtime.onConnect.addListener(globalThis.captureNextSidebarPort);`);
  await panel.reload(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Message Autoum', exact: true }).fill('Draft survives reconnection');
  await panel.waitForTimeout(400);
  await rpc('send', { chatId, text: 'PORT RECONNECT' });
  await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor();
  for (let i = 0; !releaseReconnect && i < 200; i++) await panel.waitForTimeout(20);
  assert.ok(releaseReconnect, 'The SDK stream must be held before disconnecting');
  await worker.evaluate('globalThis.testSidebarPort.disconnect()');
  await panel.locator('.global-error').filter({ hasText: 'Sidebar connection lost. Choose Reconnect to continue.' }).waitFor();
  await panel.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor();
  assert.equal(await panel.getByRole('textbox', { name: 'Message Autoum', exact: true }).inputValue(), 'Draft survives reconnection');
  releaseReconnect(); await waitIdle(); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.ok((await rpc('state')).chats.find((c: any) => c.id === chatId).messages.at(-1).text.includes('Reconnection completed without restarting the task.'));
  assert.equal(requests.filter(r => JSON.stringify(r.messages.filter((m: any) => m.role === 'user').at(-1)?.content).includes('PORT RECONNECT')).length, 1, 'Reconnect must not resend a paid model request');
  // Hold real Chrome commands while an unrelated actual Pi stream is stopped.
  const otherChat = await rpc('new_chat', { provider: 'opencode', model: 'autoum-fixture', mode: 'ask' });
  await rpc('view_chat', { chatId }); await rpc('update_chat', { chatId, mode: 'ask' });
  const stopStream = async () => {
    releaseScroll = undefined;
    await panel.getByRole('textbox', { name: 'Message Autoum', exact: true }).fill('QOL STREAM');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await panel.getByRole('button', { name: 'Steer', exact: true }).waitFor();
    for (let i = 0; !releaseScroll && i < 500; i++) await panel.waitForTimeout(10);
    assert.ok(releaseScroll, 'The actual SDK stream must be active before stopping');
    await panel.getByRole('button', { name: 'Stop and take over', exact: true }).click();
    await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await waitIdle(); (releaseScroll as (() => void) | undefined)?.();
  };
  const otherChatTab = await browser({ chatId: otherChat.id, action: 'open', url: base + '/fixture?other-chat=1' });
  const otherPage = context.pages().find(p => p.url() === base + '/fixture?other-chat=1') || await context.waitForEvent('page');
  await otherPage.waitForURL(base + '/fixture?other-chat=1');
  const holdCommand = (owner: string, tabId?: number) => browser({ chatId: owner, action: 'evaluate', tabId,
    expression: '(async()=>{window.__autoum_waiting=true;await new Promise(resolve=>{window.__autoum_finish=resolve});return document.title})()' }).then(value => ({ value, error: '' }), error => ({ value: undefined, error: error.message }));
  const queueTab = await browser({ chatId, action: 'open', url: base + '/fixture?queue-first=1' });
  const queuePage = context.pages().find(p => p.url() === base + '/fixture?queue-first=1') || await context.waitForEvent('page');
  await queuePage.waitForURL(base + '/fixture?queue-first=1');
  const heldImplicit = holdCommand(chatId);
  await queuePage.waitForFunction(() => (window as any).__autoum_waiting === true);
  const implicitStarted = performance.now();
  let implicitResearchResultMs = 0;
  let independentReply: any, sameTab: Promise<any> | undefined, implicitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    independentReply = await Promise.race([
      browser({ chatId: otherChat.id, action: 'evaluate', expression: 'document.title' }),
      new Promise((_, reject) => { implicitTimer = setTimeout(() => reject(Error('An unrelated implicit research action is blocked')), 500); }),
    ]);
    clearTimeout(implicitTimer); implicitResearchResultMs = performance.now() - implicitStarted;
    sameTab = browser({ chatId, tabId: queueTab.tabId, action: 'evaluate', expression: 'window.__autoum_same_tab=true' });
    await queuePage.waitForTimeout(30);
    assert.equal(await queuePage.evaluate(() => (window as any).__autoum_same_tab), undefined, 'Explicit and implicit actions on the same physical tab must serialize');
  } finally { clearTimeout(implicitTimer); await queuePage.evaluate(() => (window as any).__autoum_finish()); }
  assert.equal(independentReply.result, 'Web fixture');
  assert.equal((await heldImplicit).value?.result, 'Web fixture');
  assert.equal((await sameTab).result, true);
  console.log(JSON.stringify({ implicitResearchIndependent: true, samePhysicalTabSerialized: true, implicitResearchResultMs: +implicitResearchResultMs.toFixed(2), privateProvider: true }));
  const pendingOther = holdCommand(otherChat.id, otherChatTab.tabId);
  await otherPage.waitForFunction(() => (window as any).__autoum_waiting === true);
  await stopStream(); await otherPage.evaluate(() => (window as any).__autoum_finish());
  assert.equal((await pendingOther).value?.result, 'Web fixture', 'Stop must preserve another chat’s real Chrome command');
  const group = await worker.evaluate(async id => { const tab = await chrome.tabs.get(id); return chrome.tabGroups.get(tab.groupId); }, otherChatTab.tabId);
  assert.equal(group.collapsed, true, 'Isolated cleanup retains collapsed research');
  const ownTab = await browser({ chatId, action: 'open', url: base + '/fixture?own-cancel=1' });
  const ownPage = context.pages().find(p => p.url() === base + '/fixture?own-cancel=1') || await context.waitForEvent('page');
  await ownPage.waitForURL(base + '/fixture?own-cancel=1');
  const pendingOwn = holdCommand(chatId, ownTab.tabId); await ownPage.waitForFunction(() => (window as any).__autoum_waiting === true);
  await stopStream(); await ownPage.evaluate(() => (window as any).__autoum_finish());
  assert.match((await pendingOwn).error, /Detached|cancelled|disconnected/i, 'Stop still cancels its own debugger command');
  await otherPage.evaluate(() => { (window as any).__autoum_waiting = false; });
  const pendingShared = holdCommand(chatId, otherChatTab.tabId); await otherPage.waitForFunction(() => (window as any).__autoum_waiting === true);
  const abandonedNavigation = browser({ chatId, action: 'navigate', tabId: otherChatTab.tabId, url: base + '/fixture?abandoned-navigation=1' }).then(() => '', e => e.message);
  await stopStream(); await otherPage.evaluate(() => (window as any).__autoum_finish());
  assert.match((await pendingShared).error, /cancelled/i, 'A released owner cannot continue on another chat’s shared attachment');
  assert.match(await abandonedNavigation, /cancelled/i, 'Queued actions from the cancelled scope cannot start afterward');
  assert.equal(otherPage.url(), base + '/fixture?other-chat=1');
  assert.equal((await browser({ chatId: otherChat.id, action: 'evaluate', tabId: otherChatTab.tabId, expression: 'document.title' })).result, 'Web fixture');
  assert.equal((await browser({ chatId, action: 'evaluate', tabId: ownTab.tabId, expression: 'document.title' })).result, 'Web fixture', 'An explicit next task can reconnect');
  assert.equal((await rpc('state')).chats.find((c: any) => c.id === chatId).mode, 'ask');
  await rpc('stop', { chatId: otherChat.id }); await rpc('stop', { chatId });
  await panel.screenshot({ path: join(results, 'sidebar.png') });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ browser: executablePath, localHtml: true, screenshot: true, typing: true, upload: true, realPi: true, replyCopyMarkdown: true, fullReplyCopyOverNativeLimit: true, expandLongReply: true, longReplyCodeMathAndSanitization: true, boundedHistoryPaging: true, historyPageReload: true, historyPageNarrowLayout: true, streamingReadingPosition: true, jumpToLatest: true, askApproval: true, autoReview: true, stop: true, theme: true, fontInheritance: true, settingsPersist: true, modelVisibility: true, popupModeChange: true, multiAccountRequests: true, recentChatOrder: true, chatPinArchiveDelete: true, nativeTabGroup: true, backgroundResearchGroup: true, legacyResearchGroupMigration: true, manualResearchExpansion: true, researchPopupFocus: true, researchPopupWindows: true, implicitResearchLane: true, closedResearchLaneSafety: true, browserLinks: true, steering: true, googleModelReasoning: true, googleOpusAndGpt: true, modelRefresh: true, googleMcpMemory: true, googleMcpResearch: true, googleMcpApproval: true, googleMcpReview: true, googleSteering: true, researchSavedAndActive: true, reportKeepsResearchCollapsed: true, legacyReportMigration: true, sidebarPortReconnect: true, crossChatDebuggerCleanup: true, implicitResearchIndependent: true, samePhysicalTabSerialized: true, sharedTabDebuggerOwnership: true, cancelledQueuedBrowserAction: true, explicitBrowserReconnect: true, offlineKatex: true, linuxCustomFrame: process.platform === 'linux', researchFiltered: true, googleAccountCatalogs: true, memoryCrud: true, memorySharedAcrossAccounts: true, largerChatDefault: true, chatTextPersisted: true, autoumNewTab: true, collapsibleControls: true, collapsePersisted: true, jevKeys: ['typesafe', 'openrouter', 'opencode'], modelRequests: requests.length }));
} catch (error) {
  const failedPanel = context.pages().find(p => p.url().startsWith('chrome-extension://') && p.url().endsWith('/index.html'));
  if (failedPanel) { await failedPanel.screenshot({ path: join(results, 'browser-failure.png') }).catch(() => {}); console.error((await failedPanel.locator('.error').allTextContents()).join(' ')); }
  throw error;
} finally {
  releaseScroll?.();
  await context.close(); server.closeAllConnections(); server.close();
  await rm(directory, { recursive: true, force: true });
}
