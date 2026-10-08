import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Native settings cancellation, delayed image Stop and explicit retry preserve connection lifetimes', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-native-startup-')), agent = join(directory, 'agent');
  process.env.AUTOUM_DATA_DIR = agent; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
  process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.crt'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'pipe' });
  const server = createServer({ key: await readFile(join(directory, 'tls.key')), cert: await readFile(join(directory, 'tls.crt')) });
  const wss = new WebSocketServer({ server }); let handshakes = 0;
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer native-fixture');
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'session.update') {
        handshakes++;
        // First connection remains open while waiting for model settings. Only
        // the separate replacement may be acknowledged and become ready.
        if (handshakes > 1) socket.send(JSON.stringify({ type: 'session.updated', session: event.session }));
      }
    });
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  process.env.AUTOUM_REALTIME_TEST_URL = `wss://127.0.0.1:${(server.address() as any).port}/v1/realtime`;
  const oldStartupId = crypto.randomUUID(), replacementStartupId = crypto.randomUUID();
  const packets: any[] = []; let host: any, pending: Promise<any> | undefined;
  try {
    await mkdir(join(agent, 'pi'), { recursive: true });
    await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'native-fixture' } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id: 'native-startup', title: 'Private native fixture', provider: 'openai', accountId: 'default:openai', model: 'gpt-realtime-2.1', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: 'native-startup', memoryEnabled: false, skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import('../host/agent.ts');
    host = new AgentHost({ send: (packet: any) => packets.push(packet) } as any); await host.init();
    pending = host.handle('voice_start', { chatId: 'native-startup', startupId: oldStartupId, voice: 'marin', mode: 'push' }).then((value: any) => ({ value }), (error: any) => ({ error }));
    const deadline = performance.now() + 5000;
    while (!handshakes) { assert.ok(performance.now() < deadline, 'Native SDK must send its settings'); await delay(10); }
    const oldVoice = host.current('native-startup').voice, oldController = host.current('native-startup').controller;
    const stopAt = performance.now(); await host.stop('native-startup');
    assert.equal(oldController.signal.aborted, true); assert.equal(host.current('native-startup').busy, false);
    const replacement = await host.handle('voice_start', { chatId: 'native-startup', startupId: replacementStartupId, voice: 'cedar', mode: 'push' });
    const replacementVoice = host.current('native-startup').voice, replacementController = host.current('native-startup').controller;
    assert.notEqual(replacement.voiceId, oldVoice.id);
    const result = await Promise.race([pending, delay(500).then(() => ({ pending: true }))]);
    console.log(JSON.stringify({ nativeSettingsStopToSettlementMs: +(performance.now() - stopAt).toFixed(2), startupStillPending: !!result.pending, startupError: result.error?.name, replacementReady: replacement.voiceId === replacementVoice.id }));
    assert.equal(result.pending, undefined, 'Stopped native handshake must settle promptly instead of retaining its 15-second timer');
    assert.equal(result.error?.name, 'AbortError');
    await host.handle('voice_cancel_start', { chatId: 'native-startup', startupId: oldStartupId });
    await host.handle('voice_cancel_start', { chatId: 'native-startup', startupId: oldStartupId });
    await assert.rejects(host.handle('voice_cancel_start', { chatId: 'native-startup', startupId: '' }), /Invalid voice startup identity/);
    assert.equal(!!oldVoice.socket._hasListener('session.updated'), false, 'Cancelled settings acknowledgement listener must be removed');
    assert.equal(getEventListeners(oldController.signal, 'abort').length, 0, 'Cancelled startup must release its signal listeners');
    assert.equal(host.current('native-startup').voice, replacementVoice); assert.equal(host.current('native-startup').controller, replacementController);
    assert.equal(replacementController.signal.aborted, false); assert.equal(host.current('native-startup').busy, true); assert.equal(host.current('native-startup').error, '');
    assert.equal(packets.some(packet => packet.type === 'voice_event' && packet.data.voiceId === oldVoice.id && packet.data.kind === 'ready'), false);
    // Fault-inject a late transport callback through the real SDK's WebSocket.
    // This tests a retained callback, not a demonstrated network delivery race.
    oldVoice.socket.socket.emit('error', Error('Private late transport callback fixture'));
    assert.equal(host.current('native-startup').error, '', 'A closed connection cannot report failure against its replacement');
    assert.equal(host.current('native-startup').voice, replacementVoice);
    assert.equal(host.current('native-startup').controller, replacementController);
    assert.equal(replacementController.signal.aborted, false);
    const packetCountBeforeLateAudio = packets.length, audioDelta = Buffer.alloc(512).toString('base64');
    const emitAudio = (voice: any) => voice.socket.socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', event_id: 'private-audio', response_id: 'private-response', item_id: 'private-item', content_index: 0, delta: audioDelta })));
    const emitSpeech = (voice: any) => voice.socket.socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started', event_id: 'private-speech', item_id: 'private-item', audio_start_ms: 0 })));
    emitAudio(oldVoice); emitSpeech(oldVoice);
    const stalePackets = packets.slice(packetCountBeforeLateAudio).filter(packet => packet.type === 'voice_event' && packet.data.voiceId === oldVoice.id);
    console.log(JSON.stringify({ injectedLateCallbacks: true, staleVoicePackets: stalePackets.length, staleVoicePacketBytes: stalePackets.reduce((total, packet) => total + Buffer.byteLength(JSON.stringify(packet)), 0), replacementControllerAborted: replacementController.signal.aborted }));
    assert.equal(stalePackets.length, 0, 'A closed session cannot emit stale audio or interrupt packets');
    assert.equal(replacementController.signal.aborted, false, 'Late speech cannot interrupt the replacement');
    assert.equal(host.current('native-startup').controller, replacementController);
    replacementVoice.socket.socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', event_id: 'private-created', response: { id: 'private-response', status: 'in_progress' } })));
    emitAudio(replacementVoice);
    assert.equal(packets.at(-1)?.data.kind, 'audio'); assert.equal(packets.at(-1)?.data.audio, audioDelta);
    assert.equal(packets.at(-1)?.data.voiceId, replacementVoice.id, 'Active native audio still reaches the sidebar');
    const image = await readFile(join(process.cwd(), 'dist/extension/icons/16.png'));
    const upload = await host.handle('attachment_start', { chatId: 'native-startup', name: 'private-race.png', mimeType: 'image/png', size: image.length });
    await host.handle('attachment_chunk', { chatId: 'native-startup', id: upload.id, offset: 0, data: image.toString('base64') });
    const attachment = await host.handle('attachment_finish', { chatId: 'native-startup', id: upload.id });
    const originalContext = host.attachments.context.bind(host.attachments);
    let releaseContext: (() => void) | undefined, preparing = false;
    const contextGate = new Promise<void>(yes => { releaseContext = yes; });
    host.attachments.context = async (...args: any[]) => { const value = await originalContext(...args); preparing = true; await contextGate; return value; };
    const messagesBefore = host.record('native-startup').messages.length, requestsBefore = host.record('native-startup').requests.length, handshakesBefore = handshakes;
    const send = host.send('native-startup', 'Stopped attached native input', [attachment.id]).then((value: any) => ({ value }), (error: any) => ({ error }));
    const attachmentDeadline = performance.now() + 5000;
    while (!preparing) { assert.ok(performance.now() < attachmentDeadline, 'Actual attachment context must reach its gate'); await delay(10); }
    await host.stop('native-startup'); assert.equal(host.current('native-startup').busy, false);
    releaseContext!(); const sendResult = await send;
    const observation = { nativeSessionsOpenedAfterStop: handshakes - handshakesBefore, messagesAddedAfterStop: host.record('native-startup').messages.length - messagesBefore, requestsAddedAfterStop: host.record('native-startup').requests.length - requestsBefore, hostBusyAfterStoppedRead: host.current('native-startup').busy, stoppedSendError: sendResult.error?.name, stoppedSendCancelled: sendResult.value?.cancelled === true };
    console.log(JSON.stringify(observation));
    assert.equal(observation.nativeSessionsOpenedAfterStop, 0, 'Releasing an attachment read after Stop must not start another native session');
    assert.equal(observation.messagesAddedAfterStop, 0); assert.equal(observation.requestsAddedAfterStop, 0);
    assert.equal(observation.hostBusyAfterStoppedRead, false); assert.deepEqual(sendResult.value, { cancelled: true });
    host.attachments.context = originalContext;
    assert.deepEqual(await host.send('native-startup', 'Explicit retry of the same image', [attachment.id]), { steered: true });
    assert.equal(handshakes, handshakesBefore + 1, 'Only an explicit retry may open a new native session');
    assert.equal(host.record('native-startup').messages.length, messagesBefore + 1);
    assert.equal(host.record('native-startup').messages.at(-1).text, 'Explicit retry of the same image');
    assert.equal(host.record('native-startup').messages.at(-1).attachments[0].id, attachment.id);
    const activeVoice = host.current('native-startup').voice, speakingController = host.current('native-startup').controller;
    emitSpeech(activeVoice);
    assert.equal(packets.at(-1)?.data.kind, 'interrupt'); assert.equal(packets.at(-1)?.data.voiceId, activeVoice.id);
    assert.equal(speakingController.signal.aborted, true, 'Active speech still interrupts its own work');
    assert.equal(host.current('native-startup').voice, activeVoice);
    assert.notEqual(host.current('native-startup').controller, speakingController);
    const activeController = host.current('native-startup').controller;
    assert.equal(activeController.signal.aborted, false);
    activeVoice.socket.socket.emit('error', Error('Private active transport failure fixture'));
    assert.match(host.current('native-startup').error, /Native voice connection failed/);
    assert.equal(activeController.signal.aborted, true);
    assert.equal(host.current('native-startup').busy, false);
    assert.equal(host.current('native-startup').voice, undefined, 'A live transport error still ends its own session');
    const errorCloseDeadline = performance.now() + 1000;
    while (!packets.some(packet => packet.type === 'voice_event' && packet.data.voiceId === activeVoice.id && packet.data.kind === 'closed')) {
      assert.ok(performance.now() < errorCloseDeadline, 'Active transport cleanup must publish the closed event'); await delay(10);
    }
  } finally {
    await host?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(yes => wss.close(() => yes())); await new Promise<void>(yes => server.close(() => yes()));
    await pending; await rm(directory, { recursive: true, force: true });
  }
});
