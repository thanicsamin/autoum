import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const testDirectory = await mkdtemp(join(tmpdir(), 'autoum-suite-'));
process.env.AUTOUM_DATA_DIR = testDirectory; process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1';
const { Accounts, credentialEmail } = await import('../host/accounts.ts');
const { makeModels } = await import('../host/auth.ts');
const { browserTheme } = await import('../host/appearance.ts');
const { fetchUsage, parseUsage, Usage } = await import('../host/usage.ts');
const { after } = await import('node:test'); after(() => rm(testDirectory, { recursive: true, force: true }));

test('account slots isolate credentials across restarts and disconnect only the selected account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-accounts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const primary = await makeModels(join(directory, 'pi/auth.json'), join(directory, 'pi/models.json'));
  const accounts = new Accounts(directory, primary); await accounts.init();
  const first = await accounts.connect('opencode', 'api_key', {} as any, { label: 'Personal', key: 'fixture-personal' });
  const second = await accounts.connect('opencode', 'api_key', {} as any, { label: 'Work', key: 'fixture-work' });
  assert.notEqual(first.id, second.id);
  assert.equal((await accounts.runtime(first.id, 'opencode')!.getAuth('opencode'))?.auth.apiKey, 'fixture-personal');
  assert.equal((await accounts.runtime(second.id, 'opencode')!.getAuth('opencode'))?.auth.apiKey, 'fixture-work');
  assert.ok(!JSON.stringify(accounts.records).includes('fixture-'));
  assert.throws(() => accounts.runtime(first.id, 'anthropic'), /another provider/);
  await accounts.disconnect(first.id); assert.equal(accounts.runtime(first.id, 'opencode'), undefined);
  const restored = new Accounts(directory, primary); await restored.init();
  assert.equal(restored.record(first.id).configured, false); assert.equal(restored.record(second.id).label, 'Work');
  assert.equal((await restored.runtime(second.id, 'opencode')!.getAuth('opencode'))?.auth.apiKey, 'fixture-work');
  if (process.platform !== 'win32') assert.equal((await stat(restored.authPath(second.id))).mode & 0o777, 0o600);
  const google1 = await restored.addGoogle(undefined, 'Google personal'); const google2 = await restored.addGoogle(undefined, 'Google work');
  assert.notEqual(restored.googleProfile(google1.id), restored.googleProfile(google2.id));
  assert.equal(credentialEmail({ access: 'x.' + Buffer.from(JSON.stringify({ email: 'user@example.test' })).toString('base64url') + '.x' }), 'user@example.test');
  assert.equal(credentialEmail({ access: 'invalid' }), undefined);
});

test('usage parses actual quota windows and never invents a limit or treats malformed values as zero', () => {
  assert.equal(parseUsage('opencode-go', { usage: { rolling: { percent: 35, resetsAt: '2026-10-06T00:00:00Z' }, weekly: { percent: 70 } } })[0].usedPercent, 35);
  assert.equal(parseUsage('anthropic', { five_hour: { utilization: 0 }, seven_day: { utilization: null } }).length, 1);
  assert.deepEqual(parseUsage('anthropic', { five_hour: { utilization: NaN }, seven_day: { utilization: -1 } }), []);
  assert.equal(parseUsage('openai-codex', { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1791244800 } } })[0].label, '5h window');
  assert.equal(parseUsage('openrouter', { data: { limit: 20, limit_remaining: 5 } })[0].usedPercent, 75);
  assert.deepEqual(parseUsage('openrouter', { data: { limit: null, usage: 1 } }), []);
  assert.deepEqual(parseUsage('typesafe', {}), []);
  assert.equal(browserTheme({ browser: { theme: { color_scheme2: 2 } } }), 'dark');
  assert.equal(browserTheme({ browser: { theme: { color_scheme2: 1 } } }), 'light'); assert.equal(browserTheme({}), 'system');
});

test('usage uses the chosen account and stable OpenCode session header, with outage backoff', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const seen: any[] = []; let unavailable = false;
  globalThis.fetch = async (url, options) => { seen.push({ url: String(url), headers: options!.headers }); return unavailable ? new Response('', { status: 429 }) : Response.json({ usage: { rolling: { percent: 42 } } }); };
  const account: any = { id: 'work', provider: 'opencode-go', method: 'api_key', configured: true };
  const runtime: any = { getAuth: async () => ({ auth: { apiKey: 'fixture-work' } }) };
  const result = await fetchUsage(account, runtime, {}, 'conversation-id'); assert.equal(result.windows[0].usedPercent, 42);
  assert.equal(seen[0].headers.Authorization, 'Bearer fixture-work'); assert.equal(seen[0].headers['x-opencode-session'], 'conversation-id');
  assert.equal(seen[0].headers['User-Agent'], 'autoum-browser/0.1.0');
  const usage = new Usage({ record: () => account, runtime: () => runtime, authPath: () => '/tmp/autoum-nonexistent-fixture' } as any);
  unavailable = true; await usage.get('work', 'conversation-id'); await usage.get('work', 'conversation-id', true); await usage.get('work', 'conversation-id', true);
  assert.equal(seen.length, 2, 'Refresh does not hammer a rate-limited usage endpoint');
});

