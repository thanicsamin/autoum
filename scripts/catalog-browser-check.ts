import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), temp = await mkdtemp(join(tmpdir(), 'autoum-catalog-browser-'));
const data = join(temp, 'data'), profile = join(temp, 'profile'), chatId = crypto.randomUUID();
let list = ['live-a'], calls = 0, failed = false, context: any;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const model = (id: string) => ({ id, name: id.toUpperCase(), provider: 'opencode-go', api: 'openai-completions', baseUrl: base + '/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 });
  if (req.url?.startsWith('/api/models/providers/')) { res.setHeader('Last-Modified', new Date(Date.now() + 60000).toUTCString()); res.end(JSON.stringify({ models: list.map(model) })); return; }
  assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer synthetic-only'); assert.equal(req.headers['x-opencode-session'], chatId); assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0'); calls++;
  res.statusCode = failed ? 503 : 200; res.end(JSON.stringify({ data: list.map(id => ({ id })) }));
});
await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const base = `http://127.0.0.1:${(server.address() as any).port}`;
try {
  await mkdir(join(data, 'pi'), { recursive: true });
  await writeFile(join(data, 'pi/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'synthetic-only' } }));
  await writeFile(join(data, 'pi/models.json'), JSON.stringify({ providers: { 'opencode-go': { baseUrl: base + '/v1' } } }));
  await writeFile(join(data, 'settings.json'), JSON.stringify({ activeChatId: chatId, skillPaths: [], extensionPaths: [], chats: [{ id: chatId, title: 'Live models', provider: 'opencode-go', accountId: 'default:opencode-go', model: 'live-a', mode: 'ask', messages: [], cwd: temp }] }));
  const env = { ...process.env, AUTOUM_DATA_DIR: data, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: join(temp, 'artifacts'), AUTOUM_PROFILE_ONLY: '1', AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1', AUTOUM_MODEL_CATALOG_TEST_URL: base };
  execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env, stdio: 'pipe' });
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`, '--no-first-run'], env });
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8')); const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/index.html`); await panel.getByRole('textbox', { name: 'Message Autoum' }).waitFor();
  const rpc = (type: string, data: any = {}) => panel.evaluate(({ type, data }: any) => new Promise<any>((yes, no) => { const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID(); port.onMessage.addListener(packet => { if (packet.reply === id) { port.disconnect(); packet.error ? no(Error(packet.error)) : yes(packet.data); } }); port.postMessage({ id, type, data }); }), { type, data });
  await rpc('refresh_models', { accountId: 'default:opencode-go', chatId });
  if (await panel.getByRole('button', { name: 'Show model controls' }).count()) await panel.getByRole('button', { name: 'Show model controls' }).click(); await panel.getByRole('combobox', { name: 'AI model' }).getByRole('option', { name: 'LIVE-A', exact: true }).waitFor({ state: 'attached' });
  list = ['live-b']; await panel.getByRole('button', { name: 'Settings', exact: true }).click(); await panel.getByRole('button', { name: 'Refresh models for Personal', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh models for Personal', exact: true }).waitFor(); await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  const picker = panel.getByRole('combobox', { name: 'AI model' }); await picker.getByRole('option', { name: 'LIVE-B', exact: true }).waitFor({ state: 'attached' });
  assert.match(await picker.getByRole('option', { selected: true }).innerText(), /unavailable/); assert.equal(await picker.inputValue(), 'live-a', 'Retirement does not overwrite the saved preference');
  await picker.selectOption('live-b'); await panel.getByRole('button', { name: 'Send', exact: true }).waitFor(); assert.equal((await rpc('state')).chats[0].model, 'live-b');
  failed = true; await assert.rejects(rpc('refresh_models', { accountId: 'default:opencode-go', chatId }), /503/); assert.equal((await rpc('state')).providers.find((p: any) => p.id === 'opencode-go').accountModels['default:opencode-go'][0].id, 'live-b');
  console.log(JSON.stringify({ ok: true, modelAdditionAndRetirement: true, actualSettingsRefresh: true, retiredPreferencePreserved: true, providerFailureRetainsModels: true, stableOpenCodeHeaders: true, requests: calls }));
} finally { await context?.close(); server.closeAllConnections(); server.close(); await rm(temp, { recursive: true, force: true }); }
