import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readJson, saveJson } from './storage.ts';
import { login, makeModels, providerIds } from './auth.ts';
import type { NativeTransport } from './protocol.ts';

export type Account = { id: string; provider: string; label: string; email?: string; source?: string; method: 'oauth' | 'api_key'; configured: boolean };
export function credentialEmail(credential: any): string | undefined {
  const clean = (v: unknown) => typeof v === 'string' && v.includes('@') && v.length <= 254 ? v : undefined;
  if (clean(credential?.email)) return clean(credential.email);
  for (const token of [credential?.access, credential?.id_token]) {
    try { const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      const email = clean(claims.email) || clean(claims['https://api.openai.com/profile']?.email); if (email) return email;
    } catch {}
  }
}
export class Accounts {
  records: Account[] = [];
  private writes: Promise<any> = Promise.resolve();
  private runtimes = new Map<string, ModelRuntime>();
  constructor(private directory: string, private primary: ModelRuntime) {}
  async init(detected: Record<string, string> = {}) {
    this.records = await readJson(join(this.directory, 'accounts.json'), []);
    await this.syncPrimary(this.primary, detected);
    for (const account of this.records.filter(a => !a.id.startsWith('default:') && a.provider !== 'antigravity')) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.id)) throw Error('Invalid account record.');
      const runtime = await makeModels(this.authPath(account.id), join(this.directory, 'pi/models.json'));
      this.runtimes.set(account.id, runtime);
      const credential = (await readJson<any>(this.authPath(account.id), {}))[account.provider];
      account.configured = !!credential; account.email = credentialEmail(credential) || account.email;
    }
    await this.save();
  }
  authPath(id: string) { return id.startsWith('default:') ? join(this.directory, 'pi/auth.json') : join(this.directory, 'accounts', id, 'auth.json'); }
  googleProfile(id?: string) { return !id || id === 'default:antigravity' ? join(this.directory, 'antigravity') : join(this.directory, 'accounts', this.record(id).id, 'antigravity'); }
  record(id: string) { const account = this.records.find(a => a.id === id); if (!account) throw Error('Account not found.'); return account; }
  forProvider(provider: string) { return this.records.filter(a => a.provider === provider); }
  defaultId(provider: string) { return this.forProvider(provider).find(a => a.configured)?.id; }
  runtime(id: string | undefined, provider: string) {
    const selected = id || this.defaultId(provider); if (!selected) return undefined;
    const account = this.record(selected); if (account.provider !== provider) throw Error('This account belongs to another provider.');
    if (!account.configured) return undefined;
    return account.id.startsWith('default:') ? this.primary : this.runtimes.get(account.id);
  }
  async syncPrimary(runtime: ModelRuntime, detected: Record<string, string> = {}) {
    this.primary = runtime; const credentials = await readJson<any>(join(this.directory, 'pi/auth.json'), {});
    for (const provider of providerIds) {
      let account = this.records.find(a => a.id === `default:${provider}`);
      const configured = runtime.hasConfiguredAuth(provider);
      if (!account && !configured) continue;
      if (!account) { account = { id: `default:${provider}`, provider, label: 'Personal', method: credentials[provider]?.type === 'oauth' ? 'oauth' : 'api_key', configured }; this.records.push(account); }
      account.configured = configured; account.source = detected[provider] || account.source;
      account.email = credentialEmail(credentials[provider]) || account.email;
      if (provider === 'openai-codex' && account.configured && !account.email) {
        const codex = await readJson<any>(join(homedir(), '.codex/auth.json'), {}).catch(() => ({}));
        if (codex.tokens?.access_token === credentials[provider]?.access || credentials[provider]?.accountId && codex.tokens?.account_id === credentials[provider].accountId) {
          account.email = credentialEmail({ id_token: codex.tokens.id_token }); account.source ||= 'Codex';
        }
      }
      if (provider === 'anthropic' && account.source === 'Claude Code' && !account.email) {
        const metadata = await readJson<any>(join(homedir(), '.claude.json'), {}).catch(() => ({})); account.email = credentialEmail({ email: metadata.oauthAccount?.emailAddress });
      }
    }
  }
  async connect(provider: string, method: 'oauth' | 'api_key', transport: NativeTransport, options: { id?: string; label?: string; key?: string; signal?: AbortSignal }) {
    if (!providerIds.includes(provider)) throw Error('Unknown provider.');
    const existing = options.id ? this.record(options.id) : undefined;
    if (existing && existing.provider !== provider) throw Error('This account belongs to another provider.');
    const id = existing?.id || crypto.randomUUID();
    const runtime = id.startsWith('default:') ? this.primary : this.runtimes.get(id) || await makeModels(this.authPath(id), join(this.directory, 'pi/models.json'));
    try {
      await login(runtime, transport, provider, method, options.key, options.signal);
      const credential = (await readJson<any>(this.authPath(id), {}))[provider];
      let email = credentialEmail(credential);
      // Claude's OAuth profile endpoint exposes identity without a model request.
      if (provider === 'anthropic' && method === 'oauth' && !email) {
        try { const auth = await runtime.getAuth(provider); const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
          headers: { Authorization: `Bearer ${auth?.auth.apiKey}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        }); if (response.ok) { const identity: any = await response.json(); email = credentialEmail({ email: identity.account?.email_address || identity.email }); } } catch {}
      }
      const account: Account = { id, provider, label: (options.label?.trim() || existing?.label || 'Personal').slice(0, 80), email, source: undefined, method, configured: true };
      if (existing) Object.assign(existing, account); else this.records.push(account);
      this.runtimes.set(id, runtime); await this.save(); return account;
    } catch (error) { if (!existing) await rm(join(this.directory, 'accounts', id), { recursive: true, force: true }); throw error; }
  }
  async addGoogle(id?: string, label?: string) {
    const existing = id ? this.record(id) : undefined;
    if (existing && existing.provider !== 'antigravity') throw Error('This account belongs to another provider.');
    const account: Account = existing || { id: crypto.randomUUID(), provider: 'antigravity', label: 'Personal', method: 'oauth', configured: false };
    if (label?.trim()) account.label = label.trim().slice(0, 80);
    if (!existing) this.records.push(account); await this.save(); return account;
  }
  async syncGoogle(configured: boolean, source?: string) {
    let account = this.records.find(a => a.id === 'default:antigravity');
    if (!account && configured) { account = { id: 'default:antigravity', provider: 'antigravity', label: 'Personal', method: 'oauth', configured }; this.records.push(account); }
    if (account) { account.configured = configured; account.source = source || account.source; } await this.save();
  }
  async disconnect(id: string) {
    const account = this.record(id);
    if (account.provider === 'antigravity') {
      await rm(join(this.googleProfile(id), 'antigravity-acp/acp_token.json'), { force: true });
      await saveJson(join(this.googleProfile(id), 'status.json'), { signedIn: false });
    } else {
      const runtime = account.id.startsWith('default:') ? this.primary : this.runtimes.get(id); await runtime?.logout(account.provider);
    }
    account.configured = false; await this.save();
  }
  save() { const snapshot = structuredClone(this.records); this.writes = this.writes.catch(() => {}).then(() => saveJson(join(this.directory, 'accounts.json'), snapshot)); return this.writes; }
}
