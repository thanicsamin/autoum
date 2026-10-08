import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native media respects originating turns across delivery and history queues', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-media-')), agent = join(directory, 'agent'), id = 'native-media';
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
  const server = createServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) });
  const wss = new WebSocketServer({ server }), frames: any[] = [], emitted: any[] = [], observations: any[] = []; let providerSocket: WebSocket | undefined;
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer native-media-fixture'); providerSocket = socket;
    socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); frames.push(event); if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session })); });
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  process.env.AUTOUM_REALTIME_TEST_URL = `wss://127.0.0.1:${(server.address() as any).port}/v1/realtime`;
  let host: any, voice: any, releaseSave: (() => void) | undefined, restoreSave: (() => void) | undefined, pending: Promise<any> | undefined;
  const waitFor = async (predicate: () => boolean, message: string) => { const deadline = performance.now() + 2500; while (!predicate()) { assert.ok(performance.now() < deadline, message); await delay(10); } };
  const send = (event: any) => { assert.ok(providerSocket); providerSocket.send(JSON.stringify(event)); };
  const received = async (event: any) => { let received = false; voice.socket.once(event.type, () => { received = true; }); send(event); await waitFor(() => received, 'Actual SDK must receive ' + event.type); await voice.processing; };
  const created = (name: string) => ({ type: 'response.created', event_id: 'created-' + name, response: { id: 'response-' + name, status: 'in_progress' } });
  const text = (name: string, delta: string, type = 'response.output_audio_transcript.delta') => ({ type, event_id: 'text-' + name + '-' + delta.length, response_id: 'response-' + name, item_id: 'assistant-' + name, output_index: 0, content_index: 0, delta });
  const audio = (name: string) => ({ type: 'response.output_audio.delta', event_id: 'audio-' + name, response_id: 'response-' + name, item_id: 'assistant-' + name, output_index: 0, content_index: 0, delta: Buffer.from(new Int16Array(16).buffer).toString('base64') });
  const done = (name: string, status = 'completed') => ({ type: 'response.done', event_id: 'done-' + name, response: { id: 'response-' + name, status, output: [] } });
  const savedChat = async () => JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).chats.find((chat: any) => chat.id === id);
  try {
    await mkdir(join(agent, 'pi'), { recursive: true }); await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'native-media-fixture' } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Private native media', provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, memoryEnabled: false, skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import('../host/agent.ts'); host = new AgentHost({ send: (packet: any) => emitted.push(packet) } as any); await host.init();
    await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' }); voice = host.current(id).voice;
    for (const scenario of ['late-transcript', 'late-text', 'queued-transcript', 'queued-text']) {
      const type = scenario.endsWith('text') ? 'response.output_text.delta' : 'response.output_audio_transcript.delta', prior = 'Private partial ' + scenario, stale = 'STALE ' + scenario, fresh = 'Private new ' + scenario;
      await received(created(scenario)); await received(text(scenario, prior, type)); assert.equal(host.current(id).current, prior);
      if (scenario.startsWith('queued')) {
        const save = host.save.bind(host); let saving = false; const gate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = save; };
        host.save = async () => { await save(); if (!saving) { saving = true; await gate; } };
        send({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'user-' + scenario, item_id: 'user-' + scenario, transcript: 'Saved user ' + scenario });
        await waitFor(() => saving, 'Real prior user history save must hold its return');
        let queued = false; voice.socket.once(type, () => { queued = true; }); send(text(scenario, stale, type));
        await waitFor(() => queued, 'Actual SDK must queue the old text before steering'); pending = voice.processing;
      }
      const cutoff = emitted.length, controller = host.current(id).controller, cancellations = frames.filter(frame => frame.type === 'response.cancel').length;
      assert.deepEqual(await host.send(id, 'New typed ' + scenario), { steered: true }); const replacement = host.current(id).controller;
      await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancellations, 'Actual typed cancellation must reach the private provider');
      // Audio is immediate; it cannot await the intentionally held text queue.
      let gotAudio = false; voice.socket.once('response.output_audio.delta', () => { gotAudio = true; }); send(audio(scenario));
      await waitFor(() => gotAudio, 'Actual SDK must receive the late audio');
      if (pending) { releaseSave!(); await pending; restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined; }
      else await received(text(scenario, stale, type));
      const late = emitted.slice(cutoff), packets = late.filter(packet => packet.type === 'voice_event' && packet.data.kind === 'audio'), deltas = late.filter(packet => packet.type === 'delta' && packet.data.text === stale);
      assert.equal(packets.length, 0); assert.equal(deltas.length, 0); assert.equal(host.current(id).current, prior);
      assert.equal(host.current(id).controller, replacement); assert.equal(replacement.signal.aborted, false); assert.equal(controller.signal.aborted, true); assert.equal(host.record(id).mode, 'ask');
      await received(done(scenario, 'cancelled'));
      assert.equal((await savedChat()).messages.some((message: any) => message.role === 'assistant' && message.text === prior), true, 'Valid pre-interruption partial text is saved');
      if (scenario.startsWith('queued')) assert.equal((await savedChat()).messages.some((message: any) => message.role === 'user' && message.text === 'Saved user ' + scenario), true);
      await received(created(scenario + '-new')); await received(audio(scenario + '-new')); await received(text(scenario + '-new', fresh, type)); await received(done(scenario + '-new'));
      assert.equal(emitted.slice(cutoff).filter(packet => packet.type === 'voice_event' && packet.data.kind === 'audio').length, 1, 'Current audio still reaches the sidebar');
      assert.equal(emitted.slice(cutoff).some(packet => packet.type === 'delta' && packet.data.text === fresh), true);
      assert.equal((await savedChat()).messages.some((message: any) => message.role === 'assistant' && message.text === fresh), true);
      observations.push({ scenario, oldAudioPackets: 0, oldAudioIpcBytes: 0, oldTextDeltas: 0, priorPartialSaved: true, currentMediaAndHistoryWork: true, freshControllerAborted: false });
    }
    for (let index = 0; index < 260; index++) send(created('bounded-media-' + index));
    await waitFor(() => voice.responseEpochs.has('response-bounded-media-259'), 'Real SDK identity eviction must complete'); await voice.processing;
    const invalidCutoff = emitted.length;
    for (const name of ['bounded-media-0', 'unknown-media', 'missing-id', 'oversized-id']) {
      const oldAudio: any = audio(name), oldText: any = text(name, 'INVALID ' + name);
      if (name === 'missing-id') { delete oldAudio.response_id; delete oldText.response_id; }
      if (name === 'oversized-id') { const oversized = created(name); oversized.response.id = 'x'.repeat(257); oldAudio.response_id = oversized.response.id; oldText.response_id = oversized.response.id; await received(oversized); }
      await received(oldAudio); await received(oldText);
    }
    assert.equal(emitted.slice(invalidCutoff).some(packet => packet.type === 'delta' || packet.type === 'voice_event' && packet.data.kind === 'audio'), false);
    assert.equal(host.current(id).current, '');
    await received(created('recent-media')); await received(audio('recent-media')); await received(text('recent-media', 'Recent valid media')); await received(done('recent-media'));
    assert.equal(emitted.slice(invalidCutoff).filter(packet => packet.type === 'voice_event' && packet.data.kind === 'audio').length, 1);
    assert.equal((await savedChat()).messages.some((message: any) => message.role === 'assistant' && message.text === 'Recent valid media'), true);
    assert.equal(host.current(id).error, ''); assert.equal(host.record(id).title, 'Private native media'); assert.equal(host.record(id).mode, 'ask');
    console.log(JSON.stringify({ actualSdkHistoryAndIpc: true, observations, unknownEvictedMalformedMediaDropped: true, recentMediaAfterEvictionWorks: true, originalTitleAndAskPreserved: true, realUiPlaybackMeasured: false }));
  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
