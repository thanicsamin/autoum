// The host's actual filesystem/SDK race is tested separately. This exercises
// the sidebar's cancellation-result contract through its real bridge, holding
// and substituting only the first send reply in a disposable service worker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), results = resolve(process.env.AUTOUM_TEST_RESULTS || 'test-results/send-cancel');
const directory = await mkdtemp(join(tmpdir(), 'autoum-send-cancel-')), agent = join(directory, 'agent'), profile = join(directory, 'profile');
const id = crypto.randomUUID(), text = 'Keep this stopped image draft', errors: string[] = [], requests: any[] = [];
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); requests.push(input);
  assert.equal(req.headers.authorization, 'Bearer local-fixture'); assert.equal(req.headers['x-opencode-session'], id); assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (requests.length <= 2) { res.write(': held model reply\n\n'); return; }
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Retry with your image is ready.' }, finish_reason: null }] };
  res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise<void>(yes => provider.listen(0, '127.0.0.1', yes));
await mkdir(join(agent, 'pi'), { recursive: true });
await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'local-fixture' } }));
await writeFile(join(agent, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`, models: [{ id: 'fixture', name: 'Image fixture', api: 'openai-completions', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Cancelled draft', provider: 'opencode', model: 'fixture', thinking: 'off', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, skillPaths: [], extensionPaths: [] }));
const env = { ...process.env, AUTOUM_DATA_DIR: agent, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: join(directory, 'artifacts'), AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' };
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...env, AUTOUM_PROFILE_ONLY: '1' }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 320, height: 950 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--load-extension=' + join(root, 'dist/extension'), '--no-first-run'], env });
const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(`if (chrome?.storage?.local) { globalThis.draftTrace = []; const originalGet = chrome.storage.local.get.bind(chrome.storage.local), originalSet = chrome.storage.local.set.bind(chrome.storage.local); chrome.storage.local.get = function(keys) { const result = originalGet(keys); result.then(data => { if (Array.isArray(keys) && keys.includes('drafts')) globalThis.draftTrace.push({ kind: 'read', at: performance.now(), drafts: data.drafts }); }); return result; }; chrome.storage.local.set = function(data) { if (data.drafts) globalThis.draftTrace.push({ kind: 'write', at: performance.now(), drafts: data.drafts }); return originalSet(data); }; }`);
try {
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(`globalThis.draftChanges = []; chrome.storage.onChanged.addListener(changes => { if (changes.drafts) globalThis.draftChanges.push(changes.drafts); }); chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'autoum-ui') return; const post = port.postMessage.bind(port); let sendId;
    port.onMessage.addListener(packet => { if (packet.type === 'send' && !globalThis.heldSendReply) sendId = packet.id; });
    port.postMessage = packet => { if (sendId && packet.reply === sendId && !globalThis.heldSendReply) { globalThis.heldSendReply = { original: packet, release: () => post({ reply: packet.reply, data: { cancelled: true } }) }; sendId = undefined; } else post(packet); };
  });`);
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  const input = page.getByRole('textbox', { name: 'Message Autoum', exact: true });
  await input.waitFor();
  await page.evaluate(async () => { await chrome.storage.local.set({ voice: { speakReplies: false, fallbackEnabled: false } }); });
  await page.reload(); await input.waitFor(); await page.bringToFront(); assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  const pixel = await readFile(join(root, 'dist/extension/icons/16.png'));
  await input.evaluate((element, base64) => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'retry-image.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, pixel.toString('base64'));
  await page.locator('.draft-attachment img').waitFor(); await input.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (!await worker.evaluate('!!globalThis.heldSendReply') || Number(requests.length) !== 1) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const draftWritesBeforeCancel = await page.evaluate('globalThis.draftTrace.length');
  await worker.evaluate('globalThis.heldSendReply.release()'); await page.waitForTimeout(100);
  const observation = { draftAfterCancellation: await input.inputValue(), attachmentsAfterCancellation: await page.locator('.draft-attachment').count(), staleSidebarErrors: await page.locator('.global-error').allTextContents(), requestsAfterCancellation: requests.length };
  console.log(JSON.stringify(observation));
  assert.equal(observation.draftAfterCancellation, text); assert.equal(observation.attachmentsAfterCancellation, 1); assert.deepEqual(observation.staleSidebarErrors, []); assert.equal(Number(requests.length), 1);
  const saveDeadline = Date.now() + 10000;
  while (!await page.evaluate(async ({ id, text, since }) => { const trace = (globalThis as any).draftTrace; if (!trace.slice(since).some((entry: any) => entry.kind === 'write' && entry.drafts?.[id] === text)) return false; const saved = await chrome.storage.local.get(['drafts', 'fileDrafts']); return saved.drafts?.[id] === text && saved.fileDrafts?.[id]?.length === 1; }, { id, text, since: draftWritesBeforeCancel })) { assert.ok(Date.now() < saveDeadline, 'The restored draft must actually be saved'); await new Promise(r => setTimeout(r, 20)); }
  await page.reload(); await input.waitFor(); await page.waitForFunction(value => (document.querySelector('.composer textarea') as HTMLTextAreaElement)?.value === value, text); assert.equal(await input.inputValue(), text); await page.locator('.draft-attachment img').waitFor();
  await worker.evaluate('globalThis.heldSendReply = undefined');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const newerDraftDeadline = Date.now() + 10000;
  while (!await worker.evaluate('!!globalThis.heldSendReply') || Number(requests.length) !== 2) { assert.ok(Date.now() < newerDraftDeadline); await new Promise(r => setTimeout(r, 10)); }
  const newerDraft = 'A newer draft typed while waiting'; await input.fill(newerDraft);
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).click(); await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await worker.evaluate('globalThis.heldSendReply.release()'); await page.waitForTimeout(100);
  assert.equal(await input.inputValue(), newerDraft, 'Cancellation cannot overwrite text typed while the old send was pending');
  assert.equal(await page.locator('.draft-attachment').count(), 1); assert.deepEqual(await page.locator('.global-error').allTextContents(), []);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByText('Retry with your image is ready.', { exact: true }).waitFor();
  assert.equal(Number(requests.length), 3); assert.ok(JSON.stringify(requests[2].messages).includes('data:image/png;base64,')); assert.equal(await input.inputValue(), ''); assert.equal(await page.locator('.draft-attachment').count(), 0);
  assert.deepEqual(errors, []); await mkdir(results, { recursive: true });
  const result = { cancelledReplyPreservesDraft: true, cancelledReplyPreservesAttachment: true, newerDraftPreserved: true, noStaleError: true, reloadPreservesDraftAndAttachment: true, explicitRetryWorks: true, stableOpenCodeHeaders: true, foregroundAndFreshDraftSaveChecked: true, syntheticCancellationReply: true, actualFilesystemRaceTestedSeparately: true, paidProvider: false };
  await writeFile(join(results, 'check.json'), JSON.stringify(result, null, 2)); await page.screenshot({ path: join(results, 'sidebar.png') }); console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ workerDrafts: await (context.serviceWorkers()[0]?.evaluate('chrome.storage.local.get("drafts")').catch(() => undefined)), workerChanges: await (context.serviceWorkers()[0]?.evaluate('globalThis.draftChanges').catch(() => undefined)), failureStorage: await page.evaluate(async () => (await chrome.storage.local.get(['drafts', 'fileDrafts'])).drafts).catch(() => undefined), failureTrace: await page.evaluate('globalThis.draftTrace').catch(() => undefined), failureInput: await page.locator('.composer textarea').inputValue().catch(() => undefined) })); await mkdir(results, { recursive: true }); await page.screenshot({ path: join(results, 'failure.png') }).catch(() => {}); throw error; }
finally { await context.close(); provider.closeAllConnections(); await new Promise<void>(yes => provider.close(() => yes())); await rm(directory, { recursive: true, force: true }); }
