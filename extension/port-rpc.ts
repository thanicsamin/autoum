// Each request belongs to one port; disconnects and failed sends settle it locally.
export class PortRpc {
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  constructor(private port: chrome.runtime.Port, private disconnectReason = () => 'Extension port disconnected.') {
    port.onMessage.addListener(this.receive);
    port.onDisconnect.addListener(this.disconnect);
  }
  private receive = (packet: any) => {
    if (!packet.reply) return;
    const request = this.take(packet.reply); if (!request) return;
    packet.error ? request.reject(Error(packet.error)) : request.resolve(packet.data);
  };
  private take(id: string) {
    const request = this.pending.get(id); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(id); return request;
  }
  private disconnect = () => {
    this.closed = true; const error = Error(this.disconnectReason());
    for (const id of this.pending.keys()) this.take(id)?.reject(error);
    this.port.onMessage.removeListener(this.receive); this.port.onDisconnect.removeListener(this.disconnect);
  };
  request(type: string, data?: any, timeoutMs = 600000): Promise<any> {
    if (this.closed) return Promise.reject(Error('Extension port disconnected. Reconnect to continue.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.take(id)?.reject(Error('Agent took too long to respond.')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port.postMessage({ id, type, data }); }
      catch (error) { this.take(id)?.reject(error instanceof Error ? error : Error(String(error))); }
    });
  }
}
