import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpConnections, validateMcp, publicMcp } from '../host/mcp.ts';
const directory = await mkdtemp(join(tmpdir(), 'autoum-integrations-')); process.env.AUTOUM_DATA_DIR = join(directory, 'agent'); process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts'); process.env.AUTOUM_DISABLE_ACCOUNT_DETECTION = '1'; process.env.AUTOUM_DISABLE_MODEL_NETWORK = '1';
const { AgentHost } = await import('../host/agent.ts'); const { skillTool, discoverSkills } = await import('../host/skills.ts'); const { attachmentTool } = await import('../host/attachments.ts');
after(() => rm(directory, { recursive: true, force: true }));
test('MCP configuration imports standard maps, protects secrets and rejects invalid transports', () => {
  const configs = validateMcp({ mcpServers: { test: { command: 'node', args: ['server.mjs'], env: { TOKEN: 'private-test', REF: '${env:MY_TOKEN}' } } } });
  const safe = publicMcp(configs); assert.doesNotMatch(JSON.stringify(safe), /private-test/); assert.equal(safe[0].env!.REF, '${env:MY_TOKEN}'); assert.deepEqual(validateMcp(safe, configs), configs);
  assert.throws(() => validateMcp([{ name: 'bad', url: 'http://remote.test/mcp' }]), /HTTPS/);
  assert.throws(() => validateMcp([{ name: 'bad', command: 'node', url: 'https://test/mcp' }]), /command or/);
  assert.throws(() => validateMcp([{ name: 'same', command: 'node' }, { name: 'same', command: 'node' }]), /unique/);
});
test('actual MCP SDK discovers/calls tools, resources and prompts, with denial and cancellation', async () => {
  const connections = new McpConnections([{ name: 'fixture', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')] }], directory);
  let allowed = true, permissions = 0; const host: any = { allow: async () => { permissions++; return allowed; }, transport: { send() {} } };
  try {
    const tools = await connections.tools(host, 'chat'); assert.equal(tools.length, 2); const greet = tools.find(t => t.name !== 'mcp_context')!;
    const result = await greet.execute('call', { name: 'Autoum' }, undefined, undefined, {} as any); assert.match((result.content[0] as any).text, /Hello Autoum from MCP/);
    allowed = false; await assert.rejects(greet.execute('call', { name: 'No' }, undefined, undefined, {} as any), /declined/); allowed = true;
    const context = tools.find(t => t.name === 'mcp_context')!; const list = await context.execute('call', { server: 'fixture', action: 'list' }, undefined, undefined, {} as any); assert.match((list.content[0] as any).text, /fixture:\/\/note/);
    const resource = await context.execute('call', { server: 'fixture', action: 'read_resource', uri: 'fixture://note' }, undefined, undefined, {} as any); assert.match((resource.content[0] as any).text, /real SDK resource/);
    const prompt = await context.execute('call', { server: 'fixture', action: 'get_prompt', name: 'explain' }, undefined, undefined, {} as any); assert.match((prompt.content[0] as any).text, /Explain the fixture simply/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(greet.execute('call', { name: 'No' }, controller.signal, undefined, {} as any)); assert.equal(permissions, 5);
  } finally { await connections.close(); }
});
test('skills, MCP settings and artifact destination persist; attachments are chunked, private and inline deliverable metadata', async () => {
  const host = new AgentHost({ send() {}, request: async () => ({}) } as any); await host.init();
  try {
    const chat = host.settings.chats[0]; const folder = join(directory, 'skills/example'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'SKILL.md'), '---\nname: fixture-explainer\ndescription: Explain a fixture simply.\n---\nUse a clear example.');
    await host.handle('configure', { skillPaths: [join(directory, 'skills')], mcpServers: [{ name: 'fixture', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { TOKEN: 'private-value' } }] });
    const skills = discoverSkills(host, chat.id); assert.ok(skills.skills.some(s => s.name === 'fixture-explainer')); const read = await skillTool(host, chat.id).execute('read', { action: 'read', name: 'fixture-explainer' }, undefined, undefined, {} as any); assert.match((read.content[0] as any).text, /clear example/);
    await host.handle('configure', { disabledSkills: [join(folder, 'SKILL.md')] }); assert.ok(!discoverSkills(host, chat.id).skills.some(s => s.name === 'fixture-explainer'));
    assert.doesNotMatch(JSON.stringify(host.state()), /private-value/);
    const bytes = await readFile(resolve('extension/icons/16.png')); const start = await host.handle('attachment_start', { chatId: chat.id, name: '../../image.png', mimeType: 'image/png', size: bytes.length });
    await assert.rejects(host.handle('attachment_chunk', { chatId: chat.id, id: start.id, offset: 2, data: bytes.toString('base64') }), /Invalid/);
    await host.handle('attachment_chunk', { chatId: chat.id, id: start.id, offset: 0, data: bytes.toString('base64') }); const item = await host.handle('attachment_finish', { chatId: chat.id, id: start.id }); assert.equal(item.name, 'image.png'); assert.ok(item.path.startsWith(join(directory, 'artifacts', chat.id))); assert.deepEqual(await readFile(item.path), bytes);
    if (process.platform !== 'win32') assert.equal((await stat(item.path)).mode & 0o777, 0o600);
    const context = await host.attachments.context(chat.id, [item.id]); assert.equal(context.images[0].mimeType, 'image/png');
    await attachmentTool(host, chat.id).execute('show', { path: item.path, caption: 'Here is the image.' }, undefined, undefined, {} as any); assert.equal(chat.messages.at(-1)!.attachments![0].mimeType, 'image/png');
    await assert.rejects(host.handle('attachment_preview', { chatId: chat.id, id: 'unknown' }), /not found/);
  } finally { await host.close(); }
  const restored = new AgentHost({ send() {} } as any); await restored.init(); try { assert.equal(restored.settings.skillPaths.length, 1); assert.equal(restored.mcpConfigs.length, 1); assert.equal(restored.settings.chats[0].messages.at(-1)!.attachments!.length, 1); } finally { await restored.close(); }
});

test('previewing an attachment changed on disk fails clearly instead of returning a stalled cursor', async () => {
  const host = new AgentHost({ send() {}, request: async () => ({}) } as any); await host.init();
  try {
    const chat = host.settings.chats[0], bytes = await readFile(resolve('extension/icons/16.png'));
    const { id } = await host.handle('attachment_start', { chatId: chat.id, name: 'changed-preview.png', mimeType: 'image/png', size: bytes.length });
    await host.handle('attachment_chunk', { chatId: chat.id, id, offset: 0, data: bytes.toString('base64') });
    const item = await host.handle('attachment_finish', { chatId: chat.id, id });
    assert.equal((await host.handle('attachment_preview', { chatId: chat.id, id, offset: 0 })).next, null);
    await writeFile(item.path, bytes.subarray(0, bytes.length - 1));
    await assert.rejects(host.handle('attachment_preview', { chatId: chat.id, id, offset: 0 }), /changed|incomplete/i);
    await writeFile(item.path, '');
    await assert.rejects(host.handle('attachment_preview', { chatId: chat.id, id, offset: 0 }), /changed|incomplete/i);
    await writeFile(item.path, bytes);
    const recovered = await host.handle('attachment_preview', { chatId: chat.id, id, offset: 0 });
    assert.equal(recovered.next, null); assert.deepEqual(Buffer.from(recovered.data, 'base64'), bytes);
  } finally { await host.close(); }
});
