// Measure real inherited-font composer controls in an isolated browser profile.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = resolve(process.env.AUTOUM_TEST_ROOT || '.'), directory = await mkdtemp(join(tmpdir(), 'autoum-composer-layout-'));
const agent = join(directory, 'agent'), profile = join(directory, 'profile'), id = crypto.randomUUID();
const requests: any[] = [];
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.headers.authorization, 'Bearer local-layout-fixture');
  assert.equal(req.headers['x-opencode-session'], id); assert.equal(req.headers['user-agent'], 'autoum-browser/0.1.0');
  const input = JSON.parse(body); requests.push(input);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'layout', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Held local stream for layout checks.' }, finish_reason: null }] }) + '\n\n');
  // Only Stop ends this request; keep the real sidebar in its busy state.
});
await new Promise<void>(yes => provider.listen(0, '127.0.0.1', yes));
const baseUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`;
await mkdir(join(agent, 'pi'), { recursive: true });
await writeFile(join(agent, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key: 'local-layout-fixture' } }));
await writeFile(join(agent, 'pi/models.json'), JSON.stringify({ providers: { opencode: { baseUrl, models: ['layout-fixture', 'layout-second'].map((id, i) => ({ id, name: i ? 'Second selected model' : 'Readable selected model', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 })) } } }));
await writeFile(join(agent, 'settings.json'), JSON.stringify({ chats: [{ id, title: 'Layout fixture', provider: 'opencode', model: 'layout-fixture', mode: 'ask', messages: [], requests: [], cwd: directory }], activeChatId: id, skillPaths: [], extensionPaths: [] }));
const env = { ...process.env, AUTOUM_DATA_DIR: agent, AUTOUM_PROFILE_DIR: profile, AUTOUM_ARTIFACTS_DIR: join(directory, 'artifacts'), AUTOUM_DISABLE_ACCOUNT_DETECTION: '1', AUTOUM_DISABLE_USAGE_NETWORK: '1' };
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { cwd: root, env: { ...env, AUTOUM_PROFILE_ONLY: '1' }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: join(root, 'browser/thorium'), headless: true, chromiumSandbox: process.env.AUTOUM_TEST_SANDBOX === '1', viewport: { width: 320, height: 950 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--load-extension=' + join(root, 'dist/extension'), '--no-first-run'], env });
try {
  const { extensionId } = JSON.parse(await readFile(join(root, 'dist/build.json'), 'utf8'));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.getByLabel('AI model', { exact: true }).waitFor();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const results = resolve(process.env.AUTOUM_TEST_RESULTS || 'test-results/composer-2026-10-06'); await mkdir(results, { recursive: true });
  const measurements: any[] = [];
  const measure = async (phase: string, expanded: boolean) => { for (const width of [320, 420, 640]) {
    await page.setViewportSize({ width, height: 950 });
    for (const font of [16, 24, 32]) {
      await worker.evaluate(font => chrome.fontSettings.setDefaultFontSize({ pixelSize: font }), font);
      await page.waitForFunction(font => getComputedStyle(document.documentElement).fontSize === font + 'px', font);
      const measurement = await page.locator(expanded ? '#model-control select' : '.collapsed-model').evaluate((element, setup) => {
        const rect = element.getBoundingClientRect();
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.composer-bottom>button')).map(button => {
          const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { name: button.getAttribute('aria-label'), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, hit: hit === button || (!!hit && button.contains(hit)) };
        });
        const selectors = setup.expanded ? Array.from(document.querySelectorAll<HTMLSelectElement>('.provider-controls select')).map(select => {
          const style = getComputedStyle(select), canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const selected = select.selectedOptions[0]?.textContent || '';
          return { name: select.getAttribute('aria-label'), width: select.getBoundingClientRect().width, selected, requiredWidth: context.measureText(selected).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 28 };
        }) : [];
        return { ...setup, modelWidth: +rect.width.toFixed(2), modelLeft: rect.left, modelRight: rect.right, selected: element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent : element.textContent, overflow: document.documentElement.scrollWidth > innerWidth, controls, selectors };
      }, { width, font, phase, expanded });
      measurements.push(measurement);
      assert.ok(measurement.modelWidth >= 140, `Selected model control is only ${measurement.modelWidth}px at ${width}px/${font}px inherited font (${phase}, expanded=${expanded})`);
      assert.equal(measurement.overflow, false); assert.ok(measurement.modelLeft >= 0 && measurement.modelRight <= width);
      assert.equal(measurement.selected, 'Readable selected model');
      for (const selector of measurement.selectors) assert.ok(selector.width >= selector.requiredWidth, `Provider/account fixture identity is clipped: ${JSON.stringify({ viewportWidth: width, font, ...selector })}`);
      for (const control of measurement.controls) { assert.ok(control.width >= 28 && control.height >= 28, control.name || 'Unnamed control'); assert.ok(control.left >= 0 && control.right <= width && control.top >= 0 && control.bottom <= 950, JSON.stringify(control)); assert.ok(control.hit, JSON.stringify(control)); }
      for (const [i, a] of measurement.controls.entries()) for (const b of measurement.controls.slice(i + 1)) assert.ok(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + .5 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + .5, 'Composer buttons must not overlap');
      assert.ok(measurement.controls.some(control => control.name === (phase === 'busy' ? 'Steer' : 'Send')));
      if (phase === 'busy') assert.ok(measurement.controls.some(control => control.name === 'Stop and take over'));
      if (width === 320 && font >= 24) await page.screenshot({ path: join(results, `${phase}-${expanded ? 'expanded' : 'collapsed'}-${font}.png`) });
    }
  } };
  await measure('idle', true);
  await page.getByLabel('AI model', { exact: true }).selectOption('layout-second');
  await page.reload(); await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('#model-control select')?.value === 'layout-second');
  await page.getByLabel('AI model', { exact: true }).selectOption('layout-fixture');
  await page.getByRole('button', { name: 'Hide model controls', exact: true }).click();
  await measure('idle', false);
  await page.reload(); await page.getByRole('button', { name: 'Show model controls', exact: true }).waitFor();
  assert.equal(await page.getByLabel('AI model', { exact: true }).isVisible(), false); assert.equal(await page.locator('.collapsed-model').innerText(), 'Readable selected model');
  await page.locator('.composer textarea').fill('Hold a private stream for the layout check.'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).waitFor(); await page.getByText('Held local stream for layout checks.', { exact: true }).waitFor();
  await measure('busy', false);
  await page.getByRole('button', { name: 'Show model controls', exact: true }).click(); await measure('busy', true);
  assert.equal(await page.getByLabel('AI model', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Stop and take over', exact: true }).click(); await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(requests.length, 1); assert.deepEqual(errors, []);
  await writeFile(join(results, 'measurements.json'), JSON.stringify({ measurements, modelChoicePersisted: true, collapsedModePersisted: true, busyStopAndSteerAccessible: true, providerRequests: requests.length }, null, 2));
  console.log(JSON.stringify({ cases: measurements.length, minModelWidth: Math.min(...measurements.map(item => item.modelWidth)), modelChoicePersisted: true, collapsedModePersisted: true, busyStopAndSteerAccessible: true, errors }));
} finally { await context.close(); provider.closeAllConnections(); provider.close(); await rm(directory, { recursive: true, force: true }); }
