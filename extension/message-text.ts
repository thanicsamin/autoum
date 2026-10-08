type Call = (type: string, data: any) => Promise<any>;

export async function loadMessageText(chatId: string, index: number, call: Call): Promise<string> {
  const chunks: string[] = []; let offset = 0, total: number | undefined;
  for (;;) {
    const chunk = await call('message_text', { chatId, index, offset });
    if (typeof chunk?.text !== 'string' || !Number.isSafeInteger(chunk.total) || chunk.total < 0 || (total !== undefined && chunk.total !== total)) throw Error('The reply changed while loading. Try again.');
    total = chunk.total;
    const end = offset + chunk.text.length;
    if (end > chunk.total || (chunk.next === null ? end !== chunk.total : !chunk.text.length || chunk.next !== end || end >= chunk.total)) throw Error('The reply could not be loaded completely. Try again.');
    chunks.push(chunk.text);
    if (chunk.next === null) return chunks.join('');
    offset = end;
  }
}
