import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AnyModel, RefreshModelsContext } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { readJson, saveJson } from './storage.ts';

export const catalogInterval = 15 * 60 * 1000;
type Snapshot = { models: AnyModel[]; checkedAt: number; source: string };
type Status = { checkedAt?: number; source?: string; error?: string };
const statuses = new WeakMap<ModelRuntime, Map<string, Status>>();
const sessions = new WeakMap<ModelRuntime, Map<string, string>>();
export function catalogStatus(runtime: ModelRuntime | undefined, provider: string): Status { return runtime ? statuses.get(runtime)?.get(provider) || {} : {}; }
export function catalogSession(runtime: ModelRuntime, provider: string, conversation: string) { sessions.get(runtime)?.set(provider, conversation); }

function compatible(model: AnyModel): AnyModel {
  return ['opencode', 'opencode-go'].includes(model.provider) && model.id === 'minimax-m2.7' && model.api === 'openai-completions'
    ? { ...model, api: 'anthropic-messages', compat: undefined, baseUrl: model.provider === 'opencode' ? 'https://opencode.ai/zen' : 'https://opencode.ai/zen/go' } as AnyModel : model;
}
function validModel(model: any, provider: string): model is AnyModel {
  return model?.provider === provider && typeof model.id === 'string' && model.id.length > 0 && model.id.length < 256 && typeof model.name === 'string' && typeof model.api === 'string' && typeof model.baseUrl === 'string' && Array.isArray(model.input) && model.cost && ['chat', 'classifier', 'image'].includes(model.type || 'chat');
}
const endpoints: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1/models', 'opencode-go': 'https://opencode.ai/zen/go/v1/models',
  openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models', google: 'https://generativelanguage.googleapis.com/v1beta/models',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/v1/models',
};

