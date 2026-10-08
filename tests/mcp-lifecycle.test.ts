import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { McpConnections } from '../host/mcp.ts';

async function fixture(gated = false) {
  const directory = await mkdtemp(join(tmpdir(), 'autoum-mcp-lifecycle-'));
  const pidFile = join(directory, 'pids'), gate = join(directory, 'ready'), callFile = join(directory, 'calls');
  const config = { name: 'lifecycle', command: process.execPath, args: [resolve('scripts/fixtures/mcp.mjs')], env: { AUTOUM_MCP_FIXTURE_PIDS: pidFile, AUTOUM_MCP_FIXTURE_CALLS: callFile, ...(gated ? { AUTOUM_MCP_FIXTURE_GATE: gate } : {}) } };
  const connections = new McpConnections([config], directory);
  const pids = async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (condition: () => Promise<boolean>) => {
    const until = Date.now() + 5000;
    while (!await condition()) { if (Date.now() >= until) throw Error('Fixture lifecycle timed out.'); await delay(10); }
  };
  return { connections, config, pids, alive, waitFor, calls: () => readFile(callFile, 'utf8'), hold: () => rm(gate), release: () => writeFile(gate, ''), cleanup: async () => {
    await connections.close();
    // Only PIDs written by this private fixture are eligible for failure cleanup.
    for (const pid of await pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await waitFor(async () => (await pids()).every(pid => !alive(pid)));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('simultaneous MCP connections share one initialized helper and shutdown removes it', async () => {
  const f = await fixture();
  try {
    const clients = await Promise.all(Array.from({ length: 8 }, () => f.connections.connect(f.config)));
    const pids = await f.pids();
    assert.equal(pids.length, 1, 'concurrent callers must not start duplicate MCP helpers');
    assert.equal(new Set(clients).size, 1);
    assert.equal((await clients[0].listTools()).tools[0].name, 'greet');
    await f.connections.close();
    await f.waitFor(async () => pids.every(pid => !f.alive(pid)));
    await assert.rejects(f.connections.connect(f.config), /closed/i);
    assert.deepEqual(await f.pids(), pids);
  } finally { await f.cleanup(); }
});

test('cancelling a discovered tool during MCP reconnect settles promptly and stops its unused helper', async () => {
  const f = await fixture(true); const controller = new AbortController();
  let running: Promise<any> | undefined;
  try {
    await f.release();
    const host: any = { allow: async () => true, transport: { send() {} } };
    const tools = await f.connections.tools(host, 'chat'), greet = tools.find(tool => tool.name !== 'mcp_context')!;
    await (await f.connections.connect(f.config)).close(); await f.hold();
    running = greet.execute('call', { name: 'ExitDuringCall' }, controller.signal, undefined, {} as any).then(result => ({ result }), error => ({ error }));
    await f.waitFor(async () => (await f.pids()).length === 2);
    const cancelledPid = (await f.pids())[1], start = performance.now(); controller.abort();
    const result = await Promise.race([running, delay(500).then(() => { throw Error('Cancelled MCP reconnect is still waiting.'); })]);
    assert.equal(result.error?.name, 'AbortError');
    console.log(JSON.stringify({ cancelledMcpReconnectMs: +(performance.now() - start).toFixed(2) }));
    assert.equal(await f.calls().catch(() => ''), '', 'a cancelled reconnect must never dispatch the action');
    const retry = greet.execute('next', { name: 'Separate request' }, undefined, undefined, {} as any);
    await f.waitFor(async () => (await f.pids()).length === 3);
    await f.release();
    const next = await retry;
    assert.match((next.content[0] as any).text, /Hello Separate request/); assert.equal((await f.pids()).length, 3);
    await f.waitFor(async () => !f.alive(cancelledPid));
    const healthy = await greet.execute('after-cleanup', { name: 'Still connected' }, undefined, undefined, {} as any);
    assert.match((healthy.content[0] as any).text, /Hello Still connected/); assert.equal((await f.pids()).length, 3, 'old cleanup must not remove the replacement');
    await assert.rejects(greet.execute('aborted', { name: 'ExitDuringCall' }, controller.signal, undefined, {} as any), { name: 'AbortError' });
    assert.equal(await f.calls().catch(() => ''), '');
  } finally { await f.release(); await running; await f.cleanup(); }
});

test('cancelling one MCP reconnect waiter preserves another authorized context request', async () => {
  const f = await fixture(true); const controller = new AbortController();
  let running: Promise<any> | undefined, contextRequest: Promise<any> | undefined;
  try {
    await f.release();
    const host: any = { allow: async () => true, transport: { send() {} } };
    const tools = await f.connections.tools(host, 'chat');
    const greet = tools.find(tool => tool.name !== 'mcp_context')!, context = tools.find(tool => tool.name === 'mcp_context')!;
    await (await f.connections.connect(f.config)).close(); await f.hold();
    running = greet.execute('call', { name: 'ExitDuringCall' }, controller.signal, undefined, {} as any).then(result => ({ result }), error => ({ error }));
    let contextFinished = false;
    contextRequest = context.execute('context', { server: 'lifecycle', action: 'list' }, undefined, undefined, {} as any).then(result => { contextFinished = true; return { result }; }, error => ({ error }));
    await f.waitFor(async () => (await f.pids()).length === 2);
    controller.abort();
    const result = await Promise.race([running, delay(500).then(() => { throw Error('Cancelled shared reconnect is still waiting.'); })]);
    assert.equal(result.error?.name, 'AbortError');
    assert.equal(contextFinished, false); assert.equal(f.alive((await f.pids())[1]), true);
    await f.release();
    const completed = await contextRequest;
    assert.ok(completed.result); assert.match((completed.result.content[0] as any).text, /fixture:\/\/note/);
    assert.equal((await f.pids()).length, 2); assert.equal(await f.calls().catch(() => ''), '');
  } finally { await f.release(); await Promise.all([running, contextRequest]); await f.cleanup(); }
});

test('MCP shutdown cancels startup and cannot resurrect a connection', async () => {
  const f = await fixture(true);
  const startup = f.connections.connect(f.config).then(client => ({ client, error: undefined }), error => ({ client: undefined, error }));
  try {
    await f.waitFor(async () => (await f.pids()).length === 1);
    await f.connections.close();
    await f.release();
    const result = await startup;
    assert.ok(result.error, 'shutdown during startup must reject the pending connection');
    await f.waitFor(async () => (await f.pids()).every(pid => !f.alive(pid)));
    await assert.rejects(f.connections.connect(f.config), /closed/i);
  } finally { await f.release(); await startup; await f.cleanup(); }
});

test('failed shared MCP startup can be retried, and immediate shutdown starts no helper', async () => {
  const f = await fixture();
  try {
    const failed = await Promise.allSettled(Array.from({ length: 4 }, () => f.connections.connect({ ...f.config, command: join(tmpdir(), 'autoum-nonexistent-mcp-executable') })));
    assert.ok(failed.every(result => result.status === 'rejected' && /could not connect/.test(String(result.reason))));
    assert.equal((await f.pids()).length, 0);
    assert.equal((await (await f.connections.connect(f.config)).listTools()).tools[0].name, 'greet');
  } finally { await f.cleanup(); }
  const immediate = await fixture();
  try {
    const startup = immediate.connections.connect(immediate.config);
    const rejected = assert.rejects(startup, /closed/i);
    const firstClose = immediate.connections.close(), secondClose = immediate.connections.close();
    assert.equal(firstClose, secondClose);
    await Promise.all([firstClose, secondClose, rejected]);
    assert.equal((await immediate.pids()).length, 0);
  } finally { await immediate.cleanup(); }
});

test('shutdown aborts a shared HTTP MCP initialization request', { timeout: 10000 }, async () => {
  let initialized = 0, markStarted!: () => void, markClosed!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).method, 'initialize'); initialized++;
    response.on('close', markClosed); markStarted();
    // Hold the real SDK fetch in initialization until the manager shuts down.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const config = { name: 'http', url: `http://127.0.0.1:${address.port}/mcp` };
  const connections = new McpConnections([config], tmpdir());
  const startups = Array.from({ length: 8 }, () => connections.connect(config));
  const rejected = Promise.all(startups.map(startup => assert.rejects(startup, /closed/i)));
  try {
    await started; await connections.close(); await rejected; await closed;
    assert.equal(initialized, 1);
  } finally { await connections.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP reconnect aborts its fetch only after its final waiter cancels', { timeout: 10000 }, async () => {
  let initialized = 0, disconnected = false, markStarted!: () => void, markClosed!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).method, 'initialize'); initialized++;
    response.on('close', () => { disconnected = true; markClosed(); }); markStarted();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { name: 'http', url: `http://127.0.0.1:${(server.address() as any).port}/mcp` };
  const connections = new McpConnections([config], tmpdir());
  const first = new AbortController(), second = new AbortController();
  const one = connections.connect(config, first.signal).then(client => ({ client, error: undefined }), error => ({ error }));
  const two = connections.connect(config, second.signal).then(client => ({ client, error: undefined }), error => ({ error }));
  try {
    await started; first.abort(); assert.equal((await one).error?.name, 'AbortError');
    assert.equal(initialized, 1); assert.equal(disconnected, false, 'another waiter still needs initialization');
    second.abort(); assert.equal((await two).error?.name, 'AbortError');
    await closed; await connections.close(); assert.equal(initialized, 1);
  } finally { await connections.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('an exited MCP helper is replaced once and already-discovered tools use the replacement', async () => {
  const f = await fixture(); let allowed = true, permissions = 0;
  const host: any = { allow: async () => { permissions++; return allowed; }, transport: { send() {} } };
  try {
    const tools = await f.connections.tools(host, 'chat');
    const greet = tools.find(tool => tool.name !== 'mcp_context')!;
    const first = await f.connections.connect(f.config), firstPid = (await f.pids())[0];
    const transport = first.transport!;
    const closed = new Promise<void>(resolve => { const onclose = transport.onclose; transport.onclose = () => { onclose?.(); resolve(); }; });
    process.kill(firstPid, 'SIGTERM'); await closed;
    allowed = false;
    await assert.rejects(greet.execute('call', { name: 'Denied' }, undefined, undefined, {} as any), /declined/);
    assert.equal((await f.pids()).length, 1, 'denied actions cannot restart an MCP helper'); allowed = true;
    const clients = await Promise.all(Array.from({ length: 8 }, () => f.connections.connect(f.config)));
    assert.notEqual(clients[0], first, 'a closed SDK client must not remain cached');
    assert.equal(new Set(clients).size, 1); assert.equal((await f.pids()).length, 2);
    const result = await greet.execute('call', { name: 'Again' }, undefined, undefined, {} as any);
    assert.match((result.content[0] as any).text, /Hello Again from MCP/);
    await assert.rejects(greet.execute('call', { name: 'ExitDuringCall' }, undefined, undefined, {} as any), /closed/i);
    assert.equal(await f.calls(), 'executed\n'); assert.equal((await f.pids()).length, 2, 'an action interrupted after execution must not be replayed');
    const recovered = await greet.execute('call', { name: 'Next request' }, undefined, undefined, {} as any);
    assert.match((recovered.content[0] as any).text, /Hello Next request from MCP/); assert.equal((await f.pids()).length, 3);
    allowed = false;
    await assert.rejects(greet.execute('call', { name: 'Denied' }, undefined, undefined, {} as any), /declined/);
    assert.equal(permissions, 5); assert.equal((await f.pids()).length, 3);
  } finally { await f.cleanup(); }
});
