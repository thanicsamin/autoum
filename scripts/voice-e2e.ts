import assert from 'node:assert/strict';
import { checkLocalConversation } from './fixtures/local-conversation.js';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), directory = await mkdtemp(join(tmpdir(), 'autoum-features-'));
const agent = join(directory, 'agent'), profile = join(directory, 'profile'), artifacts = join(directory, 'artifacts'), id = crypto.randomUUID();
const mcpPids = join(directory, 'mcp-pids');
const mcpGate = join(directory, 'mcp-ready'), mcpToolLog = join(directory, 'mcp-tool-log');
await mkdir(join(agent, 'pi'), { recursive: true }); const errors: string[] = [], nativeEvents: any[] = [], providerRequests: any[] = [];
const mathReply = String.raw`Voice reply ready.

## Markdown and math

Inline $x^2$ and \(\frac12\).

\[\begin{bmatrix}1&2\\3&4\end{bmatrix}\]

| Result | Value |
| --- | --- |
| square | $y_i$ |

- **Bold** and *italic*

\`$literal$\`

Costs $49 and another $79.

<span style="position:fixed" onclick="window.hacked=true">Untrusted HTML</span><script>window.hacked=true</script>` .replaceAll('\\`', '`');
const provider = createServer(async (req, res) => {
  if (req.url === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Voice browser fixture</title><h1>Ready</h1><button id="hello" onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Hello</button>'); return; }
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); providerRequests.push(input);
  assert.equal(req.headers.authorization, 'Bearer local-fixture'); assert.equal(req.headers['x-opencode-session'], id);
  const last = input.messages.at(-1), prompt = JSON.stringify(last.content), mcp = input.tools.find((t: any) => t.function.name.startsWith('mcp_fixture_greet'));
  const wantsMcp = last.role === 'user' && prompt.includes('MCP HELLO');
  const delta = wantsMcp ? { role: 'assistant', tool_calls: [{ index: 0, id: 'mcp-call', type: 'function', function: { name: mcp.function.name, arguments: '{"name":"Autoum"}' } }] } : { role: 'assistant', content: mathReply };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }; res.write('data: ' + JSON.stringify(chunk) + '\n\n'); if (prompt.includes('Hold voice conversation fixture')) { await new Promise<void>(resolve => res.on('close', resolve)); return; } res.end('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: wantsMcp ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise<void>(yes => provider.listen(0, '127.0.0.1', yes)); const base = `http://127.0.0.1:${(provider.address() as any).port}`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
const tls = createHttpsServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) }); const wss = new WebSocketServer({ server: tls });
let fixtureTab = 0, turns = 0, nativeSamples = 0, toolResults = 0;
let holdSessionUpdate = false, releaseSessionUpdate: (() => void) | undefined;
let holdNativeResponses = false, emitNativeFixture: ((event: any) => void) | undefined;
const imagePath = join(directory, 'picture.png'), pixel = await readFile(join(root, 'dist/extension/icons/16.png')); await writeFile(imagePath, pixel);
wss.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer native-fixture'); let pending = false, text = '', callNumber = 0, automatic = false, automaticSent = false;
  const emit = (data: any) => socket.send(JSON.stringify(data));
  emitNativeFixture = emit;
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString()); nativeEvents.push(event);
    if (event.type === 'session.update') { assert.ok(['marin', 'cedar'].includes(event.session.audio.output.voice)); automatic = event.session.audio.input.turn_detection?.type === 'semantic_vad'; assert.equal(event.session.audio.input.format.rate, 24000); assert.ok(event.session.instructions.includes(artifacts)); const acknowledge = () => emit({ type: 'session.updated', session: event.session }); if (holdSessionUpdate) releaseSessionUpdate = acknowledge; else acknowledge(); }
    if (event.type === 'input_audio_buffer.append') { nativeSamples += Buffer.from(event.audio, 'base64').length / 2; if (automatic && !automaticSent) { automaticSent = true; turns++; emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'automatic-user', transcript: 'Automatic voice turn.' }); emit({ type: 'response.created', response: { id: 'automatic-response', status: 'in_progress' } }); emit({ type: 'response.output_audio_transcript.delta', response_id: 'automatic-response', item_id: 'automatic-reply', delta: 'Automatic spoken reply.' }); emit({ type: 'response.done', response: { id: 'automatic-response', status: 'completed', output: [] } }); } }
    if (event.type === 'input_audio_buffer.commit') { turns++; emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-' + turns, transcript: turns === 1 ? 'Look at the page.' : 'Click the button.' }); }
    if (event.type === 'conversation.item.create' && event.item.role === 'user') text = JSON.stringify(event.item.content);
    if (event.type === 'conversation.item.create' && event.item.type === 'function_call_output') { toolResults++; pending = true; }
    if (event.type === 'response.create') {
      if (holdNativeResponses) return;
      const responseId = 'response-' + nativeEvents.length; emit({ type: 'response.created', response: { id: responseId, status: 'in_progress' } });
      if (!pending) {
        const args = text.includes('SEND IMAGE') ? { path: imagePath, caption: 'Here is your image.' } : turns === 2 ? { action: 'click', tabId: fixtureTab, selector: '#hello' } : { action: 'snapshot', tabId: fixtureTab };
        emit({ type: 'response.done', response: { id: responseId, status: 'completed', output: [{ type: 'function_call', name: text.includes('SEND IMAGE') ? 'send_attachment' : 'browser', call_id: 'call-' + (++callNumber), arguments: JSON.stringify(args) }] } });
      } else {
        pending = false; const pcm = new Int16Array(24000); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 24000 * 440 * Math.PI * 2) * 2000);
        emit({ type: 'response.output_audio.delta', response_id: responseId, item_id: 'assistant-' + callNumber, content_index: 0, delta: Buffer.from(pcm.buffer).toString('base64') }); emit({ type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: 'assistant-' + callNumber, delta: 'Native spoken reply.' }); emit({ type: 'response.done', response: { id: responseId, status: 'completed', output: [] } });
      }
    }
  });
});
await new Promise<void>(yes => tls.listen(0, '127.0.0.1', yes));
await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'local-fixture' }, openai: { type: 'api_key', key: 'native-fixture' } }));
await writeFile(join(agent, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl: base + '/v1', models: [{ id: 'fixture', name: 'Fixture text and images', api: 'openai-completions', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Feature fixture', provider: 'opencode', model: 'fixture', thinking: 'off', mode: 'all', messages: [], requests: [], cwd: directory }], activeChatId: id, skillPaths: [], extensionPaths: [] }));
const env = { ...process.env, AUTOUM_DATA_DIR: agent, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: artifacts, AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1', AUTOUM_REALTIME_TEST_URL: `wss://127.0.0.1:${(tls.address() as any).port}/v1/realtime` };
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...env, AUTOUM_PROFILE_ONLY: '1' }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 420, height: 950 }, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(process.env.AUTOUM_VOICE_TEST_WAV || 'tests/fixtures/voice-input.wav')}`, '--autoplay-policy=no-user-gesture-required'], env });
const modelDownloads: string[] = []; context.on('request', r => { if (/huggingface\.co|cdn\.jsdelivr\.net|unpkg\.com/.test(r.url())) modelDownloads.push(r.url()); });
const page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
try {
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8')); await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const rpc = (type: string, data: any = {}) => page.evaluate(async ({ type, data }) => { const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID(); return await new Promise<any>((yes, no) => { port.onMessage.addListener(packet => { if (packet.reply === id) { port.disconnect(); packet.error ? no(Error(packet.error)) : yes(packet.data); } }); port.postMessage({ id, type, data }); }); }, { type, data });
  const idle = async () => { for (let i = 0; i < 1000; i++) { const chat = (await rpc('state')).chats.find((c: any) => c.id === id); if (!chat.busy) { assert.equal(chat.error, ''); return; } await new Promise(r => setTimeout(r, 20)); } throw Error('Task never finished.'); };
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('checkbox', { name: 'Speak replies automatically' }).uncheck();
  assert.equal(await page.getByLabel('Artifacts folder', { exact: true }).inputValue(), artifacts);
  const skill = join(directory, 'skills/example'); await mkdir(skill, { recursive: true }); await writeFile(join(skill, 'SKILL.md'), '---\nname: fixture-explainer\ndescription: Explain fixtures simply.\n---\nUse a small example.');
  await page.getByLabel('Additional skill folders', { exact: true }).fill(join(directory, 'skills')); await page.getByRole('button', { name: 'Save skill folders', exact: true }).click(); await page.getByText('Installed skills', { exact: false }).click(); await page.getByRole('checkbox', { name: 'Enable skill fixture-explainer' }).waitFor();
  await page.getByRole('checkbox', { name: 'Enable skill fixture-explainer' }).uncheck(); await page.getByRole('checkbox', { name: 'Enable skill fixture-explainer' }).check();
  await writeFile(mcpGate, '');
  await rpc('configure', { mcpServers: [{ name: 'fixture', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: mcpPids, AUTOUM_MCP_FIXTURE_GATE: mcpGate, AUTOUM_MCP_FIXTURE_TOOL_LOG: mcpToolLog } }] });
  await page.getByRole('button', { name: 'Test connection', exact: true }).click(); await page.getByText('fixture connected · 1 tools', { exact: true }).waitFor();
  if (!process.env.AUTOUM_SKIP_LOCAL_TEST) { console.log('Checking bundled Kokoro speech…'); await page.getByRole('button', { name: 'Preview fallback voice', exact: true }).click(); await page.getByRole('button', { name: 'Stop speaking', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop speaking', exact: true }).waitFor({ state: 'hidden', timeout: 180000 }); assert.equal((await page.locator('.voice-status.error').allTextContents()).length, 0);
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Start voice', exact: true }).isEnabled(), true);
  console.log('Checking bundled Whisper microphone input…');
  // Actual fake microphone -> local bundled Whisper -> selected Pi provider. No voice model download.
  await page.getByRole('button', { name: 'Start voice', exact: true }).click(); await page.getByRole('button', { name: 'Finish speaking', exact: true }).waitFor(); await page.waitForTimeout(12000); await page.getByRole('button', { name: 'Finish speaking', exact: true }).click();
  await page.getByText('Voice reply ready.', { exact: true }).waitFor({ timeout: 180000 }); await idle();
  assert.ok(providerRequests.some(r => JSON.stringify(r.messages).toLowerCase().includes('country')), 'Real local ASR reaches the selected chat provider'); } else { await page.reload(); await rpc('send', { chatId:id, text:'Fixture first message' }); await idle(); }
  assert.ok(await page.locator('.message.assistant .katex').count() >= 4); assert.equal(await page.locator('.message.assistant table').count(), 1); assert.equal(await page.locator('.message.assistant code').innerText(), '$literal$'); assert.equal(await page.evaluate(() => (window as any).hacked), undefined); assert.equal(await page.locator('.message.assistant [onclick],.message.assistant [style*="position"]').count(), 0);
  await mkdir('test-results', { recursive: true }); await checkLocalConversation(page, providerRequests);
  if (process.env.AUTOUM_VOICE_BUTTON_ONLY) {
    assert.deepEqual(errors, []); assert.deepEqual(modelDownloads, []);
    const result = { ok: true, waveformVoiceButton: true, responsiveLayouts: 36, localConversationTurns: true, microphoneStartupCancellation: true, transcriptionCancellation: true, pendingModelCancellation: true, speechLoadCancellation: true, changingVoiceReleasesMicrophone: true, selectedProviderSdk: true, localAssetsOnly: true, liveNativeAccount: false };
    await writeFile('test-results/voice-button-e2e.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } else {
  await page.locator('.composer textarea').evaluate((element, base64) => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, pixel.toString('base64'));
  await page.locator('.draft-attachment img').waitFor(); await page.waitForFunction(() => { const image = document.querySelector('.draft-attachment img') as HTMLImageElement; return image?.complete && image.naturalWidth > 0; });
  const truncatedUpload = await rpc('attachment_start', { chatId: id, name: 'truncated-upload.png', mimeType: 'image/png', size: pixel.length });
  await rpc('attachment_chunk', { chatId: id, id: truncatedUpload.id, offset: 0, data: pixel.toString('base64') });
  const stagedPath = join(artifacts, id, 'attachments', truncatedUpload.id + '-truncated-upload.png.upload');
  await writeFile(stagedPath, pixel.subarray(0, 16));
  await assert.rejects(rpc('attachment_finish', { chatId: id, id: truncatedUpload.id }), /incomplete|again/i);
  await assert.rejects(readFile(stagedPath), { code: 'ENOENT' });
  await assert.rejects(rpc('attachment_preview', { chatId: id, id: truncatedUpload.id, offset: 0 }), /not found/i);
  const changedUpload = await rpc('attachment_start', { chatId: id, name: 'changed-preview.png', mimeType: 'image/png', size: pixel.length });
  await rpc('attachment_chunk', { chatId: id, id: changedUpload.id, offset: 0, data: pixel.toString('base64') });
  const changedItem = await rpc('attachment_finish', { chatId: id, id: changedUpload.id }); await writeFile(changedItem.path, '');
  await page.evaluate(async ({ chatId, item }) => { const stored = await chrome.storage.local.get('fileDrafts'); const drafts = stored.fileDrafts || {}; drafts[chatId] = [...(drafts[chatId] || []), item]; await chrome.storage.local.set({ fileDrafts: drafts }); }, { chatId: id, item: changedItem });
  await worker.evaluate(`globalThis.changedPreviewReads = 0; chrome.runtime.onConnect.addListener(port => port.onMessage.addListener(packet => { if (packet.type === 'attachment_preview' && packet.data.id === ${JSON.stringify(changedItem.id)}) globalThis.changedPreviewReads++; }));`);
  await page.reload(); const changedPreview = page.locator('.draft-attachment').filter({ hasText: 'changed-preview.png' });
  await changedPreview.locator('.error').filter({ hasText: 'This attachment changed on disk.' }).waitFor();
  assert.equal(await worker.evaluate('globalThis.changedPreviewReads'), 1, 'A changed image must stop after one failed read, without an RPC loop');
  await page.getByRole('textbox', { name: 'Message Autoum', exact: true }).fill('Draft remains usable');
  await page.getByRole('button', { name: 'Remove attachment changed-preview.png', exact: true }).click();
  assert.equal(await page.locator('.draft-attachment .error').count(), 0); assert.equal(await page.getByRole('textbox', { name: 'Message Autoum', exact: true }).inputValue(), 'Draft remains usable');
  await page.reload(); await page.locator('.draft-attachment img').waitFor(); const beforeImage = providerRequests.length; await page.locator('.composer textarea').fill('Review this image and $z^2$.'); await page.getByRole('button', { name: 'Send', exact: true }).click(); for (let i = 0; i < 500 && providerRequests.length === beforeImage; i++) await new Promise(r => setTimeout(r, 20)); await idle();
  assert.ok(providerRequests.some(r => JSON.stringify(r.messages).includes('data:image/png;base64,'))); assert.equal(await page.locator('.draft-attachment').count(), 0); await page.locator('.message.user img').waitFor(); assert.ok(await page.locator('.message.user .katex').count());
  await rpc('send', { chatId: id, text: 'MCP HELLO' }); await idle(); assert.ok(providerRequests.some(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('Hello Autoum from MCP'))));
  const exitedMcpPid = Number((await readFile(mcpPids, 'utf8')).trim().split('\n').at(-1));
  process.kill(exitedMcpPid, 'SIGTERM');
  for (let i = 0; i < 500; i++) { try { process.kill(exitedMcpPid, 0); } catch { break; } await new Promise(r => setTimeout(r, 10)); }
  await rm(mcpGate);
  const beforeCancelledReconnect = providerRequests.length, callsBeforeStop = await readFile(mcpToolLog, 'utf8');
  await rpc('send', { chatId: id, text: 'MCP HELLO CANCELLED' });
  const reconnectDeadline = Date.now() + 5000;
  while ((await readFile(mcpPids, 'utf8')).trim().split('\n').length < 2) { assert.ok(Date.now() < reconnectDeadline, 'The reconnect fixture must spawn'); await new Promise(r => setTimeout(r, 10)); }
  const visibilityBeforeForeground = await page.evaluate(() => document.visibilityState);
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'MCP cancellation latency must be measured in a foreground sidebar');
  const reconnectStop = performance.now();
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).click();
  const clickedAt = performance.now();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 1000 });
  const sendVisibleAt = performance.now(); await idle(); const hostIdleAt = performance.now();
  assert.equal(providerRequests.length, beforeCancelledReconnect + 1, 'Stop must not start another model request after cancelling the MCP wait');
  assert.equal(await readFile(mcpToolLog, 'utf8'), callsBeforeStop, 'The cancelled MCP action must not execute');
  console.log(JSON.stringify({ mcpReconnectStopToSendMs: +(hostIdleAt - reconnectStop).toFixed(2), visibilityBeforeForeground, measuredVisibility: await page.evaluate(() => document.visibilityState), clickMs: +(clickedAt - reconnectStop).toFixed(2), sendVisibleAfterClickMs: +(sendVisibleAt - clickedAt).toFixed(2), hostIdleAfterSendMs: +(hostIdleAt - sendVisibleAt).toFixed(2), lateMcpActions: 0 }));
  await writeFile(mcpGate, '');
  const beforeRecovery = providerRequests.length;
  await rpc('send', { chatId: id, text: 'MCP HELLO AGAIN' }); await idle();
  assert.ok(providerRequests.slice(beforeRecovery).some(r => r.messages.at(-1)?.role === 'tool' && JSON.stringify(r.messages.at(-1).content).includes('Hello Autoum from MCP')));
  assert.notEqual(Number((await readFile(mcpPids, 'utf8')).trim().split('\n').at(-1)), exitedMcpPid);
  assert.equal(await readFile(mcpToolLog, 'utf8'), callsBeforeStop + 'executed\n', 'only the separate retry may execute after releasing the old gate');
  const web = await context.newPage(); await web.goto(base + '/fixture'); fixtureTab = (await page.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)!.id, base + '/fixture'))!;
  console.log('Checking native model audio conversation…');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('checkbox', { name: 'Speak replies automatically' }).check(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await rpc('update_chat', { chatId: id, provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask' });
  holdSessionUpdate = true;
  for (const stopAction of ['Stop and take over', 'End voice']) {
    releaseSessionUpdate = undefined;
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    const cancelledSettingsDeadline = Date.now() + 5000;
    while (!releaseSessionUpdate) { assert.ok(Date.now() < cancelledSettingsDeadline, 'The cancelled native fixture must receive session.update'); await new Promise(r => setTimeout(r, 10)); }
    await page.bringToFront(); const nativeSettingsStopAt = performance.now();
    await page.getByRole('button', { name: stopAction, exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 1000 }); await idle();
    assert.equal(await page.getByRole('button', { name: 'Finish speaking', exact: true }).count(), 0);
    assert.equal(await page.locator('.voice-status.error').count(), 0);
    console.log(JSON.stringify({ nativeSettingsStopAction: stopAction, nativeSettingsStopToSendMs: +(performance.now() - nativeSettingsStopAt).toFixed(2), noStaleVoiceError: true }));
  }
  // Neither stopped socket receives an ACK. A separate connection must start
  // normally without waiting for either former fifteen-second deadline.
  releaseSessionUpdate = undefined;
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  const nativeHandshakeDeadline = Date.now() + 5000;
  while (!releaseSessionUpdate) { assert.ok(Date.now() < nativeHandshakeDeadline, 'The native fixture must receive session.update'); await new Promise(r => setTimeout(r, 10)); }
  const beforeEarlyNativeText = (await rpc('state')).chats.find((c: any) => c.id === id), eventsBeforeEarlyNativeText = nativeEvents.length;
  await assert.rejects(rpc('send', { chatId: id, text: 'Typed before native voice is connected' }), /Wait for native voice to connect/);
  const afterEarlyNativeText = (await rpc('state')).chats.find((c: any) => c.id === id);
  assert.deepEqual(afterEarlyNativeText.messages, beforeEarlyNativeText.messages, 'Rejected startup text must not become an unsent saved message');
  assert.equal(afterEarlyNativeText.historyTotal, beforeEarlyNativeText.historyTotal); assert.equal(afterEarlyNativeText.busy, true); assert.equal(afterEarlyNativeText.error, '');
  assert.equal(nativeEvents.length, eventsBeforeEarlyNativeText, 'Early native text cannot interrupt or start a turn');
  holdSessionUpdate = false; (releaseSessionUpdate as (() => void) | undefined)!(); releaseSessionUpdate = undefined;
  await page.getByRole('button', { name: 'Finish speaking', exact: true }).waitFor(); await page.waitForTimeout(500); await page.getByRole('button', { name: 'Finish speaking', exact: true }).click(); await page.getByText('Native spoken reply.', { exact: true }).waitFor();
  assert.ok(nativeSamples > 2400); assert.ok(toolResults > 0); assert.ok(nativeEvents.some(e => e.type === 'session.update'));
  await page.getByRole('button', { name: 'Start voice', exact: true }).click(); await page.waitForTimeout(500); await page.getByRole('button', { name: 'Finish speaking', exact: true }).click(); await page.getByRole('dialog', { name: 'Approve action' }).waitFor(); await page.getByRole('button', { name: 'Decline', exact: true }).click(); assert.equal(await web.locator('h1').innerText(), 'Ready');
  await page.getByRole('button', { name: 'End voice', exact: true }).click(); await idle();
  await rpc('update_chat', { chatId: id, mode: 'all' }); await page.locator('.composer textarea').fill('SEND IMAGE'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByText('Here is your image.', { exact: true }).waitFor(); await page.locator('.message.assistant img').waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('.message.assistant img') as HTMLImageElement; return image?.complete && image.naturalWidth > 0; });
  console.log('Checking late native media and out-of-order completion after typed steering…');
  const mediaDeadline = Date.now() + 5000;
  while ((await rpc('state')).chats.find((c: any) => c.id === id).activity !== 'Voice connected') { assert.ok(Date.now() < mediaDeadline, 'Prior native reply must finish'); await new Promise(r => setTimeout(r, 10)); }
  await rpc('update_chat', { chatId: id, mode: 'ask' }); holdNativeResponses = true;
  await page.evaluate(() => {
    const counts = { old: 0, fresh: 0 }, original = AudioBufferSourceNode.prototype.start;
    (globalThis as any).nativeMediaPlayback = counts;
    (globalThis as any).restoreMediaPlayback = () => { AudioBufferSourceNode.prototype.start = original; };
    AudioBufferSourceNode.prototype.start = function(when?: number, offset?: number, duration?: number) {
      if (this.buffer?.length === 37) counts.old++; if (this.buffer?.length === 53) counts.fresh++;
      original.call(this, when, offset, duration);
    };
  });
  const waitNative = async (predicate: () => boolean, message: string) => { const deadline = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(r => setTimeout(r, 10)); } };
  const responseCount = () => nativeEvents.filter(event => event.type === 'response.create').length;
  const oldRequests = responseCount(); await page.locator('.composer textarea').fill('NATIVE MEDIA PRIOR'); await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await waitNative(() => responseCount() > oldRequests, 'Prior typed request must reach the provider'); assert.ok(emitNativeFixture);
  const emitMedia = (event: any) => emitNativeFixture!(event);
  const mediaCreated = (name: string) => ({ type: 'response.created', event_id: 'created-' + name, response: { id: name, status: 'in_progress' } });
  const mediaTranscript = (name: string, delta: string) => ({ type: 'response.output_audio_transcript.delta', event_id: 'transcript-' + name, response_id: name, item_id: 'assistant-' + name, content_index: 0, output_index: 0, delta });
  const mediaAudio = (name: string, samples: number) => ({ type: 'response.output_audio.delta', event_id: 'audio-' + name, response_id: name, item_id: 'assistant-' + name, content_index: 0, output_index: 0, delta: Buffer.from(new Int16Array(samples).buffer).toString('base64') });
  const mediaDone = (name: string, status: string) => ({ type: 'response.done', event_id: 'done-' + name, response: { id: name, status, output: [] } });
  emitMedia(mediaCreated('native-media-old')); emitMedia(mediaTranscript('native-media-old', 'Native prior partial.'));
  await page.getByText('Native prior partial.', { exact: true }).waitFor();
  const priorCancels = nativeEvents.filter(event => event.type === 'response.cancel').length, newRequests = responseCount();
  await page.locator('.composer textarea').fill('NATIVE MEDIA STEER'); await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await waitNative(() => responseCount() > newRequests && nativeEvents.filter(event => event.type === 'response.cancel').length > priorCancels, 'Real typed steering must cancel the old response');
  emitMedia(mediaAudio('native-media-old', 37)); emitMedia(mediaTranscript('native-media-old', 'STALE_NATIVE_TRANSCRIPT'));
  emitMedia(mediaCreated('native-media-new')); emitMedia(mediaAudio('native-media-new', 53)); emitMedia(mediaTranscript('native-media-new', 'Native fresh '));
  emitMedia(mediaDone('native-media-old', 'cancelled')); emitMedia(mediaDone('native-media-old', 'cancelled'));
  emitMedia(mediaTranscript('native-media-new', 'reply.')); emitMedia(mediaDone('native-media-new', 'completed'));
  await page.getByText('Native fresh reply.', { exact: true }).waitFor(); await page.waitForFunction(() => (globalThis as any).nativeMediaPlayback.fresh === 1);
  const nativeMediaPlayback = await page.evaluate(() => (globalThis as any).nativeMediaPlayback);
  assert.deepEqual(nativeMediaPlayback, { old: 0, fresh: 1 }, 'Only the current response may start an actual sidebar PCM buffer');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('STALE_NATIVE_TRANSCRIPT')), false);
  const mediaChat = (await rpc('state')).chats.find((chat: any) => chat.id === id);
  assert.equal(mediaChat.messages.some((message: any) => message.role === 'assistant' && message.text === 'Native prior partial.'), true);
  assert.equal(mediaChat.messages.some((message: any) => message.role === 'assistant' && message.text === 'Native fresh reply.'), true); assert.equal(mediaChat.mode, 'ask');
  console.log(JSON.stringify({ nativeTypedSteeringMedia: true, realSidebarPcmBuffersStarted: nativeMediaPlayback, staleTranscriptVisible: false, priorPartialAndNewReplySaved: true, askPreserved: true }));
  const oldPartialIndex = mediaChat.messages.findIndex((message: any) => message.role === 'assistant' && message.text === 'Native prior partial.');
  const newUserIndex = mediaChat.messages.findIndex((message: any) => message.role === 'user' && message.text === 'NATIVE MEDIA STEER');
  const freshReplyIndex = mediaChat.messages.findIndex((message: any) => message.role === 'assistant' && message.text === 'Native fresh reply.');
  const renderedMessages = await page.locator('.message').allTextContents();
  const renderedPriorIndex = renderedMessages.findIndex(message => message.includes('Native prior partial.'));
  const renderedSteerIndex = renderedMessages.findIndex(message => message.includes('NATIVE MEDIA STEER'));
  console.log(JSON.stringify({ actualSidebarTypedSteeringHistory: true, oldPartialIndex, newUserIndex, freshReplyIndex, renderedPriorIndex, renderedSteerIndex, privateNativeProvider: true, nativeWindowsMacosTested: false }));
  assert.ok(oldPartialIndex >= 0 && newUserIndex > oldPartialIndex && freshReplyIndex > newUserIndex, 'Actual saved native partial reply must precede the typed steering message');
  assert.ok(renderedPriorIndex >= 0 && renderedSteerIndex > renderedPriorIndex, 'Actual sidebar history must show the native partial reply before typed steering');

  await page.evaluate(() => (globalThis as any).restoreMediaPlayback()); holdNativeResponses = false; await rpc('update_chat', { chatId: id, mode: 'all' });
  await page.getByRole('button', { name: 'End voice', exact: true }).click(); await idle();
  for (const scenario of [
    { boundary: 'permission', action: 'cancel', denied: false },
    { boundary: 'permission', action: 'switch', denied: false },
    { boundary: 'permission', action: 'cancel', denied: true },
    { boundary: 'worklet', action: 'cancel', denied: false },
  ]) {
    console.log(`Checking voice ${scenario.action} during pending ${scenario.boundary}${scenario.denied ? ' denial' : ''}…`);
    await page.evaluate(scenario => {
      const state = window as any; const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const worklet = AudioWorklet.prototype.addModule;
      state.voiceRace = { original, worklet, stream: undefined, release: undefined };
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (scenario.denied) { await new Promise<void>(resolve => { state.voiceRace.release = resolve; }); throw new DOMException('Delayed permission denial', 'NotAllowedError'); }
        const stream = await original(constraints); state.voiceRace.stream = stream;
        if (scenario.boundary === 'permission') await new Promise<void>(resolve => { state.voiceRace.release = resolve; }); return stream;
      };
      if (scenario.boundary === 'worklet') AudioWorklet.prototype.addModule = async function(url, options) { await worklet.call(this, url, options); await new Promise<void>(resolve => { state.voiceRace.release = resolve; }); };
    }, scenario);
    await page.getByRole('button', { name: 'Start voice', exact: true }).click();
    await page.waitForFunction(() => !!(window as any).voiceRace.release);
    let replacementId: string | undefined;
    if (scenario.action === 'switch') {
      replacementId = (await rpc('new_chat')).id;
      await rpc('update_chat', { chatId: replacementId, provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'all' });
    } else await page.getByRole('button', { name: 'End voice', exact: true }).click();
    await idle();
    await page.locator('.composer textarea').fill('SEND IMAGE'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Voice connected · click the microphone to speak', { exact: true }).waitFor();
    await page.evaluate(() => { const state = (window as any).voiceRace; navigator.mediaDevices.getUserMedia = state.original; AudioWorklet.prototype.addModule = state.worklet; state.release(); });
    await page.waitForTimeout(300);
    const cancelledMicrophone = await page.evaluate(() => (window as any).voiceRace.stream?.getTracks().map((track: MediaStreamTrack) => track.readyState) || []);
    assert.deepEqual(cancelledMicrophone, scenario.denied ? [] : ['ended'], 'Cancelled microphone acquisition must release its tracks');
    assert.equal(await page.getByRole('button', { name: 'Finish speaking', exact: true }).count(), 0, 'Old setup must not record in the replacement session');
    assert.equal(await page.locator('.voice-status.error').count(), 0, 'Old permission failures must not cancel or report errors in the replacement session');
    await page.getByText('Voice connected · click the microphone to speak', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'End voice', exact: true }).click();
    if (replacementId) { await rpc('view_chat', { chatId: id }); await rpc('delete_chat', { chatId: replacementId }); }
    await idle();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByLabel('Spoken voice', { exact: true }).selectOption('cedar'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click(); await page.getByText('Automatic spoken reply.', { exact: true }).waitFor(); assert.ok(nativeEvents.some(e => e.type === 'session.update' && e.session.audio.input.turn_detection?.type === 'semantic_vad' && e.session.audio.output.voice === 'cedar')); assert.equal(await page.getByRole('button', { name: 'End voice chat', exact: true }).getAttribute('aria-pressed'), 'true'); await page.getByRole('button', { name: 'End voice chat', exact: true }).click(); await idle();
  // Losing the real sidebar port must immediately release an active microphone.
  await rpc('configure', { voiceMode: 'push-to-talk' });
  await worker.evaluate(`globalThis.captureNextSidebarPort = port => { if (port.name === 'autoum-ui') { globalThis.testSidebarPort = port; chrome.runtime.onConnect.removeListener(globalThis.captureNextSidebarPort); } }; chrome.runtime.onConnect.addListener(globalThis.captureNextSidebarPort);`);
  await page.reload(); await page.getByRole('button', { name: 'Start voice', exact: true }).waitFor();
  await page.evaluate(`const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async constraints => { const stream = await acquire(constraints); globalThis.disconnectMicrophone = stream; return stream; };`);
  await page.getByRole('button', { name: 'Start voice', exact: true }).click(); await page.getByRole('button', { name: 'Finish speaking', exact: true }).waitFor();
  await worker.evaluate('globalThis.testSidebarPort.disconnect()');
  await page.locator('.global-error').filter({ hasText: 'Sidebar connection lost. Choose Reconnect to continue.' }).waitFor();
  await page.waitForFunction(`globalThis.disconnectMicrophone.getTracks().every(track => track.readyState === 'ended')`);
  assert.equal(await page.getByRole('button', { name: 'Finish speaking', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  // The disconnected client cannot send voice_end; the existing host heartbeat expires it safely.
  await idle();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('checkbox', { name: 'Use bundled local voice fallback' }).uncheck(); await rpc('update_chat', { chatId: id, provider: 'opencode', accountId: 'default:opencode', model: 'fixture' }); await page.reload(); await page.getByRole('button', { name: 'Start voice', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Start voice', exact: true }).isDisabled(), true); assert.equal(await page.getByRole('button', { name: 'Start voice chat', exact: true }).isDisabled(), true);
  assert.deepEqual(modelDownloads, [], 'Fallback model assets must stay local'); assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/feature-sidebar.png' });
  const result = { ok: true, markdownAndLatex: true, safeMathAndHtml: true, pastedImagePreview: true, truncatedUploadRejected: true, changedAttachmentPreviewStops: true, attachmentDraftPersistence: true, imageSentToPi: true, imageDisplayedFromAI: true, skillsSettings: true, actualMcpSdk: true, mcpReconnectCancellation: true, nativeRealtimeSdk: true, earlyNativeTextRejectedWithoutMutation: true, nativeSettingsStartupCancellation: true, endVoiceCancelsSettingsStartup: true, nativeMicrophonePcm: true, nativeAudioPlayback: true, nativeTypedSteeringMedia: true, realSidebarPcmSchedulingChecked: true, nativeTranscriptHistoryOrder: true, nativeReplyIdentityIsolation: true, nativeBrowserTool: true, nativeAskDenial: true, nativeAutomaticTurns: true, waveformVoiceButton: true, localConversationTurns: true, localConversationCancellation: true, pendingMicrophoneCancellation: true, sidebarDisconnectReleasesMicrophone: true, localAssetsOnly: true, voiceStops: true, bundledWhisperAsr: !process.env.AUTOUM_SKIP_LOCAL_TEST, bundledKokoroTts: !process.env.AUTOUM_SKIP_LOCAL_TEST, fallbackSetting: true, liveNativeAccount: false };
  await writeFile('test-results/voice-e2e.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
} catch (e) { await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/feature-failure.png' }).catch(() => {}); console.error(await page.locator('.error').allTextContents()); throw e; }
finally { await context.close(); for (const client of wss.clients) client.terminate(); await new Promise<void>(yes => wss.close(() => yes())); tls.close(); provider.closeAllConnections(); provider.close(); await rm(directory, { recursive: true, force: true }); }