test('models, accounts, modes, folders and approval changes persist; hidden models stay out of new chats', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-settings-')); t.after(() => rm(directory, { recursive: true, force: true }));

  const { AgentHost } = await import('../host/agent.ts');
  let approval: any = { decision: 'allow', mode: 'all' };
  const transport: any = { send() {}, request: async () => approval };
  const host = new AgentHost(transport); await host.init();
  const account = await host.handle('login', { provider: 'opencode', method: 'api_key', key: 'fixture-persist', label: 'Work' });
  const models = host.runtime.getModels('opencode'); assert.ok(models.length > 1);
  const chat = host.settings.chats[0];
  await host.handle('update_chat', { chatId: chat.id, provider: 'opencode', model: models[1].id, accountId: account.accountId, mode: 'auto-review' });
  const folder = await host.handle('create_folder', { name: 'Research' });
  const second = await host.handle('new_chat', { folderId: folder.id }); assert.equal(second.model, models[1].id); assert.equal(second.accountId, account.accountId); assert.equal(second.mode, 'auto-review');
  await host.handle('update_chat', { chatId: second.id, mode: 'ask' }); host.current(second.id).busy = true;
  assert.equal(await host.allow(second.id, 'write', { path: '/tmp/fixture' }), true); assert.equal(second.mode, 'all');
  host.current(second.id).busy = false;
  await host.handle('model_visibility', { provider: 'opencode', hidden: [models[1].id] });
  await assert.rejects(host.handle('model_visibility', { provider: 'opencode', hidden: ['invented'] }), /valid models/);
  const next = await host.handle('new_chat'); assert.notEqual(next.model, models[1].id); assert.equal(next.mode, 'all'); assert.equal(next.accountId, account.accountId);
  second.messages.push({ role: 'user', text: 'Preserve this history' }); await host.handle('delete_folder', { folderId: folder.id }); assert.equal(second.folderId, undefined); assert.equal(second.messages.length, 1);
  await host.close();
  const persisted = JSON.parse(await readFile(join(testDirectory, 'settings.json'), 'utf8')); assert.equal(persisted.lastModels.opencode.model, models[1].id); assert.equal(persisted.lastMode, 'all');
  const restored = new AgentHost(transport); await restored.init(); assert.equal(restored.settings.lastModels!.opencode.accountId, account.accountId); assert.ok(restored.settings.hiddenModels!.opencode.includes(models[1].id));
  const afterRestart = await restored.handle('new_chat'); assert.equal(afterRestart.mode, 'all'); assert.notEqual(afterRestart.model, models[1].id);
  await restored.handle('update_chat', { chatId: afterRestart.id, mode: 'ask' }); restored.current(afterRestart.id).busy = true; approval = { decision: 'allow', mode: 'invented' };
  assert.equal(await restored.allow(afterRestart.id, 'write', {}), false); assert.equal(afterRestart.mode, 'ask'); await restored.close();
});

test('Steer targets the running chat, queues during startup and Stop clears pending SDK input', async () => {
  const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any);
  host.save = async () => {}; host.state = (() => ({})) as any;
  const chat: any = { id: 'steer', provider: 'opencode', model: 'fixture', mode: 'ask', messages: [], requests: [], title: 'New conversation' };
  host.settings.chats = [chat, { ...chat, id: 'other', messages: [], requests: [] }];
  const seen: string[] = []; let clear = false;
  let ready!: (value: any) => void, finish!: () => void;
  const session = { steer: async (text: string) => { seen.push(text); }, prompt: async (_text: string, options: any) => { assert.equal(options.streamingBehavior, 'steer'); await new Promise<void>(resolve => { finish = resolve; }); }, clearQueue() { clear = true; }, abort: async () => finish() };
  host.session = async () => new Promise<any>(resolve => { ready = value => { host.current(chat.id).session = value; resolve(value); }; });
  assert.deepEqual(await host.send(chat.id, 'Start browsing'), { started: true });
  assert.deepEqual(await host.send(chat.id, 'Use the other page instead'), { steered: true });
  assert.equal(host.current(chat.id).busy, true);
  await assert.rejects(host.send('other', 'Different task'), /Stop the current task/);
  ready(session); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['Use the other page instead']);
  await host.send(chat.id, 'Only summarize'); assert.deepEqual(seen, ['Use the other page instead', 'Only summarize']);
  assert.deepEqual(chat.requests, ['Start browsing', 'Use the other page instead', 'Only summarize']);
  await host.stop(chat.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(clear, true); assert.equal(host.current(chat.id).busy, false);
});

