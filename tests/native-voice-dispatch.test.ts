import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native reply-save and queued-response cancellation preserve new work and explicit tool use', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-dispatch-')), agent = join(directory, 'agent'), id = 'native-dispatch';
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
  const server = createServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) });
  const wss = new WebSocketServer({ server }), frames: any[] = [], reads: string[] = []; let providerSocket: WebSocket | undefined;
  const sendProvider = (event: any) => { assert.ok(providerSocket, 'A private provider connection must be ready'); providerSocket.send(JSON.stringify(event)); };
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer native-dispatch-fixture'); providerSocket = socket;
    socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); frames.push(event); if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: event.session })); });
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  process.env.AUTOUM_REALTIME_TEST_URL = `wss://127.0.0.1:${(server.address() as any).port}/v1/realtime`;
  let host: any, releaseSave: (() => void) | undefined, restoreSave: (() => void) | undefined, pending: Promise<any> | undefined;
  const waitFor = async (predicate: () => boolean, message: string) => { const deadline = performance.now() + 2000; while (!predicate()) { assert.ok(performance.now() < deadline, message); await delay(10); } };
  try {
    await mkdir(join(agent, 'pi'), { recursive: true }); await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'native-dispatch-fixture' } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Private native dispatch', provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask', messages: [], requests: ['Read the private test file'], cwd: directory }], activeChatId: id, memoryEnabled: false, skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import('../host/agent.ts'); host = new AgentHost({ send: () => {} } as any); await host.init();
    const readPath = join(directory, 'read.txt'); await writeFile(readPath, 'private native dispatch fixture');
    const start = async () => {
      await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' });
      const voice = host.current(id).voice, tool = voice.tools.find((candidate: any) => candidate.name === 'read'); assert.ok(tool);
      const execute = tool.execute.bind(tool);
      tool.execute = async (...args: any[]) => { const result = await execute(...args); assert.ok(JSON.stringify(result).includes('private native dispatch fixture')); reads.push(args[0]); return result; };
      return voice;
    };
    const done = (callId: string) => ({ type: 'response.done', event_id: 'done-' + callId, response: { id: 'response-' + callId, status: 'completed', output: [{ type: 'function_call', call_id: callId, name: 'read', arguments: JSON.stringify({ path: readPath }) }] } });
    const created = (callId: string) => ({ type: 'response.created', event_id: 'created-' + callId, response: { id: 'response-' + callId, status: 'in_progress', output: [] } });
    const holdReplySave = async (voice: any, callId: string) => {
      sendProvider(created(callId));
      sendProvider({ type: 'response.output_text.delta', event_id: 'text-' + callId, response_id: 'response-' + callId, item_id: 'assistant-' + callId, output_index: 0, content_index: 0, delta: 'Private reply ' + callId });
      await waitFor(() => host.current(id).current === 'Private reply ' + callId, 'Actual text frame must reach the SDK'); await voice.processing;
      const save = host.save.bind(host); let saving = false; const gate = new Promise<void>(yes => { releaseSave = yes; });
      restoreSave = () => { host.save = save; };
      host.save = async () => { await save(); if (!saving) { saving = true; await gate; } };
      sendProvider(done(callId));
      await waitFor(() => saving, 'Actual completed reply save must reach its return gate'); pending = voice.processing;
    };
    const release = async () => { releaseSave!(); await pending; restoreSave!(); pending = undefined; releaseSave = undefined; restoreSave = undefined; };
    let voice = await start();
    await holdReplySave(voice, 'stopped-save'); await host.stop(id); voice = await start();
    const replacementController = host.current(id).controller;
    await release(); assert.deepEqual(reads, [], 'Stop cannot dispatch an old tool against a replacement');
    assert.equal(host.current(id).voice, voice); assert.equal(host.current(id).controller, replacementController); assert.equal(replacementController.signal.aborted, false);
    assert.equal(host.current(id).error, ''); assert.equal(host.record(id).mode, 'ask');
    await holdReplySave(voice, 'interrupted-save'); const oldController = host.current(id).controller;
    sendProvider({ type: 'input_audio_buffer.speech_started', event_id: 'new-speech', item_id: 'new-turn', audio_start_ms: 0 });
    await waitFor(() => host.current(id).controller !== oldController, 'Actual new speech must interrupt the old turn'); const speakingController = host.current(id).controller;
    assert.equal(oldController.signal.aborted, true);
    await release(); assert.deepEqual(reads, [], 'New speech cannot dispatch the old tool against its new controller');
    assert.equal(host.current(id).voice, voice); assert.equal(host.current(id).controller, speakingController); assert.equal(speakingController.signal.aborted, false);
    sendProvider(created('queued-old-turn')); await waitFor(() => host.current(id).activity === 'Replying…', 'The queued response must have a real originating creation'); await voice.processing;
    const saveBeforeQueuedEvent = host.save.bind(host); let savingTranscript = false;
    const transcriptGate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = saveBeforeQueuedEvent; };
    host.save = async () => { await saveBeforeQueuedEvent(); if (!savingTranscript) { savingTranscript = true; await transcriptGate; } };
    sendProvider({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'prior-transcript', item_id: 'prior-user', transcript: 'Saved prior user utterance' });
    await waitFor(() => savingTranscript, 'The actual user transcript save must hold the event queue');
    let queuedResponse = false; voice.socket.once('response.done', () => { queuedResponse = true; });
    sendProvider(done('queued-old-turn')); await waitFor(() => queuedResponse, 'The SDK must receive/queue response.done before interruption');
    pending = voice.processing; const queuedController = host.current(id).controller;
    sendProvider({ type: 'input_audio_buffer.speech_started', event_id: 'queued-new-speech', item_id: 'queued-new-user', audio_start_ms: 0 });
    await waitFor(() => host.current(id).controller !== queuedController, 'Actual new speech must interrupt the queued response'); const newestController = host.current(id).controller;
    await release(); assert.deepEqual(reads, [], 'A queued response cannot borrow a newer turn controller');
    assert.equal(host.current(id).controller, newestController); assert.equal(newestController.signal.aborted, false);
    assert.equal(host.record(id).messages.some((message: any) => message.role === 'user' && message.text === 'Saved prior user utterance'), true, 'The committed prior user transcription is retained');
    const nonCompletedStatuses: (string | undefined)[] = ['cancelled', 'incomplete', undefined];
    for (const status of nonCompletedStatuses) {
      const callId = 'status-' + (status || 'missing');
      sendProvider({ type: 'response.created', event_id: 'created-' + callId, response: { id: 'response-' + callId, status: 'in_progress', output: [] } });
      await waitFor(() => host.current(id).activity === 'Replying…', 'Actual SDK response.created must be processed'); await voice.processing;
      const oldController = host.current(id).controller, cancellations = frames.filter(frame => frame.type === 'response.cancel').length;
      sendProvider({ type: 'input_audio_buffer.speech_started', event_id: 'speech-' + callId, item_id: 'user-' + callId, audio_start_ms: 0 });
      await waitFor(() => host.current(id).controller !== oldController, 'Actual new speech must invalidate the previous response');
      await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancellations, 'Client cancellation must reach the private provider');
      const freshController = host.current(id).controller, freshActivity = host.current(id).activity; let receivedDone = false;
      voice.socket.once('response.done', () => { receivedDone = true; });
      const ended: any = done(callId); if (status) ended.response.status = status; else delete ended.response.status;
      sendProvider(ended); await waitFor(() => receivedDone, 'Actual SDK must receive the late provider response.done'); await voice.processing;
      assert.deepEqual(reads, [], 'Non-completed responses cannot dispatch retained output, even when delivered after interruption');
      assert.equal(frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === callId), false);
      assert.equal(host.current(id).controller, freshController); assert.equal(freshController.signal.aborted, false);
      assert.equal(host.current(id).activity, freshActivity); assert.equal(host.current(id).error, ''); assert.equal(host.record(id).mode, 'ask');
    }
    sendProvider(created('late-completed'));
    await waitFor(() => host.current(id).activity === 'Replying…', 'The old completed response must have been created'); await voice.processing;
    const typedController = host.current(id).controller, cancelCount = frames.filter(frame => frame.type === 'response.cancel').length;
    assert.deepEqual(await host.send(id, 'A new typed user turn'), { steered: true });
    const typedReplacement = host.current(id).controller;
    assert.notEqual(typedReplacement, typedController); assert.equal(typedController.signal.aborted, true);
    await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancelCount, 'Typed steering must send actual cancellation');
    sendProvider(created('late-completed')); // A duplicate creation cannot reassign the old response to this turn.
    let lateDone = false; voice.socket.once('response.done', () => { lateDone = true; });
    sendProvider(done('late-completed')); await waitFor(() => lateDone, 'The old completed response must reach the SDK'); await voice.processing;
    assert.deepEqual(reads, [], 'A delayed completed response cannot borrow the typed replacement controller');
    assert.equal(host.current(id).controller, typedReplacement); assert.equal(typedReplacement.signal.aborted, false);
    assert.equal(frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === 'late-completed'), false);
    sendProvider(created('explicit-new-turn'));
    sendProvider(done('explicit-new-turn'));
    await waitFor(() => reads.length === 1, 'A new uncancelled turn must still execute the actual SDK/file tool'); await voice.processing;
    await waitFor(() => frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === 'explicit-new-turn'), 'Successful tool output must reach the private provider');
    assert.deepEqual(reads, ['explicit-new-turn']);
    assert.equal(frames.some(frame => frame.type === 'conversation.item.create' && ['stopped-save', 'interrupted-save', 'queued-old-turn'].includes(frame.item.call_id)), false, 'Cancelled tool outputs are never sent');
    assert.equal(host.record(id).mode, 'ask'); assert.equal(host.current(id).error, '');
    sendProvider(created('failed-tool'));
    let failedReceived = false; voice.socket.once('response.done', () => { failedReceived = true; });
    const failed = done('failed-tool'); failed.response.status = 'failed'; sendProvider(failed);
    await waitFor(() => failedReceived, 'Actual provider failure must reach the SDK'); await voice.processing;
    assert.deepEqual(reads, ['explicit-new-turn']);
    assert.equal(frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === 'failed-tool'), false);
    assert.equal(host.current(id).error, 'The provider could not complete this voice turn. Check API access and quota.', 'Genuine provider failure remains visible');
    for (let index = 0; index < 260; index++) sendProvider(created('bounded-' + index));
    await waitFor(() => voice.responseEpochs.has('response-bounded-259'), 'All private response identities must reach the SDK'); await voice.processing;
    assert.equal(voice.responseEpochs.size, 256, 'Long sessions keep identity storage bounded');
    assert.equal(voice.responseEpochs.has('response-bounded-0'), false);
    for (const callId of ['bounded-0', 'unknown-completion', 'missing-id', 'oversized-id']) {
      const completion: any = done(callId);
      if (callId === 'missing-id') delete completion.response.id;
      if (callId === 'oversized-id') { const oversized = created(callId); oversized.response.id = 'x'.repeat(257); completion.response.id = oversized.response.id; sendProvider(oversized); }
      let received = false; voice.socket.once('response.done', () => { received = true; }); sendProvider(completion);
      await waitFor(() => received, 'Unknown/evicted completion must reach the actual SDK'); await voice.processing;
      assert.deepEqual(reads, ['explicit-new-turn']);
      assert.equal(frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === callId), false);
    }
    sendProvider(created('bounded-positive')); sendProvider(done('bounded-positive'));
    await waitFor(() => reads.length === 2, 'A recent valid response still executes after identity eviction'); await voice.processing;
    await waitFor(() => frames.some(frame => frame.type === 'conversation.item.create' && frame.item.call_id === 'bounded-positive'), 'Recent valid tool output reaches the private provider');
    assert.deepEqual(reads, ['explicit-new-turn', 'bounded-positive']);
    await host.stop(id); assert.equal(voice.responseEpochs.size, 0, 'Closing releases response identity storage');
    console.log(JSON.stringify({ actualProviderFramesAndFilesystem: true, oldReadsAfterStop: 0, oldReadsAfterNewSpeech: 0, oldReadsFromQueuedResponse: 0, oldReadsFromLateCompletedTypedSteering: 0, duplicateCreationKeepsOriginalEpoch: true, nonCompletedStatusesBlocked: ['cancelled', 'incomplete', 'missing', 'failed'], unknownEvictedAndMalformedIdsBlocked: true, boundedAndReleasedIdentityStorage: true, actualProviderCancelSent: true, savedPriorUserTextPreserved: true, explicitNewToolReads: reads.length, noCancelledToolOutput: true, genuineProviderFailureReported: true, askModePreserved: true }));
  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
