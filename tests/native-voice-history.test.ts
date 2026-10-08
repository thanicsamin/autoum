import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native interrupted transcripts preserve conversation order through completion and close', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-history-order-')), agent = join(directory, 'agent'), id = 'native-media';
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
    await waitFor(() => frames.some(frame => frame.type === 'response.create'), 'Actual PCM commit requests the old response');
    await received(created('partial-old'));
    await received({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'first-user', item_id: 'first-user', transcript: 'First spoken question' });
    const delta = (name: string, value: string) => ({ type: 'response.output_audio_transcript.delta', event_id: 'text-' + name, response_id: 'response-' + name, item_id: 'assistant-' + name, output_index: 0, content_index: 0, delta: value });
    await received(delta('partial-old', 'Prior audible partial reply.'));
    const cancellations = frames.filter(frame => frame.type === 'response.cancel').length;
    assert.deepEqual(await host.send(id, 'Next typed question'), { steered: true });
    await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancellations, 'Actual typed steering cancels the old response');
    // Canonical ordered wire sequence: cancelled completion before next creation.
    await received(done('partial-old', 'cancelled'));
    await received(created('next'));
    await received(delta('next', 'Fresh answer to the next question.'));
    await received(done('next'));
    const actual = (await savedChat()).messages.map((message: any) => ({ role: message.role, text: message.text }));
    console.log(JSON.stringify({ actualPcmAndSdk: true, actualTypedProviderCancellation: true, cancelledCompletionBeforeNextCreation: true, savedHistory: actual, askMode: host.record(id).mode }));
    assert.deepEqual(actual, [
      { role: 'user', text: 'First spoken question' },
      { role: 'assistant', text: 'Prior audible partial reply.' },
      { role: 'user', text: 'Next typed question' },
      { role: 'assistant', text: 'Fresh answer to the next question.' },
    ], 'Saved chat must retain the causal order of interrupted native turns');
    assert.equal(host.current(id).error, ''); assert.equal(host.record(id).mode, 'ask');

    await received({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'late-first-user', item_id: 'late-first-user', transcript: 'Question before delayed first reply' });
    await received(created('late-first'));
    const lateSave = host.save.bind(host); let lateSaving = false;
    const lateGate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = lateSave; };
    host.save = async () => { await lateSave(); if (!lateSaving) { lateSaving = true; await lateGate; } };
    pending = host.send(id, 'Next typed while first reply has not arrived');
    await waitFor(() => lateSaving, 'Next typed history save must hold its return before first reply text');
    await received(delta('late-first', 'First partial received during next typed save.'));
    releaseSave!(); assert.deepEqual(await pending, { steered: true }); restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
    await received(done('late-first', 'cancelled'));
    assert.deepEqual((await savedChat()).messages.slice(-3).map((message: any) => ({ role: message.role, text: message.text })), [
      { role: 'user', text: 'Question before delayed first reply' },
      { role: 'assistant', text: 'First partial received during next typed save.' },
      { role: 'user', text: 'Next typed while first reply has not arrived' },
    ], 'First reply text during the next saved user return retains the preceding conversation position');
    console.log(JSON.stringify({ actualDelayedFirstTranscript: true, precedingAnchorPreservedDuringNextUserSave: true, askMode: host.record(id).mode }));

    await received({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'close-user', item_id: 'close-user', transcript: 'Spoken question before closing' });
    await received(created('close-partial')); await received(delta('close-partial', 'Partial reply before closing.'));
    const save = host.save.bind(host); let saving = false;
    const gate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = save; };
    host.save = async () => { await save(); if (!saving) { saving = true; await gate; } };
    pending = host.send(id, 'Committed typed message cancelled during save');
    await waitFor(() => saving, 'Actual typed save must complete and hold its return');
    const inputsBeforeClose = frames.filter(frame => frame.type === 'conversation.item.create' && frame.item.role === 'user').length;
    await host.stop(id);
    const atClose = (await savedChat()).messages.slice(-3).map((message: any) => ({ role: message.role, text: message.text }));
    assert.deepEqual(atClose, [
      { role: 'user', text: 'Spoken question before closing' },
      { role: 'assistant', text: 'Partial reply before closing.' },
      { role: 'user', text: 'Committed typed message cancelled during save' },
    ], 'Closing during a real saved typed-send return preserves causal order and committed input');
    await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' });
    const replacement = host.current(id).voice, freshController = host.current(id).controller;
    releaseSave!(); assert.deepEqual(await pending, { cancelled: true }); restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
    assert.equal(frames.filter(frame => frame.type === 'conversation.item.create' && frame.item.role === 'user').length, inputsBeforeClose, 'The cancelled saved send cannot dispatch on the replacement');
    assert.equal(host.current(id).voice, replacement); assert.equal(host.current(id).controller, freshController); assert.equal(freshController.signal.aborted, false);
    voice = replacement;
    const afterReplacement = (await savedChat()).messages.slice(-3).map((message: any) => ({ role: message.role, text: message.text }));
    assert.deepEqual(afterReplacement, atClose); assert.equal(host.record(id).mode, 'ask');
    console.log(JSON.stringify({ actualSavedCloseBoundary: true, partialAndCommittedUserOrderPreserved: true, noCancelledInputSent: true, replacementControllerPreserved: true, askMode: host.record(id).mode }));

  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