test('Antigravity steering cancels and resumes the same ACP session; Stop does not resume', async () => {
  const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any); host.save = async () => {}; host.state = (() => ({})) as any;
  const chat: any = { id: 'google-steer', provider: 'antigravity', model: 'fixture', mode: 'ask', messages: [], requests: [], title: 'New conversation' };
  host.settings.chats = [chat]; const prompts: string[] = []; let cancelled = 0, finish!: () => void;
  host.current(chat.id).agy = { prompt: async (text: string) => { prompts.push(text); await new Promise<void>(resolve => { finish = resolve; }); }, cancel: async () => { cancelled++; finish(); } } as any;
  await host.send(chat.id, 'Research'); await host.send(chat.id, 'Focus on the pricing page');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompts, ['Research', 'Focus on the pricing page']); assert.equal(cancelled, 1);
  await host.stop(chat.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts.length, 2); assert.equal(host.current(chat.id).busy, false);
});

test('named Google account catalogs survive restart, isolate availability and migrate old reasoning IDs', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { Antigravity } = await import('../host/antigravity.ts'); const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any); await host.init(); t.after(() => host.close());
  const one = await host.accounts.addGoogle(undefined, 'Google fixture personal'), two = await host.accounts.addGoogle(undefined, 'Google fixture work');
  const raw = [{ id: 'flash-medium', name: 'Gemini 3.8 Flash (Medium)' }, { id: 'flash-high', name: 'Gemini 3.8 Flash (High)' }];
  for (const [id, models] of [[one.id, raw], [two.id, [{ id: 'other-low', name: 'Gemini 3.1 Pro (Low)' }]]] as const) {
    await mkdir(host.accounts.googleProfile(id), { recursive: true }); await writeFile(join(host.accounts.googleProfile(id), 'models.json'), JSON.stringify(models));
  }
  await Antigravity.initialize(); assert.equal(Antigravity.modelsFor(one.id).length, 1); assert.equal(Antigravity.modelsFor(two.id).length, 1);
  const model = Antigravity.modelsFor(one.id)[0]; assert.equal(model.name, 'Gemini 3.8 Flash');
  const chat = host.settings.chats[0]; await host.handle('update_chat', { chatId: chat.id, provider: 'antigravity', accountId: one.id, model: 'flash-high' });
  assert.equal(chat.model, model.id); assert.equal(chat.thinking, 'high');
  await host.handle('update_chat', { chatId: chat.id, thinking: 'medium' });
  await assert.rejects(host.handle('update_chat', { chatId: chat.id, thinking: 'off', mode: 'all' }), /does not support/);
  const mode = chat.mode;
  await assert.rejects(host.handle('update_chat', { chatId: chat.id, accountId: two.id, mode: mode === 'all' ? 'ask' : 'all' }), /available model/); assert.equal(chat.accountId, one.id); assert.equal(chat.mode, mode);
  await host.save(); await host.close(); await Antigravity.initialize();
  const restored = new AgentHost({ send() {} } as any); await restored.init(); t.after(() => restored.close());
  assert.equal(restored.settings.lastAccountModels![one.id].thinking, 'medium');
  const next = restored.newChat(); assert.equal(next.accountId, one.id); assert.equal(next.model, model.id); assert.equal(next.thinking, 'medium');
  assert.equal((restored.state().providers.find((p: any) => p.id === 'antigravity') as any).accountModels[one.id][0].name, 'Gemini 3.8 Flash');
  await restored.handle('memory_settings', { enabled: false, lines: 16 }); await restored.close();
  const restart = new AgentHost({ send() {} } as any); await restart.init(); assert.equal(restart.settings.memoryEnabled, false); assert.equal(restart.settings.memoryLines, 16); await restart.close();
});

