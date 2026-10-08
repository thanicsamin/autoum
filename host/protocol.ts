import { EventEmitter } from 'node:events';

export type Packet = { id?: string; reply?: string; type?: string; data?: any; error?: string };
// Chrome writes little-endian length-prefixed UTF-8 JSON. stdout is exclusively this protocol.
export class NativeTransport extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private input: NodeJS.ReadableStream, private output: NodeJS.WritableStream) {
    super(); input.on('data', (chunk: Buffer) => this.feed(chunk));
    input.on('end', () => { this.cancel(); this.emit('close'); });
  }
  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > 16 * 1024 * 1024) { this.cancel(); this.emit('error', Error('Oversized native message.')); return; }
      if (this.buffer.length < size + 4) return;
      const raw = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4);
      try {
        const packet: Packet = JSON.parse(raw.toString('utf8'));
        if (packet.reply) {
          const p = this.pending.get(packet.reply); if (!p) continue;
          if (packet.error) p.reject(Error(packet.error)); else p.resolve(packet.data);
        } else this.emit('message', packet);
      } catch (e) { this.emit('error', e); }
    }
  }
  send(packet: Packet) {
    const body = Buffer.from(JSON.stringify(packet));
    if (body.length > 1000000) throw Error('Result too large for the browser bridge. Read a smaller range.');
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    this.output.write(Buffer.concat([head, body]));
  }
  request(type: string, data: any, signal?: AbortSignal, timeoutMs = 120000): Promise<any> {
    if (signal?.aborted) return Promise.reject(Error('Cancelled.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (!this.pending.delete(id)) return false;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); return true;
      };
      const fail = (error: Error) => { if (cleanup()) reject(error); };
      const abort = () => {
        if (!cleanup()) return;
        reject(Error('Cancelled.'));
        // Cancelling must settle locally even when the browser connection cannot be written to.
        try { this.send({ type: 'interaction_cancelled', data: { id } }); } catch { /* Best effort notification. */ }
      };
      const timer = setTimeout(() => fail(Error('Browser did not respond.')), timeoutMs);
      this.pending.set(id, { resolve: v => { if (cleanup()) resolve(v); }, reject: fail, timer });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, type, data }); } catch (error) { fail(error instanceof Error ? error : Error(String(error))); }
    });
  }
  cancel() {
    for (const p of this.pending.values()) p.reject(Error('Connection closed.'));
    this.pending.clear();
  }
}
