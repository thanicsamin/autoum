// Conversation ownership outlives an individual command, but ends on Stop/finish.
export type BrowserScope = { closed: boolean };
type Connection = { owners: Set<BrowserScope>; ready: Promise<void>; closing?: Promise<void> };
export class BrowserConnections {
  private scopes = new Map<string | undefined, BrowserScope>();
  private connections = new Map<number, Connection>();
  constructor(private debuggerApi: Pick<typeof chrome.debugger, 'attach' | 'detach' | 'sendCommand'>) {}
  scope(chatId?: string) {
    let scope = this.scopes.get(chatId);
    if (!scope) { scope = { closed: false }; this.scopes.set(chatId, scope); }
    return scope;
  }
  check(scope: BrowserScope) { if (scope.closed) throw Error('Browser task cancelled.'); }
  forget(tabId: number) { this.connections.delete(tabId); }
  async attach(tabId: number, scope: BrowserScope): Promise<void> {
    this.check(scope);
    let connection = this.connections.get(tabId);
    if (connection?.closing) { await connection.closing; this.check(scope); return this.attach(tabId, scope); }
    if (!connection) {
      connection = { owners: new Set([scope]), ready: Promise.resolve() };
      this.connections.set(tabId, connection);
      const current = connection;
      current.ready = (async () => {
        let attached = false;
        try {
          await this.debuggerApi.attach({ tabId }, '1.3'); attached = true;
          if (!current.owners.size) return;
          await this.debuggerApi.sendCommand({ tabId }, 'Page.enable');
          if (current.owners.size) await this.debuggerApi.sendCommand({ tabId }, 'Runtime.enable');
        } catch (error) {
          if (attached) await this.debuggerApi.detach({ tabId }).catch(() => {});
          throw error;
        }
      })();
      // A failed attachment must not become a permanently cached connection.
      void current.ready.catch(() => { if (this.connections.get(tabId) === current && !current.closing) this.connections.delete(tabId); });
    } else connection.owners.add(scope);
    await connection.ready; this.check(scope);
    if (this.connections.get(tabId) !== connection) throw Error('Browser debugger disconnected.');
  }
  async command(tabId: number, scope: BrowserScope, method: string, params?: any): Promise<any> {
    this.check(scope);
    if (!this.connections.get(tabId)?.owners.has(scope)) throw Error('Browser debugger disconnected.');
    const result = await this.debuggerApi.sendCommand({ tabId }, method, params);
    this.check(scope); return result;
  }
  async release(chatId?: string) {
    const released = chatId === undefined ? [...this.scopes.values()] : [this.scopes.get(chatId)].filter((s): s is BrowserScope => !!s);
    for (const scope of released) scope.closed = true;
    if (chatId === undefined) this.scopes.clear(); else this.scopes.delete(chatId);
    const tasks: Promise<void>[] = [];
    for (const [tabId, connection] of this.connections) {
      for (const scope of released) connection.owners.delete(scope);
      if (connection.owners.size) continue;
      if (!connection.closing) connection.closing = (async () => {
        await connection.ready.catch(() => {});
        await this.debuggerApi.detach({ tabId }).catch(() => {});
        if (this.connections.get(tabId) === connection) this.connections.delete(tabId);
      })();
      tasks.push(connection.closing);
    }
    await Promise.all(tasks);
  }
}
