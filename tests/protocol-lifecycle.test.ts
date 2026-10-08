import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeTransport } from '../host/protocol.ts';

test('a failed native request releases its abort listener, timer and pending record', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new NativeTransport(input, output);
  t.after(() => { transport.cancel(); input.destroy(); output.destroy(); });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const controller = new AbortController();
  await assert.rejects(transport.request('test', 'x'.repeat(1000000), controller.signal), /too large/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(Reflect.get(transport, 'pending').size, 0);
  assert.equal(clear.mock.callCount(), 1);
  controller.abort();
  assert.equal(output.readableLength, 0, 'No cancellation is sent for a failed request');
});

test('cancellation settles even if notifying the browser throws', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new NativeTransport(input, output);
  t.after(() => { transport.cancel(); input.destroy(); output.destroy(); });
  const controller = new AbortController();
  const request = transport.request('approval', {}, controller.signal);
  const rejection = assert.rejects(request, /Cancelled/);
  t.mock.method(transport, 'send', () => { throw Error('Disconnected output'); });
  controller.abort(); await rejection;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(Reflect.get(transport, 'pending').size, 0);
});

test('already cancelled native requests do not start a timer or write a packet', async t => {
  const output = new PassThrough(), transport = new NativeTransport(new PassThrough(), output);
  const timer = t.mock.method(globalThis, 'setTimeout');
  await assert.rejects(transport.request('approval', {}, AbortSignal.abort()), /Cancelled/);
  assert.equal(timer.mock.callCount(), 0); assert.equal(output.readableLength, 0);
});

test('reply, timeout and connection close release each request exactly once', async t => {
  const input = new PassThrough(), output = new PassThrough(), transport = new NativeTransport(input, output);
  t.after(() => { transport.cancel(); input.destroy(); output.destroy(); });
  for (const outcome of ['reply', 'timeout', 'close']) {
    const controller = new AbortController();
    const request = transport.request('approval', {}, controller.signal, 5);
    const body = JSON.parse(output.read().subarray(4).toString());
    if (outcome === 'reply') {
      const bytes = Buffer.from(JSON.stringify({ reply: body.id, data: true }));
      const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
      input.write(Buffer.concat([header, bytes])); assert.equal(await request, true);
    } else {
      const rejection = assert.rejects(request, outcome === 'close' ? /Connection closed/ : /did not respond/);
      if (outcome === 'close') transport.cancel();
      await rejection;
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(Reflect.get(transport, 'pending').size, 0);
    controller.abort(); assert.equal(output.readableLength, 0, 'Settled requests never send a late cancellation');
  }
});
