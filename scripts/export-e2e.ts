import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), directory = await mkdtemp(join(tmpdir(), 'autoum-export-browser-'));
const agent = join(directory, 'agent'), profile = join(directory, 'profile'), downloads = join(directory, 'downloads');
const id = crypto.randomUUID(), original = 'Original export title', changed = 'A longer edited title during the actual export';
const text = '🙂 \\ " \n'.repeat(70000), errors: string[] = [];
await mkdir(join(agent, 'pi'), { recursive: true }); await mkdir(downloads);
await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: original, provider: 'opencode', model: 'gpt-6.1', mode: 'ask', messages: [{ role: 'assistant', text }], requests: [], cwd: directory }], activeChatId: id, skillPaths: [], extensionPaths: [] }));
const env = { ...process.env, AUTOUM_DATA_DIR: agent, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: join(directory, 'artifacts'), AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' };
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...env, AUTOUM_PROFILE_ONLY: '1' }, stdio: 'pipe' });
const preferencesPath = join(profile, 'Default/Preferences');
const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
preferences.download = { ...preferences.download, default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
await writeFile(preferencesPath, JSON.stringify(preferences));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 320, height: 950 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--load-extension=' + join(root, 'dist/extension'), '--no-first-run'], env });
const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
try {
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(`globalThis.captureExportPort = port => {
    const post = port.postMessage.bind(port); let first;
    port.onMessage.addListener(packet => { if (packet.type === 'export_data' && packet.data.offset === 0 && !globalThis.heldExport) first = packet.id; });
    port.postMessage = packet => { if (packet.reply === first && !globalThis.heldExport) { globalThis.heldExport = { packet, release: () => post(packet) }; first = undefined; } else post(packet); };
  }; chrome.runtime.onConnect.addListener(globalThis.captureExportPort);`);
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Conversation data', { exact: true }).click();
  const cdp = await context.newCDPSession(page); await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await page.evaluate(() => {
    const download = chrome.downloads.download.bind(chrome.downloads);
    (globalThis as any).exportDownloads = [];
    chrome.downloads.download = (async (options: any) => {
      (globalThis as any).exportDownloads.push({ filename: options.filename, saveAs: options.saveAs });
      // The actual Download API writes to the disposable CDP folder. A real
      // native save dialog is intentionally suppressed in this headless fixture.
      return download({ ...options, saveAs: false });
    }) as typeof chrome.downloads.download;
  });
  const exportButton = page.getByRole('button', { name: 'Export chats', exact: true });
  await exportButton.click();
  const holdDeadline = Date.now() + 10000;
  while (!await worker.evaluate('!!globalThis.heldExport')) { assert.ok(Date.now() < holdDeadline, 'The first export chunk must be held'); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await exportButton.isDisabled(), true); assert.equal(await exportButton.getAttribute('aria-busy'), 'true');
  await page.evaluate(async ({ chatId, title }) => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID();
    await new Promise<void>((yes, no) => { port.onMessage.addListener(packet => { if (packet.reply === id) { port.disconnect(); packet.error ? no(Error(packet.error)) : yes(); } }); port.postMessage({ id, type: 'update_chat', data: { chatId, title } }); });
  }, { chatId: id, title: changed });
  await worker.evaluate('globalThis.heldExport.release()');
  const until = Date.now() + 10000;
  while (!(await readdir(downloads)).includes('autoum-conversations.json')) { assert.ok(Date.now() < until, 'Export download must complete'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const first = JSON.parse(await readFile(join(downloads, 'autoum-conversations.json'), 'utf8'));
  assert.equal(first.chats[0].title, original); assert.equal(first.chats[0].messages[0].text, text);
  await page.waitForFunction(() => document.querySelector('button[aria-label="Export chats"]')?.getAttribute('aria-busy') === 'false');
  await exportButton.click();
  while (!(await readdir(downloads)).includes('autoum-conversations (1).json')) { assert.ok(Date.now() < until + 10000, 'A separate fresh export must complete'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const latest = JSON.parse(await readFile(join(downloads, 'autoum-conversations (1).json'), 'utf8'));
  assert.equal(latest.chats[0].title, changed); assert.equal(latest.chats[0].messages[0].text, text);
  assert.deepEqual(await page.evaluate('(globalThis.exportDownloads)'), [{ filename: 'autoum-conversations.json', saveAs: true }, { filename: 'autoum-conversations.json', saveAs: true }]);
  await worker.evaluate('globalThis.heldExport = undefined');
  await exportButton.click();
  const failureDeadline = Date.now() + 10000;
  while (!await worker.evaluate('!!globalThis.heldExport')) { assert.ok(Date.now() < failureDeadline, 'The malformed export fixture must be held'); await new Promise(resolve => setTimeout(resolve, 20)); }
  await worker.evaluate('globalThis.heldExport.packet.data.next = 0; globalThis.heldExport.release()');
  await page.locator('.global-error').filter({ hasText: 'The export could not be loaded completely. Try again.' }).waitFor();
  assert.equal(await exportButton.isEnabled(), true);
  assert.equal(await page.evaluate('globalThis.exportDownloads.length'), 2, 'Malformed output must not be downloaded');
  await exportButton.click();
  while (!(await readdir(downloads)).includes('autoum-conversations (2).json')) { assert.ok(Date.now() < failureDeadline + 10000, 'Retry after the failed export must work'); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(JSON.parse(await readFile(join(downloads, 'autoum-conversations (2).json'), 'utf8')).chats[0].title, changed);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ stableExportDuringEdit: true, subsequentExportFresh: true, actualBlobDownload: true, busyButton: true, failedExportRecovers: true, unicodeAndEscapesPreserved: true, narrowSidebar: true, nativeSaveDialogTested: false }));
} catch (error) {
  console.error(await page.locator('.error').allTextContents());
  console.error(await page.evaluate(async () => ({ downloads: (await chrome.downloads.search({})).map(item => ({ filename: item.filename, state: item.state, error: item.error })), calls: (globalThis as any).exportDownloads })));
  console.error({ privateFiles: await readdir(downloads) }); throw error;
}
finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
