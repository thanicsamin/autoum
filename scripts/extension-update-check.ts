import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(process.env.AUTOUM_TEST_ROOT || '.');
const built = JSON.parse(await readFile(join(root, 'dist/extension/manifest.json'), 'utf8'));
const workerBytes = await readFile(join(root, 'dist/extension/background.js'));
assert.equal(built.background.service_worker, 'background-' + createHash('sha256').update(workerBytes).digest('hex').slice(0, 16) + '.js');
assert.deepEqual(await readFile(join(root, 'dist/extension', built.background.service_worker)), workerBytes);
const directory = await mkdtemp(join(tmpdir(), 'autoum-extension-update-'));
const extension = join(directory, 'extension'), profile = join(directory, 'profile');
await mkdir(extension);
const manifest = { manifest_version: 3, name: 'Autoum update fixture', version: built.version, key: built.key, background: { service_worker: 'background.js' } };
async function install(revision: number, versioned: boolean) {
  const bytes = 'globalThis.fixtureRevision=' + revision + ';chrome.runtime.onConnect.addListener(port => port.onMessage.addListener(() => port.postMessage(globalThis.fixtureRevision)));chrome.runtime.onInstalled.addListener(() => {});';
  if (versioned) manifest.version = built.version.split('.').slice(0, 3).join('.') + '.' + (Number(built.version.split('.')[3] || 0) + revision);
  manifest.background.service_worker = versioned ? 'background-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.js' : 'background.js';
  await writeFile(join(extension, manifest.background.service_worker), bytes);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'probe.html'), '<title>Extension update fixture</title>');
}
async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true,
    chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--load-extension=' + extension, '--no-first-run'],
  });
  try {
    const page = await context.newPage(); await page.goto('chrome-extension://' + (JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'))).extensionId + '/probe.html');
    return await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'update-fixture' });
      const timer = setTimeout(() => { port.disconnect(); reject(Error('Updated worker did not answer the sidebar port')); }, 20000);
      port.onMessage.addListener(revision => { clearTimeout(timer); port.disconnect(); resolve(revision); });
      port.onDisconnect.addListener(() => { clearTimeout(timer); reject(Error(chrome.runtime.lastError?.message || 'Worker port disconnected')); });
      port.postMessage({ ping: true });
    }));
  } finally { await context.close(); }
}
try {
  await install(1, false); assert.equal(await launch(), 1);
  await install(2, false); const cached = await launch();
  // This reproduces the stale script that ignored installed grouping fixes.
  assert.equal(cached, 1, 'This Thorium build retains an unchanged worker URL across restarts');
  await install(2, true); assert.equal(await launch(), 2, 'A versioned worker must replace the legacy cached script');
  await install(3, true); assert.equal(await launch(), 3, 'Subsequent updates must also load their new worker');
  console.log(JSON.stringify({ staleWorkerReproduced: true, legacyWorkerMigrated: true, subsequentUpdateLoaded: true, productionWorkerHashVerified: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
