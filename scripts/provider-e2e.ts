// Real Pi sessions, provider transports, credentials and browser tools against private SDK fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
const root = resolve('.'), directory = await mkdtemp(join(tmpdir(), 'autoum-providers-'));
const nodeDir = join(directory, 'agent'), profile = join(directory, 'profile'), browserAgent = join(directory, 'browser-agent');
process.env.AUTOUM_DATA_DIR = nodeDir; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts'); process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts');
const providers = ['openai', 'openai-codex', 'anthropic', 'opencode', 'opencode-go', 'openrouter'];
const token = (id: string) => 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url') + '.fixture';
const auth: any = Object.fromEntries(providers.map(p => [p, p === 'openai-codex' ? { type: 'oauth', access: token('personal'), refresh: 'fixture', expires: Date.now() + 3600000 } : p === 'anthropic' ? { type: 'oauth', access: 'sk-ant-oat03-fixture-personal', refresh: 'fixture', expires: Date.now() + 3600000 } : { type: 'api_key', key: 'fixture-personal-' + p }]));
let action: any = { action: 'snapshot' }, tool = 'browser', approval: any = false, hold = false, waiting = false, release: (() => void) | undefined;
let requestCount = 0, mainRequests = 0, reviewer = 'allow', fault = false; const wire: any[] = [], cases: any[] = [];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(426).end(); return; }
  let bytes = Buffer.alloc(0); for await (const chunk of req) bytes = Buffer.concat([bytes, chunk]);
  if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes);
  const body = JSON.parse(bytes.toString()), provider = req.url!.split('/')[1], serialized = JSON.stringify(body); requestCount++;
  const review = serialized.includes('independently review');
  if (!review) mainRequests++;
  wire.push({ provider, body, headers: req.headers });
  if (fault) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Denied sk-fixtureleakcredential12345' } })); return; }
  if (['opencode', 'opencode-go'].includes(provider)) { assert.ok(req.headers['x-opencode-session']); assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0'); }
  if (hold && !review) { waiting = true; await new Promise<void>(resolve => { release = resolve; }); hold = false; }
  const last = body.messages?.at(-1) || body.input?.at(-1);
  const result = last?.role === 'tool' || last?.type === 'function_call_output' || last?.content?.some?.((p: any) => p.type === 'tool_result');
  const call = !review && !result && !serialized.includes('STEER MATRIX');
  const name = body.tools?.find((t: any) => (t.name || t.function?.name)?.toLowerCase() === tool)?.name || tool;
  const text = review ? reviewer === 'allow' ? '{"decision":"allow"}' : 'not valid JSON' : 'Provider fixture completed';
  const id = 'call_' + requestCount;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const emit = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (provider === 'anthropic') {
    emit({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 1, output_tokens: 1 } } });
    emit({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id, name, input: {} } : { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(action) } : { type: 'text_delta', text } });
    emit({ type: 'content_block_stop', index: 0 }); emit({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }); emit({ type: 'message_stop' });
  } else if (['openai', 'openai-codex'].includes(provider)) {
    const item: any = call ? { type: 'function_call', id, call_id: id, name: tool, arguments: JSON.stringify(action), status: 'completed' } : { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    emit({ type: 'response.created', response: { id, model: body.model, status: 'in_progress', output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '' } : { ...item, content: [] } });
    if (call) emit({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }); else emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  } else {
    const chunk = { id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: call ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: tool, arguments: JSON.stringify(action) } }] } : { role: 'assistant', content: text }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`); res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }
  res.end();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as any).port}`;
