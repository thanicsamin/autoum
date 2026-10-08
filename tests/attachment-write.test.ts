import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const mode of ['short', 'truncated', 'zero', 'error', 'cancel']) {
  test(`attachment upload handles ${mode} disk writes without accepting corrupt files`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autoum-attachment-write-'));
    try {
      const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', resolve('scripts/fixtures/attachment-writes.mjs'), mode, directory, resolve('.')], {
        timeout: 10000,
        env: { ...process.env, AUTOUM_DATA_DIR: join(directory, 'agent'), AUTOUM_ARTIFACTS_DIR: join(directory, 'artifacts'), AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' },
      });
      const receipt = JSON.parse(result.stdout); assert.equal(receipt.mode, mode); assert.equal(receipt.complete, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
