type Call = (type: string, data: any) => Promise<any>;

export async function loadChatExport(call: Call): Promise<string> {
  const chunks: string[] = []; let offset = 0, exportId: string | undefined, total: number | undefined;
  try {
    for (;;) {
      const chunk = await call('export_data', { offset, exportId });
      if (typeof chunk?.exportId !== 'string' || !chunk.exportId || (exportId !== undefined && exportId !== chunk.exportId)) throw Error('The export changed while loading. Try again.');
      exportId = chunk.exportId;
      if (typeof chunk.text !== 'string' || !Number.isSafeInteger(chunk.total) || chunk.total < 0 || (total !== undefined && total !== chunk.total)) throw Error('The export changed while loading. Try again.');
      total = chunk.total; const end = offset + chunk.text.length;
      if (end > chunk.total || (chunk.next === null ? end !== chunk.total : !chunk.text.length || chunk.next !== end || end >= chunk.total)) throw Error('The export could not be loaded completely. Try again.');
      chunks.push(chunk.text);
      if (chunk.next === null) {
        const text = chunks.join(''), data = JSON.parse(text);
        if (!data || !Array.isArray(data.chats) || !Array.isArray(data.folders)) throw Error('The export could not be loaded completely. Try again.');
        return text;
      }
      offset = end;
    }
  } catch (error) {
    if (exportId) await call('export_cancel', { exportId }).catch(() => {});
    throw error;
  }
}