async function availableModels(runtime: ModelRuntime, provider: string, baseUrl: string | undefined, context: RefreshModelsContext): Promise<any[] | undefined> {
  if (!endpoints[provider] || (provider === 'openai' && runtime.isUsingOAuth(provider))) return;
  // Subscription connections without a public listing endpoint use the SDK's
  // live, typed catalog and credential-specific availability policy.
  const auth = await runtime.getAuth(provider, { signal: context.signal });
  if (!auth && !['opencode', 'opencode-go', 'openrouter', 'vercel-ai-gateway'].includes(provider)) return;
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'autoum-browser/0.1.0', ...auth?.auth.headers };
  if (provider.startsWith('opencode')) headers['x-opencode-session'] = sessions.get(runtime)!.get(provider)!;
  if (auth?.auth.apiKey) {
    if (provider === 'anthropic' && runtime.isUsingOAuth(provider)) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
    else if (provider === 'anthropic') headers['x-api-key'] = auth.auth.apiKey;
    else if (provider === 'google') headers['x-goog-api-key'] = auth.auth.apiKey;
    else headers.Authorization = `Bearer ${auth.auth.apiKey}`;
  }
  if (provider === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (runtime.isUsingOAuth(provider)) headers['anthropic-beta'] = 'oauth-2025-04-20'; }
  const suffix = ['anthropic', 'vercel-ai-gateway'].includes(provider) ? '/v1/models' : '/models';
  const url = baseUrl ? new URL(baseUrl.replace(/\/$/, '') + suffix) : new URL(endpoints[provider]);
  const entries: any[] = [];
  for (let page = 0; page < 20; page++) {
    const response = await fetch(url, { headers, signal: context.signal, redirect: 'error' });
    if (!response.ok) throw Error(`Model availability request failed (${response.status}).`);
    if (Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw Error('The provider model list is too large.');
    const reader = response.body?.getReader(); if (!reader) throw Error('The provider returned no model list.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8 * 1024 * 1024) throw Error('The provider model list is too large.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const models = provider === 'google' ? value.models : value.data;
    if (!Array.isArray(models) || models.some((m: any) => !m || typeof (m.id || m.name) !== 'string')) throw Error('The provider returned an invalid model list.');
    entries.push(...models);
    if (entries.length > 10000) throw Error('The provider model list is too large.');
    if (provider === 'google' && value.nextPageToken) url.searchParams.set('pageToken', value.nextPageToken);
    else if (provider === 'anthropic' && value.has_more && typeof value.last_id === 'string') url.searchParams.set('after_id', value.last_id);
    else return entries;
  }
  throw Error('The provider returned too many model pages.');
}

function reconcile(provider: string, metadata: readonly AnyModel[], available?: any[]): AnyModel[] {
  if (!available) return metadata.map(compatible);
  const listed = new Map<string, any>(available.filter(m => provider !== 'google' || m.supportedGenerationMethods?.includes('generateContent')).map(m => [provider === 'google' ? m.name.replace(/^models\//, '') : m.id, m]));
  // Operation-specific SDK entries keep their protocol and capability metadata.
  // A bare upstream ID cannot safely tell us which of Go's three APIs to use.
  const models = metadata.filter(m => listed.has(m.id)).map(compatible);
  for (const [id, item] of listed) {
    if (models.some(m => m.id === id) || !/^[\w./:\-]+$/.test(id) || id.length > 255) continue;
    if (item.architecture?.output_modalities && !item.architecture.output_modalities.includes('text')) continue;
    const api = provider === 'anthropic' ? 'anthropic-messages' : provider === 'google' ? 'google-generative-ai' : provider === 'openrouter' ? 'openai-completions' : provider === 'openai' && /^(?:gpt-(?!audio|image|transcribe|search)|o[1-9])/.test(id) ? 'openai-responses' : undefined;
    if (!api) continue;
    if (provider === 'openrouter' && !item.supported_parameters?.includes('tools')) continue;
    const base = metadata.find(m => (m.type || 'chat') === 'chat' && m.api === api);
    if (!base) continue;
    models.push({ ...base, type: 'chat', id, name: item.display_name || item.displayName || item.name || id, reasoning: !!item.supported_parameters?.includes('reasoning'),
      input: item.architecture?.input_modalities?.includes('image') || provider === 'anthropic' || provider === 'google' ? ['text', 'image'] : ['text'],
      contextWindow: item.context_length || item.inputTokenLimit || 32768, maxTokens: item.top_provider?.max_completion_tokens || item.outputTokenLimit || 4096,
      cost: { input: Number(item.pricing?.prompt || 0) * 1e6, output: Number(item.pricing?.completion || 0) * 1e6, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: undefined, compat: undefined, inputLimits: undefined,
    } as AnyModel);
  }
  return models;
}

export async function installDynamicCatalogs(runtime: ModelRuntime, folder: string, providers: readonly string[]) {
  const status = new Map<string, Status>(), session = new Map<string, string>(); statuses.set(runtime, status); sessions.set(runtime, session);
  for (const id of providers) {
    const base = runtime.getProvider(id); if (!base) continue;
    const path = join(folder, 'catalogs', id + '.json');
    const stored = await readJson<Snapshot | undefined>(path, undefined).catch(() => undefined);
    let snapshot = stored && Array.isArray(stored.models) && stored.models.every(m => validModel(m, id)) && Number.isFinite(stored.checkedAt) ? stored : undefined;
    if (snapshot) status.set(id, { checkedAt: snapshot.checkedAt, source: snapshot.source });
    session.set(id, 'autoum-models-' + crypto.randomUUID());
    let writes = Promise.resolve();
    runtime.registerNativeProvider({ ...base,
      getModels: () => (snapshot?.models || base.getModels().map(compatible)).filter(m => (m.type || 'chat') === 'chat') as any,
      getAllModels: () => snapshot?.models || (base.getAllModels?.() || base.getModels()).map(compatible),
      refreshModels: async context => {
        if (!context.allowNetwork) { await base.refreshModels?.(context); return; }
        if (!context.force && snapshot && Date.now() - snapshot.checkedAt < catalogInterval) return;
        try {
          // The installed SDK refreshes typed catalogs with ETag/cache support;
          // our availability query additionally removes retired upstream IDs.
          let remote = context.stored?.models;
          await base.refreshModels?.({ ...context, force: true, publish: async update => {
            if (update.persist?.models && update.persist.lastModified && update.persist.lastModified > 0) {
              if (!update.persist.models.every(model => validModel(model, id))) throw Error('Invalid SDK model metadata.');
              remote = update.persist.models;
            }
            return context.publish(update);
          } });
          const customBase = runtime.getProvider(id)?.baseUrl;
          const available = await availableModels(runtime, id, customBase, context);
          const metadata = remote?.length ? remote : base.getAllModels?.() || base.getModels();
          const models = reconcile(id, metadata, available);
          if (!models.length && available?.length && (base.getAllModels?.() || base.getModels()).length) throw Error('The provider returned no supported models; keeping the last working list.');
          context.signal.throwIfAborted();
          const next = { models, checkedAt: Date.now(), source: available ? 'provider' : 'sdk-catalog' };
          if (!await context.publish({ update: () => { snapshot = next; status.set(id, { checkedAt: next.checkedAt, source: next.source }); } })) return;
          writes = writes.catch(() => {}).then(() => saveJson(path, snapshot)); await writes;
        } catch (error) {
          if (!context.signal.aborted) status.set(id, { ...status.get(id), error: 'Could not refresh models. Keeping the last working list.' });
          throw error;
        }
      },
    });
  }
  await runtime.refresh({ allowNetwork: false, providers });
}
