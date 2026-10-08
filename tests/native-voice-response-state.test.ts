import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native response receipt owns cancellation state across queued saves and stale events', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-response-state-')), agent = join(directory, 'agent'), id = 'native-media';
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
  const server = createServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) });
  const wss = new WebSocketServer({ server }), frames: any[] = [], emitted: any[] = []; let providerSocket: WebSocket | undefined;
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
  const done = (name: string, status = 'completed') => ({ type: 'response.done', event_id: 'done-' + name, response: { id: 'response-' + name, status, output: [] } });
  const savedChat = async () => JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).chats.find((chat: any) => chat.id === id);
  try {
    await mkdir(join(agent, 'pi'), { recursive: true }); await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'native-media-fixture' } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Private native media', provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, memoryEnabled: false, skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import('../host/agent.ts'); host = new AgentHost({ send: (packet: any) => emitted.push(packet) } as any); await host.init();
    await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' }); voice = host.current(id).voice;
    voice.begin(); voice.append(Buffer.alloc(4800).toString('base64')); voice.commit();
    await waitFor(() => frames.some(frame => frame.type === 'response.create'), 'Actual prior PCM commit must request its response');
    const save = host.save.bind(host); let saving = false;
    const gate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = save; };
    host.save = async () => { await save(); if (!saving) { saving = true; await gate; } };
    send({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'prior-user', item_id: 'prior-user', transcript: 'Saved prior user utterance' });
    await waitFor(() => saving, 'Real user history save must hold its return');
    let createdReceived = false; voice.socket.once('response.created', () => { createdReceived = true; }); send(created('queued-creation'));
    await waitFor(() => createdReceived, 'Actual SDK must receive response creation behind the history gate'); pending = voice.processing;
    const respondingAtReceipt = voice.responding, oldController = host.current(id).controller;
    const priorRequests = frames.filter(frame => frame.type === 'response.create').length;
    assert.deepEqual(await host.send(id, 'New typed during queued creation'), { steered: true }); const freshController = host.current(id).controller;
    await waitFor(() => frames.filter(frame => frame.type === 'response.create').length > priorRequests, 'New actual typed response request must reach the provider');
    const cancelled = frames.some(frame => frame.type === 'response.cancel');
    releaseSave!(); await pending; restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
    console.log(JSON.stringify({ actualSdkQueuedCreation: true, actualPriorPcmCommit: true, responseRequestsAtProvider: frames.filter(frame => frame.type === 'response.create').length, actualUserHistorySave: true, providerCreationReceived: createdReceived, respondingAtReceipt, clientResponseCancelSent: cancelled, respondingAfterOldCreationReleased: voice.responding, activityAfterOldCreationReleased: host.current(id).activity, savedPriorUserText: (await savedChat()).messages.some((message: any) => message.role === 'user' && message.text === 'Saved prior user utterance'), freshControllerPreserved: host.current(id).controller === freshController, freshControllerAborted: freshController.signal.aborted, askMode: host.record(id).mode }));
    assert.equal(respondingAtReceipt, true, 'A received active response must be cancellable before queued work finishes');
    assert.equal(cancelled, true, 'Typed steering must actually cancel that received response');
    assert.equal(voice.responding, false, 'Old queued creation cannot revive its responding state');
    assert.equal(oldController.signal.aborted, true); assert.equal(freshController.signal.aborted, false);
    await received(created('explicit-new-response')); assert.equal(voice.responding, true);
    const cancels = frames.filter(frame => frame.type === 'response.cancel').length;
    assert.deepEqual(await host.send(id, 'Explicit next typed turn'), { steered: true });
    await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancels, 'A new genuine response must remain cancellable');

    // Hold an actual completed user-history write, then receive completion
    // and the next response before releasing its queued event processing.
    await received(created('completion-before-new'));
    const completionSave = host.save.bind(host); let completionSaving = false;
    const completionGate = new Promise<void>(yes => { releaseSave = yes; });
    restoreSave = () => { host.save = completionSave; };
    host.save = async () => { await completionSave(); if (!completionSaving) { completionSaving = true; await completionGate; } };
    send({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'completion-user', item_id: 'completion-user', transcript: 'Saved completion boundary utterance' });
    await waitFor(() => completionSaving, 'Actual completed history write must hold its return');
    let doneReceived = false; voice.socket.once('response.done', () => { doneReceived = true; }); send(done('completion-before-new'));
    await waitFor(() => doneReceived, 'Completion must reach the SDK before releasing history');
    assert.equal(voice.responding, false, 'A genuinely completed response stops being cancellable at receipt');
    const cancelsAfterCompletion = frames.filter(frame => frame.type === 'response.cancel').length;
    const requestsAfterCompletion = frames.filter(frame => frame.type === 'response.create').length;
    assert.deepEqual(await host.send(id, 'New typed after received completion'), { steered: true });
    await waitFor(() => frames.filter(frame => frame.type === 'response.create').length > requestsAfterCompletion, 'New typed request must reach provider');
    assert.equal(frames.filter(frame => frame.type === 'response.cancel').length, cancelsAfterCompletion, 'Do not cancel an already completed response');
    let newCreationReceived = false; voice.socket.once('response.created', () => { newCreationReceived = true; }); send(created('active-after-old-done'));
    await waitFor(() => newCreationReceived, 'New creation must arrive behind old completion processing');
    assert.equal(voice.responding, true); pending = voice.processing;
    const activeController = host.current(id).controller;
    releaseSave!(); await pending; restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
    assert.equal(voice.responding, true, 'Queued old completion cannot clear the newly received active response');
    assert.equal(voice.respondingId, 'response-active-after-old-done');
    assert.equal(host.current(id).controller, activeController); assert.equal(activeController.signal.aborted, false);
    assert.equal(host.current(id).activity, 'Replying…');
    assert.ok((await savedChat()).messages.some((message: any) => message.text === 'Saved completion boundary utterance'));
    const nextCancels = frames.filter(frame => frame.type === 'response.cancel').length;
    await host.send(id, 'Cancel newer response after old completion processing');
    await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > nextCancels, 'The newer response remains actually cancellable');

    await received(created('same-epoch-active'));
    await received(created('completion-before-new'));
    assert.equal(voice.respondingId, 'response-same-epoch-active', 'Duplicate known creation cannot steal current active identity');
    await received(done('completion-before-new'));
    await received({ type: 'response.done', event_id: 'unknown-done', response: { id: 'unknown-response', status: 'completed', output: [] } });
    assert.equal(voice.responding, true, 'Old or unknown completion cannot clear current active response');
    assert.equal(voice.respondingId, 'response-same-epoch-active');
    await received(done('same-epoch-active'));
    assert.equal(voice.responding, false); assert.equal(voice.respondingId, undefined);
    await received(created('same-epoch-active'));
    assert.equal(voice.responding, false, 'Duplicate completed creation cannot revive response cancellation state');
    assert.equal(host.record(id).mode, 'ask');
    await voice.close(); assert.equal(voice.responding, false); assert.equal(voice.respondingId, undefined);
    console.log(JSON.stringify({ queuedOldCompletionPreservedNewActiveResponse: true, duplicateAndUnknownStateIgnored: true, currentCompletionSettledAtReceipt: true, realProviderCancellationVerified: true, realHistoryPreserved: true, askMode: host.record(id).mode }));

  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
