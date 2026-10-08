import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voicePreferences } from '../extension/voice.ts';
import { NativeVoice, voiceCapability } from '../host/voice.ts';
test('native voice preferences migrate old local voices and retain useful choices', () => {
  assert.deepEqual(voicePreferences(undefined), { speakReplies: true, voice: 'marin', mode: 'push', fallbackEnabled: true, fallbackVoice: 'af_heart' });
  assert.deepEqual(voicePreferences({ voice: 'kokoro:af_heart', rate: 1 }), { speakReplies: true, voice: 'marin', mode: 'push', fallbackEnabled: true, fallbackVoice: 'af_heart' });
  assert.deepEqual(voicePreferences({ voice: 'cedar', speakReplies: false, mode: 'conversation', fallbackEnabled: true, fallbackVoice: 'af_heart' }), { speakReplies: false, voice: 'cedar', mode: 'conversation', fallbackEnabled: true, fallbackVoice: 'af_heart' });
});
test('native voice requires a supported selected model and a configured API account', () => {
  const api = { configured: true, method: 'api_key' };
  for (const model of ['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini', 'gpt-realtime-2025-08-28']) assert.equal(voiceCapability('openai', model, api).supported, true);
  for (const provider of ['anthropic', 'antigravity', 'openai-codex', 'opencode', 'openrouter']) assert.equal(voiceCapability(provider, 'gpt-realtime-2.1', api).supported, false);
  assert.equal(voiceCapability('openai', 'gpt-6-sol', api).supported, false);
  assert.equal(voiceCapability('openai', 'gpt-realtime-2.1', { configured: true, method: 'oauth' }).supported, false);
  assert.equal(voiceCapability('openai', 'gpt-realtime-2.1', { configured: false, method: 'api_key' }).supported, false);
});
test('typed calls retained after voice closure cannot interrupt a replacement controller', async () => {
  const packets: any[] = [];
  const live: any = { controller: new AbortController(), epoch: 0, busy: true, current: '', activity: '' };
  const host: any = { current: () => live, save: async () => {}, state() {}, transport: { send: (packet: any) => packets.push(packet) } };
  const voice = new NativeVoice(host, 'private-voice'); live.voice = voice;
  const initialEpoch = live.epoch;
  assert.throws(() => voice.text('Before connecting'), /Wait for native voice to connect/);
  assert.equal(live.epoch, initialEpoch); assert.equal(live.controller.signal.aborted, false); assert.equal(packets.length, 0);
  await voice.close();
  const replacement = new AbortController(); live.controller = replacement;
  const closedEpoch = live.epoch, packetCount = packets.length;
  assert.throws(() => voice.text('Delayed typed input from the old session'), /Voice conversation ended/);
  assert.equal(replacement.signal.aborted, false); assert.equal(live.controller, replacement);
  assert.equal(live.epoch, closedEpoch); assert.equal(packets.length, packetCount);
});
