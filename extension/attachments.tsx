import React, { useEffect, useState } from 'react';
type Call = (type: string, data?: any) => Promise<any>;
export type Attachment = { id: string; name: string; mimeType: string; size: number; path?: string };
export async function uploadAttachment(file: File, chatId: string, call: Call) {
  if (!file.size || file.size > 20 * 1024 * 1024) throw Error('Attach a file up to 20 MB.');
  const { id } = await call('attachment_start', { chatId, name: file.name || 'pasted-image.png', mimeType: file.type, size: file.size });
  try {
    for (let offset = 0; offset < file.size; offset += 240000) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 240000).arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      await call('attachment_chunk', { chatId, id, offset, data: btoa(binary) });
    }
    return await call('attachment_finish', { chatId, id }) as Attachment;
  } catch (error) { await call('attachment_cancel', { chatId, id }).catch(() => {}); throw error; }
}
export function FileAttachment({ item, chatId, call, remove }: { item: Attachment; chatId: string; call: Call; remove?: () => void }) {
  const [url, setUrl] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, objectUrl = '';
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType)) void (async () => {
      try {
        const chunks: Uint8Array[] = []; let offset: number | null = 0;
        while (offset !== null && !cancelled) { const r = await call('attachment_preview', { chatId, id: item.id, offset }); const binary = atob(r.data); chunks.push(Uint8Array.from(binary, c => c.charCodeAt(0))); offset = r.next; }
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: item.mimeType })); setUrl(objectUrl);
      } catch (e: any) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [chatId, item.id]);
  return <div className={'file-attachment ' + (remove ? 'draft-attachment' : '')}>{url && <button className="image-preview" title={'Open ' + item.name} onClick={() => call('attachment_open', { chatId, id: item.id }).catch(e => setError(e.message))}><img src={url} alt={item.name} /></button>}<button className="attachment-link" onClick={() => call('attachment_open', { chatId, id: item.id }).catch(e => setError(e.message))} title={item.path}><span>{item.name}</span><small>{item.size >= 1024 * 1024 ? (item.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.ceil(item.size / 1024)) + ' KB'}</small></button>{remove && <button className="attachment-remove" aria-label={'Remove attachment ' + item.name} onClick={remove}>×</button>}{error && <small className="error">{error}</small>}</div>;
}