await mkdir(join(nodeDir, 'pi'), { recursive: true }); await writeFile(join(nodeDir, 'pi/auth.json'), JSON.stringify(auth), { mode: 0o600 });
await writeFile(join(nodeDir, 'pi/models.json'), JSON.stringify({ providers: Object.fromEntries(providers.map(p => [p, { baseUrl: base + '/' + p, models: [{ id: 'fixture-' + p, name: 'Fixture ' + p, api: p === 'openai' ? 'openai-responses' : p === 'openai-codex' ? 'openai-codex-responses' : p === 'anthropic' ? 'anthropic-messages' : 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] }])) }));
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { env: { ...process.env, AUTOUM_PROFILE_ONLY: '1', AUTOUM_DATA_DIR: browserAgent, AUTOUM_PROFILE_DIR: profile }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: join(root, 'browser/thorium'), headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`], env: { ...process.env, CHROME_DEVEL_SANDBOX: process.env.CHROME_DEVEL_SANDBOX || '/usr/lib/chromium/chrome-sandbox' } });
let host: InstanceType<typeof AgentHost> | undefined;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const panel = await context.newPage();
  const { extensionId } = JSON.parse(await readFile('dist/build.json', 'utf8')); await panel.goto(`chrome-extension://${extensionId}/index.html`);
  const rpc = (data: any) => panel.evaluate(async data => { const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID(); return new Promise<any>((yes, no) => { port.onMessage.addListener(p => { if (p.reply !== id) return; port.disconnect(); p.error ? no(Error(p.error)) : yes(p.data); }); port.postMessage({ id, type: 'local_browser', data }); }); }, data);
  const web = await context.newPage(), file = join(directory, 'fixture.html'); await writeFile(file, '<h1>Ready</h1><button id="target" onclick="document.querySelector(\'h1\').textContent=\'Verified matrix 519\'">Target</button>'); await web.goto(pathToFileURL(file).href);
  const tabId = (await worker.evaluate(async () => chrome.tabs.query({}))).find(t => t.url === web.url())!.id!;
  host = new AgentHost({ send() {}, request: async (type: string, data: any, signal: any) => { signal?.throwIfAborted(); if (type === 'approval') return approval; return rpc(data); } } as any); await host.init();
  const settle = async (id: string) => { for (let i = 0; host!.current(id).busy && i < 2000; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(host!.current(id).busy, false, 'Provider fixture completes'); assert.equal(host!.current(id).error, ''); };
  for (const provider of providers) {
    await web.evaluate(() => document.querySelector('h1')!.textContent = 'Ready');
    const chat: import('../host/agent.ts').Chat = host.newChat(); await host.handle('update_chat', { chatId: chat.id, provider, accountId: 'default:' + provider, model: 'fixture-' + provider, mode: 'all', thinking: 'off' });
    const run = async (name: string, input: any, mode: string, verify: () => Promise<void>) => { action = input; tool = 'browser'; await host!.handle('update_chat', { chatId: chat.id, mode }); await host!.send(chat.id, 'MATRIX ' + name); await settle(chat.id); await verify(); cases.push({ provider, name, pass: true }); };
    await run('local-html-read', { action: 'snapshot', tabId }, 'ask', async () => { assert.ok(JSON.stringify(wire.at(-1).body).includes('Ready')); });
    await run('verified-browser-mutation', { action: 'click', tabId, selector: '#target' }, 'all', async () => { assert.equal(await web.locator('h1').textContent(), 'Verified matrix 519'); });
    await web.evaluate(() => document.querySelector('h1')!.textContent = 'Ready'); approval = false;
    await run('declined-approval-no-action', { action: 'click', tabId, selector: '#target' }, 'ask', async () => { assert.equal(await web.locator('h1').textContent(), 'Ready'); });
    reviewer = 'malformed'; await run('malformed-review-falls-back-to-ask', { action: 'click', tabId, selector: '#target' }, 'auto-review', async () => { assert.equal(await web.locator('h1').textContent(), 'Ready'); });
    reviewer = 'allow'; await run('reviewed-approval', { action: 'click', tabId, selector: '#target' }, 'auto-review', async () => { assert.equal(await web.locator('h1').textContent(), 'Verified matrix 519'); });
    tool = 'memory'; action = { action: 'note', text: 'Provider matrix preference ' + provider }; await host.send(chat.id, 'Remember MATRIX preference'); await settle(chat.id); assert.equal((await host.memory.list(provider)).matches >= 1, true); cases.push({ provider, name: 'memory-tool-saves', pass: true });
    await web.bringToFront();
    let researchGroup = -1;
    for (const [index, suffix] of ['first', 'second'].entries()) {
      const url = pathToFileURL(file).href + '?research=' + provider + '-' + suffix;
      await run('research-background-group-' + suffix, { action: 'open', url, active: true }, 'all', async () => {
        const tabs = await worker.evaluate(async () => chrome.tabs.query({})), research = tabs.find(tab => tab.url === url)!;
        assert.ok(research); assert.ok(research.groupId! >= 0); assert.equal(research.active, false);
        assert.equal(tabs.find(tab => tab.id === tabId)!.active, true, 'Research must preserve the personal tab focus');
        if (index === 0) researchGroup = research.groupId!; else assert.equal(research.groupId, researchGroup, 'Research stays in one group');
        assert.equal((await worker.evaluate(async groupId => chrome.tabGroups.get(groupId), researchGroup)).collapsed, true);
      });
    }
    tool = 'research_report'; action = { title: 'Research ' + provider, summary: 'Verified fixture findings.', sections: [{ title: 'Finding', text: 'The browser observed the test result.', detail: 'The observed heading was Verified matrix 519.', sources: [{ title: 'Fixture source', url: 'https://example.test/research' }] }] }; await host.handle('update_chat', { chatId: chat.id, mode: 'all' }); await host.send(chat.id, 'Research MATRIX fixture'); await settle(chat.id);
    const reportTabs: chrome.tabs.Tab[] = (await worker.evaluate(async () => chrome.tabs.query({}))).filter(t => t.url?.includes('/artifacts/' + chat.id + '/')); assert.ok(reportTabs.length); assert.ok(reportTabs[0].active); assert.equal(reportTabs[0].groupId, -1);
    assert.equal((await worker.evaluate(async groupId => chrome.tabGroups.get(groupId), researchGroup)).collapsed, true, 'Opening the viewer report must not expand research');
    const report: import('playwright-core').Page = context.pages().find(p => p.url() === reportTabs[0].url)!; await report.getByRole('heading', { name: 'Research ' + provider, exact: true }).waitFor(); assert.equal(await report.locator('details').getAttribute('open'), null); await report.locator('summary').click(); assert.equal(await report.locator('details').getAttribute('open'), ''); cases.push({ provider, name: 'research-html-saved-open-active-outside-collapsed-research', pass: true });
    tool = 'browser'; action = { action: 'click', tabId, selector: '#target' }; await web.evaluate(() => document.querySelector('h1')!.textContent = 'Ready'); hold = true; waiting = false;
    await host.send(chat.id, 'MATRIX cancel'); for (let i = 0; !waiting && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(waiting); await host.stop(chat.id); release!(); await settle(chat.id); assert.equal(await web.locator('h1').textContent(), 'Ready'); cases.push({ provider, name: 'stop-held-request-no-action', pass: true });
    hold = true; waiting = false; await host.send(chat.id, 'MATRIX steer'); for (let i = 0; !waiting && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(waiting); await host.send(chat.id, 'STEER MATRIX: summarize only'); release!(); await settle(chat.id); assert.ok(wire.some(r => r.provider === provider && JSON.stringify(r.body).includes('STEER MATRIX'))); cases.push({ provider, name: 'steer-running-sdk', pass: true });
    const workId = crypto.randomUUID(), credential = provider === 'openai-codex' ? { ...auth[provider], access: token('work') } : provider === 'anthropic' ? { ...auth[provider], access: 'sk-ant-oat03-fixture-work' } : { type: 'api_key', key: 'fixture-work-' + provider };
    const authPath = host.accounts.authPath(workId); await mkdir(join(nodeDir, 'accounts', workId), { recursive: true }); await writeFile(authPath, JSON.stringify({ [provider]: credential }), { mode: 0o600 });
    host.accounts.records.push({ id: workId, provider, label: 'Work fixture', configured: true, method: ['anthropic', 'openai-codex'].includes(provider) ? 'oauth' : 'api_key' }); await host.accounts.save(); await host.accounts.init();
    await host.handle('update_chat', { chatId: chat.id, accountId: workId }); tool = 'browser'; action = { action: 'snapshot', tabId }; await host.send(chat.id, 'MATRIX work-account request'); await settle(chat.id);
    const lastWire = wire.at(-1); assert.equal(lastWire.provider, provider); assert.equal(lastWire.headers.authorization, 'Bearer ' + (credential.access || credential.key));
    if (provider === 'openai-codex') assert.equal(lastWire.headers['chatgpt-account-id'], 'work');
    assert.ok(JSON.stringify(lastWire.body).includes('Provider matrix preference ' + provider)); cases.push({ provider, name: 'account-switch-auth-and-shared-memory', pass: true });
    await web.evaluate(() => document.querySelector('h1')!.textContent = 'Ready'); action = { action: 'click', tabId, selector: '#target' }; fault = true; await host.send(chat.id, 'MATRIX unavailable account');
    for (let i = 0; host.current(chat.id).busy && i < 3000; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(host.current(chat.id).busy, false); assert.ok(host.current(chat.id).error); assert.ok(!host.current(chat.id).error.includes('sk-fixtureleak')); assert.equal(await web.locator('h1').textContent(), 'Ready'); fault = false;
    cases.push({ provider, name: 'provider-auth-failure-no-action-credential-redacted', pass: true });
    console.log(provider + ': ' + cases.filter(c => c.provider === provider).length + ' provider/browser checks passed');
  }
  await host.close(); host = new AgentHost({ send() {}, request: async (_type: string, data: any) => rpc(data) } as any); await host.init();
  const restored = host.newChat(); assert.equal(restored.provider, 'openrouter'); assert.equal(host.accounts.record(restored.accountId!).label, 'Work fixture'); assert.equal(restored.model, 'fixture-openrouter'); cases.push({ provider: 'all', name: 'last-account-and-model-host-restart', pass: true });
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/provider-e2e.json', JSON.stringify({ date: new Date().toISOString(), tier: 'controlled-real-sdk-transports', cases, requests: requestCount, mainRequests }, null, 2));
} finally { if (host) await host.close(); release?.(); await context.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
