type Snapshot = { text: string; timer?: ReturnType<typeof setTimeout> };

export class ChatExports {
  private entries = new Map<string, Snapshot>();
  private closed = false;
  constructor(private idleMs = 120000) {}
  cancel(id: string) {
    const entry = this.entries.get(id); if (!entry) return false;
    clearTimeout(entry.timer); this.entries.delete(id); return true;
  }
  read(input: { offset?: number; exportId?: string }, snapshot: () => any) {
    if (this.closed) throw Error('Chat export has closed.');
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid export offset.');
    let id = input.exportId, entry: Snapshot;
    if (id === undefined) {
      if (offset !== 0) throw Error('Start the chat export again.');
      if (this.entries.size >= 2) throw Error('Finish the current exports before starting another.');
      id = crypto.randomUUID(); entry = { text: JSON.stringify(snapshot(), null, 2) };
    } else {
      if (typeof id !== 'string' || !this.entries.has(id)) throw Error('This export expired. Start it again.');
      entry = this.entries.get(id)!;
    }
    if (offset > entry.text.length) throw Error('Invalid export offset.');
    const text = entry.text.slice(offset, offset + 100000), end = offset + text.length;
    const next = end < entry.text.length ? end : null;
    clearTimeout(entry.timer);
    if (next === null) this.entries.delete(id);
    else {
      entry.timer = setTimeout(() => this.cancel(id!), this.idleMs); entry.timer.unref();
      this.entries.set(id, entry);
    }
    return { text, next, total: entry.text.length, exportId: id };
  }
  close() { this.closed = true; for (const id of this.entries.keys()) this.cancel(id); }
}
