import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native typed sends cancel across history saves without stale errors or interrupting replacement work', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-send-')), agent = join(directory, 'agent'), id = 'native-send';
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
  const server = createServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) });
  const wss = new WebSocketServer({ server }), frames: any[] = [], observations: any[] = []; let providerSocket: WebSocket | undefined;
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer native-send-fixture'); providerSocket = socket;
    socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); frames.push(event); if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session })); });
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  process.env.AUTOUM_REALTIME_TEST_URL = `wss://127.0.0.1:${(server.address() as any).port}/v1/realtime`;
  let host: any, releaseSave: (() => void) | undefined, restoreSave: (() => void) | undefined, pending: Promise<any> | undefined;
  const waitFor = async (predicate: () => boolean, message: string) => { const deadline = performance.now() + 2000; while (!predicate()) { assert.ok(performance.now() < deadline, message); await delay(10); } };
  const inputSent = (text: string) => frames.some(frame => frame.type === 'conversation.item.create' && frame.item.content?.some((part: any) => part.type === 'input_text' && part.text === text));
  try {
    await mkdir(join(agent, 'pi'), { recursive: true }); await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'native-send-fixture' } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'New conversation', provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, memoryEnabled: false, skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import('../host/agent.ts'); host = new AgentHost({ send: () => {} } as any); await host.init();
    const start = async () => { await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' }); return host.current(id).voice; };
    await start();
    const firstText = '  Private\n typed\t stop ' + 'x'.repeat(80), expectedTitle = firstText.trim().replace(/\s+/g, ' ').slice(0, 60);
    for (const scenario of ['stop', 'speech', 'stop-error', 'speech-error', 'unstopped-error']) {
      const text = scenario === 'stop' ? firstText : 'Private typed ' + scenario, humanText = text.trim(), save = host.save.bind(host), failure = Error('Private save-return failure fixture'); let saving = false;
      const gate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = save; };
      // Real persistence completes; only its return/error is delayed. The error
      // is deliberately injected, not an asserted OS/filesystem failure.
      host.save = async () => { await save(); if (!saving) { saving = true; await gate; if (scenario.endsWith('error')) throw failure; } };
      const result = host.send(id, text).then((value: any) => ({ value }), (error: any) => ({ error })); pending = result;
      await waitFor(() => saving, 'Actual typed history write must reach its return gate');
      let voice = host.current(id).voice;
      if (scenario.startsWith('stop')) { await host.stop(id); voice = await start(); }
      else if (scenario.startsWith('speech')) {
        assert.ok(providerSocket); const controller = host.current(id).controller;
        providerSocket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', event_id: scenario, item_id: scenario, audio_start_ms: 0 }));
        await waitFor(() => host.current(id).controller !== controller, 'Real speech frame must invalidate the typed send');
      }
      const freshController = host.current(id).controller;
      releaseSave!(); const settled = await result; restoreSave(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
      if (scenario === 'unstopped-error') { assert.equal(settled.error, failure, 'A genuine unstopped save-return error remains an error'); assert.equal(settled.value, undefined); }
      else { assert.deepEqual(settled.value, { cancelled: true }); assert.equal(settled.error, undefined); }
      assert.equal(inputSent(humanText), false); assert.equal(host.current(id).voice, voice); assert.equal(host.current(id).controller, freshController);
      assert.equal(freshController.signal.aborted, false); assert.equal(host.current(id).error, ''); assert.equal(host.record(id).mode, 'ask');
      const disk = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
      const saved = disk.chats.find((chat: any) => chat.id === id);
      assert.equal(saved.messages.some((message: any) => message.role === 'user' && message.text === humanText), true, 'Already committed input is retained');
      assert.equal(host.record(id).title, expectedTitle); assert.equal(saved.title, expectedTitle, 'Normalized first title is saved and not replaced by later sends');
      observations.push({ scenario, intentionalCancellation: settled.value?.cancelled === true, errorReported: settled.error === failure, inputSent: inputSent(humanText), freshControllerAborted: freshController.signal.aborted });
    }
    host.record(id).title = 'My chosen voice chat';
    assert.deepEqual(await host.send(id, 'Explicit typed retry'), { steered: true });
    await waitFor(() => inputSent('Explicit typed retry'), 'Only the explicit retry may reach the private provider');
    assert.equal(frames.filter(frame => frame.type === 'conversation.item.create' && frame.item.role === 'user').length, 1, 'No earlier cancelled/error input is sent later');
    assert.equal(host.record(id).title, 'My chosen voice chat');
    assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).chats.find((chat: any) => chat.id === id).title, 'My chosen voice chat');
    console.log(JSON.stringify({ actualSdkAndHistorySave: true, injectedReturnErrors: true, observations, explicitRetryWorks: true, committedInputPreserved: true, askModePreserved: true, defaultTitleNormalizedAndPersisted: true, customTitlePreserved: true }));
  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
