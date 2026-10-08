import { createHash } from 'node:crypto';

export function extensionWorkerIdentity(bytes, previous = {}, version = '0.1.0') {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.split('.').some(n => Number(n) > 65535)) throw Error('Choose a valid three-part browser version.');
  const extensionWorker = 'background-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.js';
  const oldRevision = previous.version === version ? previous.workerRevision ?? 0 : 0;
  if (!Number.isInteger(oldRevision) || oldRevision < 0 || oldRevision > 65535) throw Error('Invalid saved extension worker revision.');
  const workerRevision = previous.extensionWorker === extensionWorker && oldRevision > 0 ? oldRevision : oldRevision + 1;
  if (workerRevision > 65535) throw Error('Extension revision exhausted; increase the browser version.');
  return { extensionWorker, workerRevision, extensionVersion: version + '.' + workerRevision };
}
