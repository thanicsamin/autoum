import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

// Real sidebar/media/SDK lifecycle with deterministic speech inference, no account network.
export async function checkLocalConversation(page: Page, providerRequests: any[]) {
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Speak replies automatically' }).check();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    const state = (globalThis as any).localConversation = { streams: [] as MediaStream[], requests: [] as any[], terminated: 0, analysers: 0, hold: '', transcript: 'Voice conversation fixture', worker: Worker, analyse: AnalyserNode.prototype.getFloatTimeDomainData, acquire: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) };
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await state.acquire(constraints); state.streams.push(stream); return stream; };
    const ticks = new WeakMap<AnalyserNode, number>();
    AnalyserNode.prototype.getFloatTimeDomainData = function(samples: Float32Array<ArrayBuffer>) {
      if (!ticks.has(this)) { ticks.set(this, 0); state.analysers++; }
      const tick = ticks.get(this)!; ticks.set(this, tick + 1);
      // One utterance, followed by silence. The second listening interval remains idle.
      samples.fill(state.analysers === 1 && tick < 8 ? .1 : 0);
    };
    (globalThis as any).Worker = class {
      onmessage: any; onerror: any; dead = false;
      constructor(url: string | URL, options: WorkerOptions) { if (!String(url).endsWith('/local-voice-worker.js')) return new state.worker(url, options) as any; }
      postMessage(data: any) {
        state.requests.push({ kind: data.kind, text: data.text });
        if (state.hold === data.kind) return;
        setTimeout(() => { if (!this.dead) this.onmessage?.({ data: data.kind === 'transcribe' ? { id: data.id, text: state.transcript } : { id: data.id, audio: new Float32Array(2400).fill(.01), sampleRate: 24000 } }); }, 30);
      }
      terminate() { this.dead = true; state.terminated++; }
    };
  });
  const button = page.getByRole('button', { name: 'Start voice chat', exact: true });
  assert.ok(await button.isEnabled(), 'Text models expose the enabled local voice chat button');
  assert.equal(await button.innerText(), ''); assert.equal(await button.locator('svg').count(), 1);
  const voiceBounds = (await button.boundingBox())!, sendBounds = (await page.getByRole('button', { name: 'Send', exact: true }).boundingBox())!;
  assert.ok(voiceBounds.x >= sendBounds.x + sendBounds.width, 'The waveform sits beside Send');
  await page.screenshot({ path: 'test-results/voice-chat-button.png' });
  for (const controls of [false, true]) {
    await page.getByRole('button', { name: controls ? 'Show model controls' : 'Hide model controls', exact: true }).click();
  for (const width of [320, 360, 420]) for (const font of [16, 24, 32]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(({ font, theme }) => { document.documentElement.style.fontSize = font + 'px'; document.documentElement.dataset.theme = theme; }, { font, theme });
    const box = (await button.boundingBox())!, send = (await page.getByRole('button', { name: 'Send', exact: true }).boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 950, 'Voice button fits narrow/large-font sidebar');
    assert.ok(box.x >= send.x + send.width && Math.abs(box.y - send.y) < 12, 'Voice and Send remain together');
    assert.ok(Math.abs(box.width - box.height) < 1, 'Waveform button is round');
    if (!controls && width === 360 && font === 16 && theme === 'dark') await page.locator('.composer').screenshot({ path: 'test-results/voice-chat-composer-dark.png' });
  }
  }
  await page.setViewportSize({ width: 420, height: 950 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; document.documentElement.dataset.theme = 'light'; });

  // End while the permission prompt is unresolved, then release the old acquisition.
  await page.evaluate(() => {
    const state = (globalThis as any).localConversation;
    navigator.mediaDevices.getUserMedia = async constraints => { await new Promise<void>(resolve => { state.release = resolve; }); const stream = await state.acquire(constraints); state.streams.push(stream); return stream; };
  });
  await button.click();
  const end = page.getByRole('button', { name: 'End voice chat', exact: true });
  await page.waitForFunction(() => !!(globalThis as any).localConversation.release);
  assert.equal(await end.getAttribute('aria-pressed'), 'true'); await end.click();
  await page.evaluate(() => { const state = (globalThis as any).localConversation; state.release(); navigator.mediaDevices.getUserMedia = async constraints => { const stream = await state.acquire(constraints); state.streams.push(stream); return stream; }; });
  await page.waitForFunction(() => { const streams = (globalThis as any).localConversation.streams; return streams.length === 1 && streams[0].getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended'); });
  assert.equal(await page.locator('.voice-status.error').count(), 0);

  const before = providerRequests.length;
  await button.click(); await page.getByText('Listening · speak naturally · local fallback', { exact: true }).waitFor();
  assert.ok(await page.locator('button.microphone').isDisabled());
  await page.waitForFunction(() => (globalThis as any).localConversation.requests.some((r: any) => r.kind === 'synthesize'));
  await page.waitForFunction(() => (globalThis as any).localConversation.analysers >= 2);
  await page.getByText('Listening · speak naturally · local fallback', { exact: true }).waitFor();
  assert.ok(providerRequests.length > before && providerRequests.slice(before).some(r => JSON.stringify(r.messages).includes('Voice conversation fixture')), 'Speech goes to the selected provider through the real SDK');
  await end.click(); await button.waitFor();
  await page.waitForFunction(() => (globalThis as any).localConversation.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
  const turnCount = await page.evaluate(() => (globalThis as any).localConversation.requests.length);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => (globalThis as any).localConversation.requests.length), turnCount, 'Ending never resumes listening or speech');

  // Cancelling in-flight recognition must terminate its worker and not send a turn.
  await page.evaluate(() => { const state = (globalThis as any).localConversation; state.analysers = 0; state.hold = 'transcribe'; });
  await button.click();
  await page.waitForFunction(count => (globalThis as any).localConversation.requests.length > count, turnCount);
  const beforeCancelled = providerRequests.length, terminated = await page.evaluate(() => (globalThis as any).localConversation.terminated);
  await end.click(); await button.waitFor();
  assert.ok(await page.locator('button.microphone').isEnabled());
  assert.equal(await page.evaluate(() => (globalThis as any).localConversation.terminated), terminated + 1);
  assert.equal(providerRequests.length, beforeCancelled);
  assert.equal(await page.locator('.voice-status.error').count(), 0);
  await page.waitForFunction(() => (globalThis as any).localConversation.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
  // End while a selected-provider research/model reply is still streaming.
  await page.evaluate(() => { const state = (globalThis as any).localConversation; state.analysers = 0; state.hold = ''; state.transcript = 'Hold voice conversation fixture'; });
  await button.click(); await page.locator('.voice-status').getByText('Thinking…', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).waitFor();
  await end.click(); await button.waitFor();
  await page.waitForFunction(() => !document.querySelector('button.stop'));
  assert.equal(await page.locator('.voice-status.error').count(), 0);
  await page.waitForFunction(() => (globalThis as any).localConversation.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));

  // End while local speech output is loading: no later playback or listening.
  await page.evaluate(() => { const state = (globalThis as any).localConversation; state.analysers = 0; state.hold = 'synthesize'; state.transcript = 'Voice conversation fixture'; state.requests = []; });
  await button.click(); await page.waitForFunction(() => (globalThis as any).localConversation.requests.some((r: any) => r.kind === 'synthesize'));
  const outputTerminated = await page.evaluate(() => (globalThis as any).localConversation.terminated);
  await end.click(); await button.waitFor();
  assert.equal(await page.evaluate(() => (globalThis as any).localConversation.terminated), outputTerminated + 1);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.voice-status.error').count(), 0); assert.equal(await page.getByRole('button', { name: 'Stop speaking', exact: true }).count(), 0);
  await page.waitForFunction(() => (globalThis as any).localConversation.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
  // Changing the fallback voice while listening releases the current microphone.
  await page.evaluate(() => { (globalThis as any).localConversation.analysers = 100; });
  await button.click(); await page.getByText('Listening · speak naturally · local fallback', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Fallback voice', { exact: true }).selectOption('af_bella');
  await page.waitForFunction(() => (globalThis as any).localConversation.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')));
  await page.getByLabel('Fallback voice', { exact: true }).selectOption('af_heart');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await button.waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Speak replies automatically' }).uncheck();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}
