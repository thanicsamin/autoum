import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsExtensionPlan, windowsRegistryValue, windowsWorker } from '../scripts/windows-extension.mjs';

test('Windows Chrome/Vivaldi installations isolate helpers and data from the browser edition', () => {
  const options = { localAppData: 'C:\\Users\\A User\\AppData\\Local' };
  const chrome = windowsExtensionPlan({ ...options, browser: 'google-chrome' });
  const vivaldi = windowsExtensionPlan({ ...options, browser: 'vivaldi' });
  assert.notEqual(chrome.data, vivaldi.data);
  assert.notEqual(chrome.host, vivaldi.host);
  for (const plan of [chrome, vivaldi]) {
    assert.notEqual(plan.host, 'rocks.autoum.agent');
    assert.equal(plan.registry.length, 4);
    assert(plan.registry.every((entry: { key: string }) => entry.key.startsWith('HKCU\\') && entry.key.endsWith(plan.host)));
    assert(!plan.data.startsWith(plan.profile));
    assert(plan.helper.endsWith('.exe'));
  }
});

test('Windows paths preserve spaces/custom folders and reject drive-relative or injected paths', () => {
  const plan = windowsExtensionPlan({ localAppData: 'C:\\Local', destination: 'D:\\My Apps\\Autoum', configRoot: '\\\\server\\share\\User Data' });
  assert.equal(plan.target, 'D:\\My Apps\\Autoum');
  assert.equal(plan.profile, '\\\\server\\share\\User Data');
  for (const localAppData of ['relative', 'C:relative', '\\Local', '/Local', 'C:\\Local\nOther']) assert.throws(() => windowsExtensionPlan({ localAppData }));
  assert.throws(() => windowsExtensionPlan({ localAppData: 'C:\\Local', browser: 'edge' }));
});

test('Windows standalone workers use separate helpers and retain stable revisions on reinstall', () => {
  const source = Buffer.from('chrome.runtime.connectNative("rocks.autoum.agent");');
  const chrome = windowsWorker(source, 'rocks.autoum.chrome');
  const vivaldi = windowsWorker(source, 'rocks.autoum.vivaldi');
  assert.equal(source.toString(), 'chrome.runtime.connectNative("rocks.autoum.agent");');
  assert(chrome.bytes.toString().includes('rocks.autoum.chrome'));
  assert.notEqual(chrome.extensionWorker, vivaldi.extensionWorker);
  const previous = { version: '0.1.0', ...chrome };
  assert.equal(windowsWorker(source, 'rocks.autoum.chrome', previous).workerRevision, chrome.workerRevision);
  assert.equal(windowsWorker(Buffer.concat([source, Buffer.from('// updated')]), 'rocks.autoum.chrome', previous).workerRevision, chrome.workerRevision + 1);
  assert.throws(() => windowsWorker(Buffer.from('no native helper'), 'rocks.autoum.chrome'), /native host changed/);
  assert.throws(() => windowsWorker(Buffer.concat([source, source]), 'rocks.autoum.chrome'), /native host changed/);
  assert.throws(() => windowsWorker(source, 'rocks.autoum.agent'), /Unknown/);
});

test('Registry values parse localized labels without losing spaced executable paths', () => {
  assert.equal(windowsRegistryValue('    (Default)    REG_SZ    C:\\A User\\host.json\r\n'), 'C:\\A User\\host.json');
  assert.equal(windowsRegistryValue('    (predeterminado)    REG_EXPAND_SZ    C:\\Local\\host.json\r\n'), 'C:\\Local\\host.json');
  assert.equal(windowsRegistryValue('ERROR: not found'), undefined);
});
