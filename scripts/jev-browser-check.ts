import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = resolve('.'), directory = await mkdtemp(join(tmpdir(), 'autoum-jev-check-'));
const results = resolve(process.env.AUTOUM_TEST_RESULTS || 'test-results'); await mkdir(results, { recursive: true });
const live = process.argv.includes('--live');
const agentDir = join(directory, 'browser-agent'), nodeDir = join(directory, 'decision-agent'), profile = join(directory, 'profile');
process.env.AUTOUM_DATA_DIR = nodeDir; process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_USAGE_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts'); const { fastBrowse } = await import('../host/fast-browser.ts');
await mkdir(join(nodeDir, 'pi'), { recursive: true, mode: 0o700 });
if (live) {
  assert.ok(process.env.AUTOUM_TEST_KEY_FILE, 'Set a private authorized key file for --live');
  const key = (await readFile(process.env.AUTOUM_TEST_KEY_FILE!, 'utf8')).trim();
  await writeFile(join(nodeDir, 'pi/auth.json'), JSON.stringify({ opencode: { type: 'api_key', key } }), { mode: 0o600 });
}
execFileSync(process.execPath, ['scripts/install.mjs', '--no-desktop'], { env: { ...process.env, AUTOUM_PROFILE_ONLY: '1', AUTOUM_DATA_DIR: agentDir, AUTOUM_PROFILE_DIR: profile }, stdio: 'pipe' });
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AUTOUM_TEST_BROWSER || join(root, 'browser/thorium'), headless: true, chromiumSandbox: true, viewport: { width: 1000, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${join(root, 'dist/extension')}`, '--no-first-run'], env: { ...process.env, CHROME_DEVEL_SANDBOX: process.env.CHROME_DEVEL_SANDBOX || '/usr/lib/chromium/chrome-sandbox' } });
let host: InstanceType<typeof AgentHost> | undefined;
const report: any = { date: new Date().toISOString(), tier: live ? 'live-opencode' : 'deterministic', cases: [], decisions: [], headersVerified: true };
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const panel = await context.newPage(); const { extensionId } = JSON.parse(await readFile('dist/build.json', 'utf8'));
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  const rpc = (type: string, data: any) => panel.evaluate(async ({ type, data }) => {
    const port = chrome.runtime.connect({ name: 'autoum-ui' }), id = crypto.randomUUID();
    return new Promise<any>((yes, no) => { port.onMessage.addListener(p => { if (p.reply !== id) return; port.disconnect(); p.error ? no(Error(p.error)) : yes(p.data); }); port.postMessage({ id, type, data }); });
  }, { type, data });
  const web = await context.newPage();
  await web.goto('about:blank');
  const tabId = (await worker.evaluate(async () => await chrome.tabs.query({}))).filter(t => t.url === 'about:blank').at(-1)!.id!;
  let beforeInspect: (() => Promise<void>) | undefined; let mutations = 0;
  host = new AgentHost({ send() {}, request: async (_type: string, args: any) => {
    if (_type === 'approval') return false;
    if (args.action === 'inspect' && beforeInspect) { const run = beforeInspect; beforeInspect = undefined; await run(); }
    if (['click', 'type', 'press', 'scroll'].includes(args.action)) mutations++;
    return rpc('local_browser', args);
  } } as any);
  await host.init(); const chat = host.settings.chats[0]; chat.mode = 'all'; host.current(chat.id).busy = true;
  host.settings.decisionModel = { provider: 'opencode', id: 'jev-1.13-free' };
  if (!live) {
    const model = host.runtime.getModelOfType('classifier', 'opencode', 'jev-1.13-free')!;
    const runtime: any = { classify: async (_model: any, input: any) => {
      const criteria = input.questions.target.criteria;
      const options = Object.keys(criteria).filter(k => /^e\d+$/.test(k));
      const choice = options.find(k => /Target|Full name|Search field|Reveal solution|Save profile|Region|Submit search/.test(criteria[k])) || 'NONE';
      return { stopReason: 'stop', answers: { target: { type: 'choice', choice, confidence: .98, probabilities: { [choice]: .98, ...(choice === 'NONE' ? { AMBIGUOUS: .02 } : { NONE: .02 }) } } } };
    } };
    (host as any).decisionRuntime = () => runtime;
    (host.runtime as any).getModelsOfType = () => [model];
  }
  const runtime = host.decisionRuntime('opencode')!;
  const classify = runtime.classify.bind(runtime);
  (runtime as any).classify = async (model: any, input: any, options: any) => {
    assert.equal(options.headers['x-opencode-session'], chat.id); assert.equal(options.headers['User-Agent'], 'autoum-browser/0.1.0');
    const started = performance.now();
    const result = await classify(model, input, options); const answer: any = result.answers.target;
    report.decisions.push({ choice: answer?.choice, confidence: answer?.confidence, probability: answer?.probabilities?.[answer.choice], probabilities: answer?.probabilities, candidates: Object.keys(input.questions.target.criteria).length - 2, elapsedMs: Math.round(performance.now() - started) });
    return result;
  };
  const fixture = async (html: string) => {
    // Real file navigation yields a stable inspect URL; no external website is mutated.
    const path = join(directory, 'fixture-' + report.cases.length + '.html');
    await writeFile(path, '<title>Jev fixture</title>' + html); await web.goto(pathToFileURL(path).href); mutations = 0;
  };
  const check = async (name: string, html: string, steps: any[], expected: string, outcome: () => Promise<boolean>, setup?: () => Promise<void>) => {
    await fixture(html); await setup?.(); const started = performance.now();
    let result: any; try { result = await fastBrowse(host!, chat.id, { tabId, steps }); } catch (e: any) { result = { status: 'error', reason: String(e.message).slice(0, 160) }; }
    const pass = result.status === expected && await outcome();
    report.cases.push({ name, pass, expected, status: result.status, reason: result.reason, mutations, elapsedMs: Math.round(performance.now() - started), events: result.events });
    console.log(JSON.stringify(report.cases.at(-1)));
    await writeFile(join(results, 'jev-browser-' + report.tier + '.json'), JSON.stringify(report, null, 2));
  };
  const click = (intent = 'Click Target', expectedText = 'Success 731') => [{ action: 'click', intent, expectedText }];
  const good = '<h1>Ready</h1><button id="target" onclick="document.querySelector(\'h1\').textContent=\'Success 731\'">Target</button>';
  const success = async () => await web.locator('h1').textContent() === 'Success 731';
  await check('simple-local-click', good, click(), 'verified', success);
  await check('delayed-render', good.replace("document.querySelector('h1').textContent='Success 731'", "setTimeout(()=>document.querySelector('h1').textContent='Success 731',900)"), click(), 'verified', success);
  await check('already-present-result', '<h1>Success 731</h1><button id="target">Target</button>', click(), 'needs_agent', async () => mutations === 0);
  await check('disabled-control', '<h1>Ready</h1><button id="target" disabled>Target</button>', click(), 'needs_agent', async () => mutations === 0);
  await check('hidden-decoy', '<button style="visibility:hidden">Target</button>' + good, click(), 'verified', success);
  await check('associated-input-label', '<label for="name">Full name</label><input id="name"><label for="email">Email address</label><input id="email">', [{ action: 'type', intent: 'Enter the full name', text: 'Ada Lovelace' }], 'completed_steps', async () => await web.locator('#name').inputValue() === 'Ada Lovelace' && await web.locator('#email').inputValue() === '');
  await check('contenteditable-input', '<label for="editor">Full name</label><div id="editor" contenteditable="true" aria-label="Full name" style="min-height:40px"></div>', [{ action: 'type', intent: 'Enter the full name', text: 'Ada Lovelace' }], 'completed_steps', async () => await web.locator('#editor').textContent() === 'Ada Lovelace');
  await check('dropdown-change', '<label for="region">Region</label><select id="region"><option value="us">US</option><option value="uk">UK</option></select>', [{ action: 'type', intent: 'Choose the Region dropdown', text: 'uk' }], 'completed_steps', async () => await web.locator('#region').inputValue() === 'uk');
  await check('enter-submit', '<h1>Ready</h1><form onsubmit="event.preventDefault();document.querySelector(\'h1\').textContent=\'Success 731\'"><input aria-label="Search field"><button>Submit search</button></form>', [{ action: 'type', intent: 'Enter Search field', text: 'Ada' }, { action: 'press', intent: 'Press Enter in the Search field to submit the search', key: 'Enter', expectedText: 'Success 731' }], 'verified', success);
  await check('many-controls', Array.from({ length: 90 }, (_, i) => '<button>Unrelated item ' + i + '</button>').join('') + good, click(), 'verified', success);
  await check('ambiguous-duplicate-labels', '<h1>Ready</h1><button onclick="document.querySelector(\'h1\').textContent=\'Wrong first\'">Target</button><button onclick="document.querySelector(\'h1\').textContent=\'Wrong second\'">Target</button>', click(), 'needs_agent', async () => mutations === 0);
  await check('missing-control', '<h1>Ready</h1><button>Unrelated action</button>', click(), 'needs_agent', async () => mutations === 0);
  await check('stale-target', good, click(), 'needs_agent', async () => mutations === 0, async () => { beforeInspect = async () => { await web.locator('#target').evaluate(el => { el.textContent = 'Changed'; }); }; });
  await check('denied-approval', good, click(), 'declined', async () => mutations === 0, async () => { chat.mode = 'ask'; }); chat.mode = 'all';
  await check('wrong-result-stops-plan', good.replace('Success 731', 'Wrong result'), [...click(), { action: 'click', intent: 'Target', expectedText: 'Other result' }], 'needs_agent', async () => mutations === 1);
  await check('shadow-root-click', '<h1>Ready</h1><div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML=`<button onclick="document.querySelector(\'h1\').textContent=\'Success 731\'">Target</button>`;</script>', click(), 'verified', success);
  await check('covered-control-no-dispatch', good + '<div onclick="document.querySelector(\'h1\').textContent=\'Overlay clicked\'" style="position:fixed;inset:0;background:white;z-index:999">Overlay</div>', click(), 'needs_agent', async () => await web.locator('h1').textContent() === 'Ready');
  await check('readonly-input', '<label for="name">Full name</label><input id="name" readonly>', [{ action: 'type', intent: 'Enter the full name', text: 'Ada' }], 'needs_agent', async () => mutations === 0 && await web.locator('#name').inputValue() === '');
  await check('aria-disabled-control', '<h1>Ready</h1><button aria-disabled="true">Target</button>', click(), 'needs_agent', async () => mutations === 0);
  await check('disappeared-target', good, click(), 'needs_agent', async () => mutations === 0, async () => { beforeInspect = async () => { await web.locator('#target').evaluate(el => el.remove()); }; });
  await check('keyboard-unfocusable-target', '<h1>Ready</h1><div role="button" id="target">Target</div>', [{ action: 'press', intent: 'Press Enter on Target', key: 'Enter', expectedText: 'Success 731' }], 'needs_agent', async () => await web.locator('h1').textContent() === 'Ready');
  await check('closed-shadow-no-visible-control', '<h1>Ready</h1><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"closed"}).innerHTML="<button>Target</button>";</script>', click(), 'needs_agent', async () => mutations === 0);
  await check('shadow-root-id-selector', '<h1>Ready</h1><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML=`<button id="inside" onclick="document.querySelector(\'h1\').textContent=\'Success 731\'">Target</button>`;</script>', click(), 'verified', success);
  await check('aria-labelledby-input', '<span id="label">Full name</span><input id="name" aria-labelledby="label">', [{ action: 'type', intent: 'Enter the full name', text: 'Ada' }], 'completed_steps', async () => await web.locator('#name').inputValue() === 'Ada');
  await check('duplicate-dom-ids', '<h1>Ready</h1><button id="same">Unrelated action</button><button id="same" onclick="document.querySelector(\'h1\').textContent=\'Success 731\'">Target</button>', click(), 'verified', success);
  report.passed = report.cases.filter((c: any) => c.pass).length; report.total = report.cases.length;
  await writeFile(join(results, 'jev-browser-' + report.tier + '.json'), JSON.stringify(report, null, 2));
  console.log(`Jev ${report.tier}: ${report.passed}/${report.total} cases passed.`);
  if (report.passed !== report.total) process.exitCode = 1;
} finally { if (host) await host.close(); await context.close(); await rm(directory, { recursive: true, force: true }); }
