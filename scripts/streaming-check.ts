// Controlled SDK streaming with real sidebar rendering; no live provider/profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), directory = await mkdtemp(join(tmpdir(), 'autoum-streaming-'));
const agent = join(directory, 'agent'), profile = join(directory, 'profile'), id = crypto.randomUUID();
const text = Array.from({ length: 80 }, (_, i) => `## Finding ${i + 1}\n\nThe example uses $x^2+y^2=z^2$ and $\\frac{a}{b}$. Read the linked evidence carefully.\n\n- [Source](https://example.test/${i})\n\n`).join('');
const requests: { chatId: string; emitted: number; started: number; ended?: number; closed: boolean; prompt: string }[] = [];
const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.headers.authorization, 'Bearer local-stream-fixture'); assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0');
  const input = JSON.parse(body), prompt = JSON.stringify(input.messages.at(-1).content), chatId = String(req.headers['x-opencode-session']);
  assert.equal(chatId, id);
  const record: (typeof requests)[number] = { chatId, emitted: 0, started: Date.now(), closed: false, prompt }; requests.push(record);
  res.on('close', () => { record.closed = true; });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (content: string, finish: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }] }) + '\n\n');
  if (prompt.includes('RECOVER')) { emit('Recovered after cancellation.', 'stop'); res.end('data: [DONE]\n\n'); record.ended = Date.now(); return; }
  for (let offset = 0; offset < text.length && !record.closed; offset += 24) {
    emit(text.slice(offset, offset + 24)); record.emitted++; await pause(4);
    if (prompt.includes('CANCEL') && record.emitted === 140) { while (!record.closed) await pause(10); return; }
  }
  if (!record.closed) { emit('', 'stop'); res.end('data: [DONE]\n\n'); record.ended = Date.now(); }
});
await new Promise<void>(yes => provider.listen(0, '127.0.0.1', yes));
await mkdir(join(agent, 'pi'), { recursive: true });
await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'local-stream-fixture' } }));
await writeFile(join(agent, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`, models: [{ id: 'stream-fixture', name: 'Stream fixture', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096 }] } } }));
await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Streaming fixture', provider: 'opencode', model: 'stream-fixture', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, skillPaths: [], extensionPaths: [] }));
const env = { ...process.env, AUTOUM_DATA_DIR: agent, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: join(directory, 'artifacts'), AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' };
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...env, AUTOUM_PROFILE_ONLY: '1' }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 420, height: 950 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--load-extension=' + join(root, 'dist/extension'), '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], env });
const results = resolve(process.env.AUTOUM_TEST_RESULTS || 'test-results/streaming-2026-10-06'); await mkdir(results, { recursive: true });
try {
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8')); await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible');
  const rpc = (type: string, data: any = {}) => page.evaluate(async ({ type, data }) => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID();
    return new Promise<any>((yes, no) => { port.onMessage.addListener(packet => { if (packet.reply === id) { port.disconnect(); packet.error ? no(Error(packet.error)) : yes(packet.data); } }); port.postMessage({ id, type, data }); });
  }, { type, data });
  const samples: any[] = [];
  for (let sample = 0; sample < 3; sample++) {
    await page.bringToFront();
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    await page.evaluate(() => {
      const state: any = { frames: [], longTasks: [], updates: 0, savedReplyUpdates: 0, active: true, last: performance.now(), firstUsefulAt: undefined, previousReplies: document.querySelectorAll('.message.assistant').length, previousMarkdown: new Set(document.querySelectorAll('.message .markdown')) }; (window as any).streamMeasurement = state;
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push(entry.duration); }); observer.observe({ entryTypes: ['longtask'] }); state.observer = observer;
      const mutation = new MutationObserver(records => { state.updates++; for (const record of records) { const target = record.target instanceof Element ? record.target : record.target.parentElement; if (state.previousMarkdown.has(target?.closest('.markdown'))) state.savedReplyUpdates++; } const replies = document.querySelectorAll('.message.assistant'); if (state.firstUsefulAt === undefined && replies.length > state.previousReplies && replies.item(replies.length - 1)?.querySelector('.markdown')?.textContent) state.firstUsefulAt = Date.now(); }); mutation.observe(document.querySelector('.conversation-content')!, { subtree: true, childList: true, characterData: true }); state.mutation = mutation;
      state.frame = (now: number) => { if (!state.active) return; state.frames.push(now - state.last); state.last = now; requestAnimationFrame(state.frame); }; requestAnimationFrame(state.frame);
    });
    const before = requests.length, started = Date.now(), inputTimes: number[] = []; let lastDraft = '';
    await rpc('send', { chatId: id, text: 'STREAM SAMPLE ' + sample });
    const deadline = Date.now() + 30000;
    while (requests.length === before) { assert.ok(Date.now() < deadline); await pause(10); }
    const request = requests[before];
    for (let i = 0; i < 8 && !request.ended; i++) { await pause(180); lastDraft = 'Draft remains editable ' + sample + '-' + i; const now = performance.now(); await page.locator('.composer textarea').fill(lastDraft); inputTimes.push(performance.now() - now); }
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Send"]') && !document.querySelector('button[aria-label="Stop and take over"]'), undefined, { timeout: 30000 });
    const idleAt = Date.now();
    const measurement = await page.evaluate(() => {
      const state = (window as any).streamMeasurement; state.active = false; state.observer.disconnect(); state.mutation.disconnect();
      const stats = { summarize(values: number[]) { const sorted = values.slice().sort((a, b) => a - b); return { samples: sorted.length, p95: +(sorted[Math.floor(sorted.length * .95)] || 0).toFixed(2), max: +(sorted.at(-1) || 0).toFixed(2) }; } };
      return { frames: stats.summarize(state.frames), longTasks: stats.summarize(state.longTasks), totalLongTaskMs: +state.longTasks.reduce((a: number, b: number) => a + b, 0).toFixed(2), domUpdates: state.updates, savedReplyUpdates: state.savedReplyUpdates, firstUsefulAt: state.firstUsefulAt, visibility: document.visibilityState };
    });
    const chat = (await rpc('state')).chats.find((chat: any) => chat.id === id);
    assert.equal(measurement.visibility, 'visible', 'Streaming latency must be measured in a foreground sidebar');
    assert.equal(chat.error, ''); assert.equal(chat.messages.at(-1).text, text); assert.equal(await page.locator('.message.assistant').last().locator('.katex').count(), 160);
    assert.equal(await page.locator('.message.assistant').last().getByRole('heading').count(), 80); assert.equal(await page.locator('.composer textarea').inputValue(), lastDraft);
    assert.equal(request.emitted, Math.ceil(text.length / 24)); assert.ok(request.ended); assert.ok(measurement.firstUsefulAt);
    const sorted = inputTimes.slice().sort((a, b) => a - b);
    samples.push({ sample, characters: text.length, deltas: request.emitted, serverPacingMs: request.ended - request.started, firstUsefulFromServerMs: measurement.firstUsefulAt - request.started, taskToIdleMs: idleAt - started, afterServerToIdleMs: idleAt - request.ended, input: { samples: inputTimes.length, p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2), maxMs: +sorted.at(-1)!.toFixed(2) }, ...measurement });
  }
  const beforeCancel = requests.length; await rpc('send', { chatId: id, text: 'CANCEL STREAM FIXTURE' });
  const deadline = Date.now() + 10000;
  while (requests.length === beforeCancel || requests.at(-1)!.emitted < 140) { assert.ok(Date.now() < deadline, 'Cancellation fixture must reach its held chunk'); await pause(10); }
  await page.bringToFront(); assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  const stop = performance.now(); await page.getByRole('button', { name: 'Stop and take over', exact: true }).click(); await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 3000 });
  const stopToSendMs = +(performance.now() - stop).toFixed(2); await pause(100);
  const cancelled = (await rpc('state')).chats.find((chat: any) => chat.id === id); assert.equal(cancelled.error, ''); assert.equal(cancelled.busy, false); assert.equal(cancelled.current, '');
  assert.equal(requests.length, beforeCancel + 1); assert.equal(requests.at(-1)!.closed, true);
  await rpc('send', { chatId: id, text: 'RECOVER STREAM FIXTURE' }); await page.getByText('Recovered after cancellation.', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(requests.length, beforeCancel + 2); assert.deepEqual(errors, []);
  const recovered = (await rpc('state')).chats.find((chat: any) => chat.id === id);
  assert.equal(await page.locator('.message.assistant').count(), recovered.messages.filter((message: any) => message.role === 'assistant').length, 'Cancelled deferred output cannot leave a ghost streaming reply');
  assert.equal(await page.locator('.message.assistant').last().locator('.markdown').innerText(), 'Recovered after cancellation.');
  const result = { samples, stopToSendMs, exactFinalMarkdown: true, renderedMathAndHeadings: true, draftPreserved: true, cancellationNoLateRequest: true, retryWorks: true, realSdk: true, paidProvider: false };
  await writeFile(join(results, 'measurements.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  if (process.env.AUTOUM_STREAM_ASSERT_STABLE === '1') for (const sample of samples) assert.equal(sample.savedReplyUpdates, 0, 'Unchanged saved Markdown must not be replaced while streaming or editing a draft');
} finally { await context.close(); provider.closeAllConnections(); provider.close(); await rm(directory, { recursive: true, force: true }); }
