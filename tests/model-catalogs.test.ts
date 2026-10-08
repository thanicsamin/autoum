import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeModels, publicModels } from '../host/auth.ts';
import { catalogSession, catalogStatus } from '../host/model-catalogs.ts';

test('live SDK catalogs and upstream availability add/remove models, isolate accounts, cache and retain lists on failure', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'autoum-catalogs-')); t.after(() => rm(folder, { recursive: true, force: true }));
  let metadata: any[] = [], available: any[] = [], status = 200, calls = 0;
  const headers: any[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/models/providers/')) { res.setHeader('Last-Modified', new Date(Date.now() + 60000).toUTCString()); res.end(JSON.stringify({ models: metadata })); return; }
    calls++; headers.push(req.headers); res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: available }));
  }); await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  await writeFile(join(folder, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'synthetic-private' } }));
  await writeFile(join(folder, 'models.json'), JSON.stringify({ providers: { 'opencode-go': { baseUrl: base + '/v1' } } }));
  const runtime = await makeModels(join(folder, 'auth.json'), join(folder, 'models.json'), { catalogBaseUrl: base });
  const template = runtime.getModels('opencode-go')[0]; assert.ok(template);
  metadata = [{ ...template, id: 'new-go-model', name: 'New Go model', api: 'anthropic-messages' }, { ...template, id: 'old-go-model', name: 'Old Go model' }];
  available = metadata.map(m => ({ id: m.id })); catalogSession(runtime, 'opencode-go', 'same-conversation');
  const refresh = (force = true) => runtime.refresh({ providers: ['opencode-go'], allowNetwork: true, force });
  assert.equal((await refresh()).errors.size, 0);
  assert.deepEqual(runtime.getModels('opencode-go').map(m => m.id).sort(), ['new-go-model', 'old-go-model']);
  assert.equal(runtime.getModel('opencode-go', 'new-go-model')?.api, 'anthropic-messages');
  assert.equal(headers.at(-1)['x-opencode-session'], 'same-conversation'); assert.equal(headers.at(-1)['user-agent'], 'autoum-browser/0.1.0');
  assert.equal(headers.at(-1).authorization, 'Bearer synthetic-private');
  available = [{ id: 'new-go-model' }]; assert.equal((await refresh()).errors.size, 0); assert.equal(runtime.getModel('opencode-go', 'old-go-model'), undefined);
  const count = calls; await refresh(false); assert.equal(calls, count);
  status = 503; assert.equal((await refresh()).errors.size, 1); assert.ok(catalogStatus(runtime, 'opencode-go').error); assert.ok(runtime.getModel('opencode-go', 'new-go-model'));
  const saved = JSON.parse(await readFile(join(folder, 'catalogs/opencode-go.json'), 'utf8')); assert.ok(!JSON.stringify(saved).includes('synthetic-private'));
  const restarted = await makeModels(join(folder, 'auth.json'), join(folder, 'models.json'), { catalogBaseUrl: base }); assert.deepEqual(restarted.getModels('opencode-go').map(m => m.id), ['new-go-model']);
  const second = await mkdtemp(join(tmpdir(), 'autoum-other-catalog-')); t.after(() => rm(second, { recursive: true, force: true }));
  const independent = await makeModels(join(second, 'auth.json'), join(second, 'models.json'), { catalogBaseUrl: base }); assert.equal(independent.getModel('opencode-go', 'new-go-model'), undefined);
  status = 200; available = []; assert.equal((await refresh()).errors.size, 0); assert.equal(runtime.getModels('opencode-go').length, 0);
});

test('subscription providers use fresh authoritative SDK catalogs with retired IDs removed', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'autoum-subscription-catalog-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, accountId: 'fixture-account' } }));
  let models: any[] = []; const server = createServer((req, res) => { res.setHeader('Last-Modified', new Date(Date.now() + 60000).toUTCString()); res.end(JSON.stringify({ models })); });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); t.after(() => server.close());
  const runtime = await makeModels(join(folder, 'auth.json'), join(folder, 'models.json'), { catalogBaseUrl: `http://127.0.0.1:${(server.address() as any).port}` });
  const template = runtime.getModels('openai-codex')[0]; models = [{ ...template, id: 'new-subscription-model', name: 'New subscription model' }];
  assert.equal((await runtime.refresh({ providers: ['openai-codex'], allowNetwork: true, force: true })).errors.size, 0);
  assert.deepEqual(runtime.getModels('openai-codex').map(m => m.id), ['new-subscription-model']);
});

test('account model state remains safe while an account runtime is being initialized', () => {
  assert.deepEqual(publicModels(undefined, 'opencode-go'), []); assert.deepEqual(catalogStatus(undefined, 'opencode-go'), {});
});
