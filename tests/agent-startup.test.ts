import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Stop releases text and voice during gated MCP startup without a late provider request, and retry works', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-startup-'));
  const agent = join(directory, 'agent'), pidsFile = join(directory, 'pids'), gate = join(directory, 'ready');
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts'); process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_MODEL_NETWORK = '1';
  const packets: any[] = []; let requests = 0;
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests++;
    assert.equal(request.headers['x-opencode-session'], 'startup');
    assert.equal(request.headers['user-agent'], 'autoum-browser/0.1.0');
    assert.ok(input.tools.some((tool: any) => tool.function.name.startsWith('mcp_gated_greet')));
    response.setHeader('Content-Type', 'text/event-stream');
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Retry ready.' }, finish_reason: null }] };
    response.end('data: ' + JSON.stringify(chunk) + '\n\ndata: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 5000) => {
    const until = performance.now() + timeout;
    while (!await condition()) { if (performance.now() >= until) throw Error('Startup fixture timed out.'); await delay(10); }
  };
  const pids = async () => (await readFile(pidsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let host: any, releaseAuth: (() => void) | undefined, authStartup: Promise<any> | undefined;
  try {
    await mkdir(join(agent, 'pi'), { recursive: true });
    await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'local-fixture' } }));
    await writeFile(join(agent, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`, models: [{ id: 'fixture', name: 'Fixture', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id: 'startup', title: 'Startup fixture', provider: 'opencode', model: 'fixture', thinking: 'off', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: 'startup', skillPaths: [], extensionPaths: [] }));
    await writeFile(join(agent, 'mcp.json'), JSON.stringify([
      { name: 'gated', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: pidsFile, AUTOUM_MCP_FIXTURE_GATE: gate } },
      { name: 'following', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: pidsFile } },
    ]));
    const { AgentHost } = await import('../host/agent.ts');
    host = new AgentHost({ send: (packet: any) => packets.push(packet) } as any); await host.init();
    await host.send('startup', 'Cancelled research');
    await waitFor(async () => (await pids()).length === 1);
    const cancelledPid = (await pids())[0];
    await host.send('startup', 'Queued steering must be cleared');
    const started = performance.now(); await host.stop('startup');
    await waitFor(() => !host.current('startup').busy, 500);
    console.log(JSON.stringify({ stopToIdleMs: +(performance.now() - started).toFixed(2), providerRequestsAfterStop: requests }));
    assert.equal(requests, 0); assert.equal(host.current('startup').error, '');
    assert.equal(host.current('startup').session, undefined);
    assert.equal(host.current('startup').steering.length, 0);
    assert.equal((await pids()).length, 1, 'cancellation does not continue starting the remaining servers');
    await writeFile(gate, '');
    // Retry before the first helper's shutdown completes: old cleanup must not
    // clear a replacement manager, create a late session or run queued input.
    await host.send('startup', 'Retry'); await waitFor(() => !host.current('startup').busy);
    assert.equal(host.current('startup').error, ''); assert.equal(requests, 1);
    assert.equal(host.record('startup').messages.at(-1).text, 'Retry ready.');
    await waitFor(() => !alive(cancelledPid));
    assert.equal((await pids()).length, 3);
    assert.equal(packets.filter(packet => packet.type === 'notice').length, 0, 'intentional cancellation is not an unavailable-server warning');

    // Native audio shares discovery, but Stop closes its voice object and clears
    // Live.controller. The discovery must retain the original cancelled signal.
    await rm(gate);
    await host.handle('configure', { mcpServers: [{ name: 'gated', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: pidsFile, AUTOUM_MCP_FIXTURE_GATE: gate } }] });
    const account = await host.handle('login', { provider: 'openai', method: 'api_key', key: 'native-fixture', label: 'Private voice fixture' });
    await host.handle('update_chat', { chatId: 'startup', provider: 'openai', accountId: account.accountId, model: 'gpt-realtime-2.1' });
    const voice = host.handle('voice_start', { chatId: 'startup', voice: 'marin', mode: 'push' }).then(() => ({ error: undefined }), (error: any) => ({ error }));
    await waitFor(async () => (await pids()).length === 4);
    const pendingVoice = host.current('startup').voice, voiceController = host.current('startup').controller;
    const messagesBeforeEarlyText = structuredClone(host.record('startup').messages), requestsBeforeEarlyText = [...host.record('startup').requests];
    let earlyTextError: any;
    try { await host.send('startup', 'Typed before voice is connected'); } catch (error) { earlyTextError = error; }
    console.log(JSON.stringify({ earlyTextError: earlyTextError?.name, earlyTextMessagesAdded: host.record('startup').messages.length - messagesBeforeEarlyText.length, earlyTextRequestsAdded: host.record('startup').requests.length - requestsBeforeEarlyText.length, voiceDiscoveryAbortedByEarlyText: voiceController.signal.aborted }));
    assert.match(earlyTextError?.message || '', /Wait for native voice to connect/i);
    assert.deepEqual(host.record('startup').messages, messagesBeforeEarlyText, 'Rejected early native text must not be saved as an unsent user message');
    assert.deepEqual(host.record('startup').requests, requestsBeforeEarlyText);
    assert.equal(host.current('startup').voice, pendingVoice); assert.equal(host.current('startup').controller, voiceController);
    assert.equal(voiceController.signal.aborted, false, 'Early text cannot abort the in-progress voice discovery');
    assert.equal(host.current('startup').busy, true);
    await host.stop('startup');
    const result = await Promise.race([voice, delay(500).then(() => { throw Error('Voice startup did not cancel promptly.'); })]);
    assert.equal(result.error?.name, 'AbortError');
    assert.equal(host.current('startup').busy, false); assert.equal(host.current('startup').voice, undefined);
    assert.equal(requests, 1);
    assert.equal(packets.some(packet => packet.type === 'voice_event' && packet.data.kind === 'ready'), false);
    // Cancellation may arrive while credential resolution is still pending,
    // before tool discovery has captured a signal. Keep its original identity.
    const runtime = host.runtimeFor('startup'), getAuth = runtime.getAuth.bind(runtime);
    let resolvingAuth = false;
    const authGate = new Promise<void>(yes => { releaseAuth = yes; });
    runtime.getAuth = async (provider: string) => { const auth = await getAuth(provider); resolvingAuth = true; await authGate; return auth; };
    authStartup = host.handle('voice_start', { chatId: 'startup', startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' }).then((value: any) => ({ value }), (error: any) => ({ error }));
    await waitFor(() => resolvingAuth);
    const childrenBeforeAuthStop = (await pids()).length;
    await host.stop('startup'); releaseAuth!();
    const authResult = await Promise.race([authStartup, delay(500).then(() => ({ pending: true }))]);
    console.log(JSON.stringify({ cancelledAuthStartupStillPending: !!authResult.pending, helpersStartedAfterAuthStop: (await pids()).length - childrenBeforeAuthStop, cancelledAuthStartupError: authResult.error?.name }));
    assert.equal((await pids()).length, childrenBeforeAuthStop, 'Stopped credential resolution cannot start tool helpers afterwards');
    assert.equal(authResult.pending, undefined); assert.equal(authResult.error?.name, 'AbortError');
    assert.equal(host.current('startup').busy, false); assert.equal(host.current('startup').voice, undefined); assert.equal(requests, 1);
    await host.close(); await waitFor(async () => (await pids()).every(pid => !alive(pid)));
  } finally {
    releaseAuth?.(); await writeFile(gate, ''); await host?.close(); await authStartup;
    // Only this fixture's recorded children may be removed after a failed assertion.
    for (const pid of await pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
