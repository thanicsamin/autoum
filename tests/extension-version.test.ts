import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionWorkerIdentity } from '../scripts/extension-version.mjs';

test('worker updates change their URL and increase the Chromium manifest version while unchanged rebuilds remain stable', () => {
  const initial = extensionWorkerIdentity(Buffer.from('first'), { version: '0.1.0' });
  assert.equal(initial.extensionVersion, '0.1.0.1');
  const saved = { version: '0.1.0', ...initial };
  assert.deepEqual(extensionWorkerIdentity(Buffer.from('first'), saved), initial);
  const update = extensionWorkerIdentity(Buffer.from('second'), saved);
  assert.equal(update.extensionVersion, '0.1.0.2'); assert.notEqual(update.extensionWorker, initial.extensionWorker);
  assert.equal(extensionWorkerIdentity(Buffer.from('second'), { version: '0.1.0', ...update }, '0.2.0').extensionVersion, '0.2.0.1');
});
test('worker versions reject corrupt saved counters and stop before exceeding Chromium version limits', () => {
  for (const workerRevision of [-1, 1.5, 65536, '2']) assert.throws(() => extensionWorkerIdentity(Buffer.from('script'), { version: '0.1.0', workerRevision }), /revision/i);
  assert.throws(() => extensionWorkerIdentity(Buffer.from('script'), { version: '0.1.0', workerRevision: 65535 }), /exhausted/i);
});
