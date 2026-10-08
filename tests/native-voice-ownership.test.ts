import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native reply ownership isolates foreign completions and cancelled handoffs', { timeout: 30000 }, async () => {
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
    const delta = (name: string, value: string, type = 'response.output_audio_transcript.delta') => ({ type, event_id: crypto.randomUUID(), response_id: 'response-' + name, item_id: 'assistant-' + name, output_index: 0, content_index: 0, delta: value });
    const observations: any[] = [];
    for (const scenario of ['duplicate-transcript', 'duplicate-text', 'overlap-transcript', 'overlap-text']) {
      const type = scenario.endsWith('text') ? 'response.output_text.delta' : 'response.output_audio_transcript.delta', old = scenario + '-old', fresh = scenario + '-fresh';
      voice.begin(); voice.append(Buffer.alloc(4800).toString('base64')); voice.commit();
      await received({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'user-' + scenario, item_id: 'user-' + scenario, transcript: 'Spoken question ' + scenario });
      await received(created(old)); await received(delta(old, 'Old partial ' + scenario, type));
      const cancellations = frames.filter(frame => frame.type === 'response.cancel').length;
      await host.send(id, 'Next typed ' + scenario);
      await waitFor(() => frames.filter(frame => frame.type === 'response.cancel').length > cancellations, 'Actual typed cancellation must reach the provider');
      const replacement = host.current(id).controller;
      if (scenario.startsWith('duplicate')) await received(done(old, 'cancelled'));
      await received(created(fresh)); const cutoff = emitted.length;
      await received(delta(fresh, 'Fresh first half ', type));
      assert.equal(host.current(id).current, 'Fresh first half ', 'New response must not append to the old interrupted partial');
      await received(done(old, 'cancelled'));
      assert.equal(host.current(id).current, 'Fresh first half ', 'Foreign completion must not finalize newer text');
      await received(delta(fresh, 'and final half.', type)); await received(done(fresh));
      const actual = (await savedChat()).messages.slice(-4).map((message: any) => ({ role: message.role, text: message.text }));
      assert.deepEqual(actual, [
        { role: 'user', text: 'Spoken question ' + scenario },
        { role: 'assistant', text: 'Old partial ' + scenario },
        { role: 'user', text: 'Next typed ' + scenario },
        { role: 'assistant', text: 'Fresh first half and final half.' },
      ]);
      if (scenario.startsWith('overlap')) {
        const packets = emitted.slice(cutoff), clear = packets.findIndex(packet => packet.type === 'state' && packet.data.chats.some((chat: any) => chat.id === id && chat.current === '' && chat.messages.some((message: any) => message.text === 'Old partial ' + scenario))), first = packets.findIndex(packet => packet.type === 'delta' && packet.data.text === 'Fresh first half ');
        assert.ok(clear >= 0 && first > clear, 'Actual native state clears the old live reply before emitting new text');
      }
      assert.equal(host.current(id).controller, replacement); assert.equal(replacement.signal.aborted, false); assert.equal(host.record(id).mode, 'ask');
      observations.push({ scenario, realProviderCancellation: true, distinctSavedReplies: true, newerBufferPreserved: true, askMode: host.record(id).mode });
    }
    const readPath = join(directory, 'read-fixture.txt'); await writeFile(readPath, 'Private completed-response read.');
    const readTool = voice.tools.find((item: any) => item.name === 'read'), execute = readTool.execute.bind(readTool); const reads: string[] = [];
    readTool.execute = async (...args: any[]) => { const result = await execute(...args); assert.ok(JSON.stringify(result).includes('Private completed-response read.')); reads.push(args[0]); return result; };
    const beforeToolCommit = frames.filter(frame => frame.type === 'response.create').length;
    voice.begin(); voice.append(Buffer.alloc(4800).toString('base64')); voice.commit();
    await waitFor(() => frames.filter(frame => frame.type === 'response.create').length > beforeToolCommit, 'Actual tool-turn PCM request must reach provider');
    const priorRequests = frames.filter(frame => frame.type === 'response.create').length;
    await received(created('completed-tools'));
    await received(delta('completed-tools', 'Prior completed tool reply.'));
    const completedTools = (extra = false) => {
      const event: any = done('completed-tools');
      event.response.output = [{ type: 'function_call', call_id: 'original-read', name: 'read', arguments: JSON.stringify({ path: readPath }) }];
      if (extra) event.response.output.push({ type: 'function_call', call_id: 'added-read', name: 'read', arguments: JSON.stringify({ path: readPath }) });
      return event;
    };
    await received(completedTools());
    await waitFor(() => frames.filter(frame => frame.type === 'response.create').length > priorRequests, 'A genuine actual Pi read output requests its follow-up');
    const expectedRequests = frames.filter(frame => frame.type === 'response.create').length;
    await received(created('tool-follow-up')); await received(delta('tool-follow-up', 'Follow-up partial '));
    const activity = host.current(id).activity, lateCutoff = emitted.length;
    await received(completedTools()); await received(completedTools(true));
    await received({ type: 'response.output_audio.delta', event_id: 'late-completed-audio', response_id: 'response-completed-tools', item_id: 'completed-tools', output_index: 0, content_index: 0, delta: Buffer.from(new Int16Array(8).buffer).toString('base64') });
    await received(delta('completed-tools', 'LATE COMPLETED TEXT'));
    await delay(20);
    assert.equal(frames.filter(frame => frame.type === 'response.create').length, expectedRequests, 'Completed tool replay cannot request extra model turns');
    assert.deepEqual(reads, ['original-read'], 'Amended terminal output cannot execute added calls');
    assert.equal(host.current(id).current, 'Follow-up partial '); assert.equal(host.current(id).activity, activity);
    assert.equal(emitted.slice(lateCutoff).some(packet => packet.type === 'delta' || packet.type === 'voice_event' && packet.data.kind === 'audio'), false, 'Completed response media cannot steal the current buffer or audio channel');
    await received(delta('tool-follow-up', 'completed.')); await received(done('tool-follow-up'));
    assert.equal((await savedChat()).messages.at(-1).text, 'Follow-up partial completed.');

    // Terminal receipt must preserve media already received before completion.
    await received(created('queued-valid'));
    const queuedSave = host.save.bind(host); let queuedSaving = false;
    const queuedGate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = queuedSave; };
    host.save = async () => { await queuedSave(); if (!queuedSaving) { queuedSaving = true; await queuedGate; } };
    send({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'queued-user', item_id: 'queued-user', transcript: 'Saved queued user' });
    await waitFor(() => queuedSaving, 'Actual saved user return must hold the event processing queue');
    let gotText = false; voice.socket.once('response.output_audio_transcript.delta', () => { gotText = true; }); send(delta('queued-valid', 'Valid text received before completion.'));
    await waitFor(() => gotText, 'SDK receives valid queued text before done');
    let gotDone = false; voice.socket.once('response.done', () => { gotDone = true; }); send(done('queued-valid'));
    await waitFor(() => gotDone, 'SDK receives completion while text still awaits the saved user return'); pending = voice.processing;
    assert.equal(voice.completedResponses.has('response-queued-valid'), true);
    releaseSave!(); await pending; restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
    assert.equal((await savedChat()).messages.at(-1).text, 'Valid text received before completion.', 'Terminal marker cannot drop previously received valid queued media');

    for (let index = 0; index < 260; index++) await received(created('evicted-' + index));
    assert.ok(voice.completedResponses.size <= voice.responseEpochs.size); assert.equal(voice.completedResponses.has('response-completed-tools'), false);
    await received(created('current-valid')); await received(delta('current-valid', 'Current partial '));
    for (const ended of [done('evicted-0'), done('unknown'), { type: 'response.done', event_id: 'missing-id', response: { status: 'completed', output: [] } }, { type: 'response.done', event_id: 'oversized-id', response: { id: 'x'.repeat(257), status: 'completed', output: [] } }]) {
      await received(ended); assert.equal(host.current(id).current, 'Current partial ', 'Unknown/evicted/malformed completions cannot flush current text');
    }
    await received(delta('current-valid', 'completed.')); await received(done('current-valid'));
    assert.equal((await savedChat()).messages.at(-1).text, 'Current partial completed.');

    for (const cancellation of ['stop', 'speech']) {
      await received({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'handoff-user-' + cancellation, item_id: 'handoff-user-' + cancellation, transcript: 'Question before cancelled handoff ' + cancellation });
      await received(created('handoff-old-' + cancellation)); await received(delta('handoff-old-' + cancellation, 'Valid old handoff partial ' + cancellation));
      await host.send(id, 'Next typed handoff question ' + cancellation); await received(created('handoff-new-' + cancellation));
      const save = host.save.bind(host); let saving = false;
      const gate = new Promise<void>(yes => { releaseSave = yes; }); restoreSave = () => { host.save = save; };
      host.save = async () => { await save(); if (!saving) { saving = true; await gate; } };
      let gotNew = false; voice.socket.once('response.output_audio_transcript.delta', () => { gotNew = true; }); const cutoff = emitted.length;
      send(delta('handoff-new-' + cancellation, 'DISCARDED NEW HANDOFF TEXT ' + cancellation));
      await waitFor(() => gotNew && saving, 'Actual new SDK text must wait for its real old-partial save return'); pending = voice.processing;
      if (cancellation === 'stop') {
        await host.stop(id);
        await host.handle('voice_start', { chatId: id, startupId: crypto.randomUUID(), voice: 'marin', mode: 'push' });
      } else {
        const before = host.current(id).controller;
        send({ type: 'input_audio_buffer.speech_started', event_id: 'handoff-new-speech', item_id: 'handoff-new-speech', audio_start_ms: 0 });
        await waitFor(() => host.current(id).controller !== before, 'Actual new speech must invalidate the pending handoff');
      }
      const replacement = host.current(id).voice, controller = host.current(id).controller;
      releaseSave!(); await pending; restoreSave!(); releaseSave = undefined; restoreSave = undefined; pending = undefined;
      assert.equal(emitted.slice(cutoff).some(packet => packet.type === 'delta' && packet.data.text === 'DISCARDED NEW HANDOFF TEXT ' + cancellation), false);
      const tail = (await savedChat()).messages.slice(-3).map((message: any) => ({ role: message.role, text: message.text }));
      assert.deepEqual(tail, [{ role: 'user', text: 'Question before cancelled handoff ' + cancellation }, { role: 'assistant', text: 'Valid old handoff partial ' + cancellation }, { role: 'user', text: 'Next typed handoff question ' + cancellation }]);
      assert.equal(host.current(id).voice, replacement); assert.equal(host.current(id).controller, controller); assert.equal(controller.signal.aborted, false); assert.equal(host.current(id).error, '');
      assert.equal(voice.replyResponseId, undefined); voice = replacement;
    }
    await host.send(id, 'Explicit retry after cancelled handoff');
    await waitFor(() => frames.some(frame => frame.type === 'conversation.item.create' && frame.item.content?.some((part: any) => part.text === 'Explicit retry after cancelled handoff')), 'Explicit actual retry reaches the provider');
    await received(created('close-valid')); await received(delta('close-valid', 'Valid current close partial.')); await voice.close();
    assert.equal((await savedChat()).messages.at(-1).text, 'Valid current close partial.'); assert.equal(voice.replyResponseId, undefined); assert.equal(voice.completedResponses.size, 0);
    console.log(JSON.stringify({ actualSdkPcmAndFilesystem: true, observations, unknownEvictedMalformedDonePreservesBuffer: true, completedToolReplayNoExtraRequests: true, amendedToolOutputNotExecuted: true, completedMediaIgnored: true, queuedPreCompletionTextPreserved: true, boundedTerminalIdsAndCloseCleanup: true, stopAndSpeechDuringRealHandoffSaveDropNewDelta: true, committedOldPartialAndTypedInputPreserved: true, closePreservesCurrentPartial: true, askMode: host.record(id).mode, realPaidProvider: false }));

  } finally {
    releaseSave?.(); restoreSave?.(); await pending; await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes())); await rm(directory, { recursive: true, force: true });
  }
});
