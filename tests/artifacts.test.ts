import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

test('artifact startup creates a user folder, upgrades the old denied default and preserves explicit destinations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-artifacts-'));
  const fixture = join(directory, 'fixture.mjs');
  await writeFile(fixture, `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    import * as os from 'node:os';
    import { join, resolve } from 'node:path';
    const folder = ${JSON.stringify(directory)}, legacy = resolve('/autoum/artifacts');
    mock.module('node:os', { namedExports: { ...os, homedir: () => join(folder, 'home') } });
    mock.module('node:fs/promises', { namedExports: { ...fs, mkdir: async (path, options) => {
      if (path === legacy) throw Object.assign(Error('Denied legacy folder'), { code: 'EACCES' });
      return fs.mkdir(path, options);
    } } });
    const artifacts = await import(${JSON.stringify(pathToFileURL(resolve('host/artifacts.ts')).href)});
    const expected = join(folder, 'home', 'autoum', 'artifacts');
    assert.equal(await artifacts.initializeArtifacts(), false);
    assert.equal(artifacts.artifactsDir, expected);
    assert.ok((await fs.stat(expected)).isDirectory());
    if (process.platform !== 'win32') assert.equal((await fs.stat(expected)).mode & 0o777, 0o700);
    assert.equal(await artifacts.initializeArtifacts(legacy), true);
    assert.equal(artifacts.artifactsDir, expected);
    const custom = join(folder, 'custom');
    assert.equal(await artifacts.initializeArtifacts(custom), false);
    assert.equal(artifacts.artifactsDir, custom);
    const blocked = join(folder, 'file-not-folder'); await fs.writeFile(blocked, 'Keep me');
    await assert.rejects(artifacts.initializeArtifacts(blocked), /not writable/);
    assert.equal(artifacts.artifactsDir, blocked);
    assert.equal(await fs.readFile(blocked, 'utf8'), 'Keep me');
    process.env.AUTOUM_ARTIFACTS_DIR = legacy;
    await assert.rejects(artifacts.initializeArtifacts(), /not writable/);
    assert.equal(artifacts.artifactsDir, legacy);
    delete process.env.AUTOUM_ARTIFACTS_DIR;
    await fs.mkdir(process.env.AUTOUM_DATA_DIR, { recursive: true });
    await fs.writeFile(join(process.env.AUTOUM_DATA_DIR, 'settings.json'), JSON.stringify({ artifactsDir: legacy, chats: [], skillPaths: [], extensionPaths: [] }));
    const { AgentHost } = await import(${JSON.stringify(pathToFileURL(resolve('host/agent.ts')).href)});
    const host = new AgentHost({ send() {} }); await host.init();
    try {
      assert.equal(host.state().artifactError, '');
      assert.equal(host.state().artifactsDir, expected);
      assert.equal(JSON.parse(await fs.readFile(join(process.env.AUTOUM_DATA_DIR, 'settings.json'), 'utf8')).artifactsDir, expected);
    } finally { await host.close(); }
  `);
  try {
    const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fixture], { env: { ...process.env, AUTOUM_DATA_DIR: join(directory, 'agent'), AUTOUM_ARTIFACTS_DIR: '', AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' } });
    assert.equal(result.stdout, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
