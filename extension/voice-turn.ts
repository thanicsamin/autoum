type Call = (type: string, data?: any) => Promise<any>;
// send acknowledges dispatch, not completion. Wait on existing state broadcasts,
// and release the owned turn immediately if its voice conversation ends.
export async function localVoiceTurn(id: string, text: string, conversation: boolean, call: Call, port: chrome.runtime.Port, signal: AbortSignal, previousMessages = 0): Promise<string | undefined> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const result = await call('send', { chatId: id, text });
  if (!conversation || result?.cancelled || !result?.started) return;
  if (signal.aborted) { await call('stop', { chatId: id }).catch(() => {}); throw new DOMException('Cancelled', 'AbortError'); }
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { finished = true; port.onMessage.removeListener(listener); signal.removeEventListener('abort', aborted); };
    const failed = (error: any) => { if (finished) return; cleanup(); reject(error); };
    const check = (state: any) => {
      if (finished) return;
      const chat = state?.chats.find((c: any) => c.id === id);
      if (!chat) { failed(Error('This voice conversation was removed.')); return; }
      if (chat.busy) return;
      if (chat.error) { failed(Error(chat.error)); return; }
      const fresh = chat.messages.slice(Math.max(0, previousMessages - (chat.historyStart || 0)));
      cleanup(); resolve(fresh.reverse().find((m: any) => m.role === 'assistant')?.text);
    };
    const listener = (packet: any) => { if (packet.type === 'state') check(packet.data); };
    const aborted = () => { if (finished) return; cleanup(); void call('stop', { chatId: id }).catch(() => {}); reject(new DOMException('Cancelled', 'AbortError')); };
    port.onMessage.addListener(listener); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else call('state').then(check, failed);
  });
}