test('chat pins and archives persist, preserve history, reject malformed flags and delete saved Pi sessions', async () => {
  const { AgentHost } = await import('../host/agent.ts');
  const host = new AgentHost({ send() {} } as any); await host.init();
  const first = host.newChat(), second = host.newChat(); first.messages.push({ role: 'user', text: 'Keep archived history' });
  await host.handle('chat_flags', { chatId: first.id, pinned: true });
  await assert.rejects(host.handle('chat_flags', { chatId: first.id, pinned: false, archived: 'bad' }), /valid chat option/); assert.equal(first.pinned, true);
  await host.handle('view_chat', { chatId: first.id }); host.current(first.id).busy = true;
  await assert.rejects(host.handle('chat_flags', { chatId: first.id, archived: true }), /Stop the task/); host.current(first.id).busy = false;
  await host.handle('chat_flags', { chatId: first.id, archived: true }); assert.notEqual(host.settings.activeChatId, first.id); assert.equal(first.messages.length, 1);
  await host.close(); const restored = new AgentHost({ send() {} } as any); await restored.init();
  const saved = restored.record(first.id); assert.equal(saved.pinned, true); assert.equal(saved.archived, true); assert.equal(saved.messages[0].text, 'Keep archived history');
  await restored.handle('chat_flags', { chatId: first.id, archived: false }); assert.equal(saved.archived, false);
  const { mkdir, writeFile } = await import('node:fs/promises'); const session = join(testDirectory, 'pi/sessions', first.id); await mkdir(session, { recursive: true }); await writeFile(join(session, 'fixture.jsonl'), 'private test history');
  await restored.handle('delete_chat', { chatId: first.id }); assert.ok(!restored.settings.chats.some(c => c.id === first.id)); assert.ok(restored.settings.chats.some(c => c.id === second.id)); await assert.rejects(stat(session), { code: 'ENOENT' });
  await assert.rejects(restored.handle('delete_chat', { chatId: 'unknown' }), /Conversation not found/);
  const google = await restored.accounts.addGoogle(undefined, 'Delete fixture'); const googleChat = restored.newChat();
  await restored.handle('update_chat', { chatId: googleChat.id, provider: 'antigravity', accountId: google.id, model: 'default' });
  const googleProfile = restored.accounts.googleProfile(google.id), sessionId = crypto.randomUUID();
  const database = join(googleProfile, 'antigravity-acp/conversations', sessionId + '.db'), otherDatabase = join(googleProfile, 'antigravity-acp/conversations', 'other.db');
  const brain = join(googleProfile, 'antigravity-acp/brain', sessionId), reference = join(googleProfile, 'sessions', googleChat.id + '.json');
  await mkdir(join(googleProfile, 'antigravity-acp/conversations'), { recursive: true }); await mkdir(brain, { recursive: true }); await mkdir(join(googleProfile, 'sessions'), { recursive: true });
  await writeFile(reference, JSON.stringify({ sessionId })); await writeFile(database, 'linked history'); await writeFile(otherDatabase, 'another chat'); await writeFile(join(brain, 'transcript.jsonl'), 'linked transcript');
  await restored.handle('delete_chat', { chatId: googleChat.id }); await assert.rejects(stat(database), { code: 'ENOENT' }); await assert.rejects(stat(brain), { code: 'ENOENT' }); await assert.rejects(stat(reference), { code: 'ENOENT' }); assert.equal(await readFile(otherDatabase, 'utf8'), 'another chat');
  await restored.close();
});

test('Antigravity auto-review keeps the remembered reviewer account after its chat is deleted', async () => {
  const { AgentHost } = await import('../host/agent.ts');
  let approvals = 0, reviewed = 0;
  const host = new AgentHost({ send() {}, request: async (type: string) => { if (type === 'approval') { approvals++; return false; } return { url: 'https://example.test', label: 'Test' }; } } as any);
  const model: any = { id: 'reviewer', provider: 'opencode' };
  const runtime: any = { getModel: (provider: string, id: string) => provider === 'opencode' && id === model.id ? model : undefined, completeSimple: async (_model: any, _input: any, options: any) => { reviewed++; assert.equal(options.headers['x-opencode-session'], 'google-only'); return { stopReason: 'stop', content: [{ type: 'text', text: '{"decision":"allow"}' }] }; } };
  host.accounts = { records: [{ id: 'remembered-reviewer', provider: 'opencode', configured: true }], runtime: (accountId: string) => accountId === 'remembered-reviewer' ? runtime : undefined } as any;
  host.settings = { chats: [{ id: 'google-only', provider: 'antigravity', mode: 'auto-review', requests: ['Click the example button'], messages: [] } as any], skillPaths: [], extensionPaths: [], lastModels: { opencode: { provider: 'opencode', model: 'reviewer', accountId: 'remembered-reviewer', thinking: 'off' } } };
  host.current('google-only').busy = true;
  assert.equal(await host.allow('google-only', 'browser', { action: 'click' }), true); assert.equal(reviewed, 1); assert.equal(approvals, 0);
  host.settings.lastModels = {}; assert.equal(await host.allow('google-only', 'browser', { action: 'click' }), false); assert.equal(approvals, 1, 'No connected remembered reviewer still asks instead of inventing approval');
});
