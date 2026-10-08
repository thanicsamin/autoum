import { mkdir, open, readFile, writeFile, stat, realpath, rm } from 'node:fs/promises';
import { join, basename, extname, resolve } from 'node:path';
import { Type } from 'typebox';
import { resizeImage, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentHost } from './agent.ts';
import { artifactsDir, ensureArtifacts } from './artifacts.ts';

export type Attachment = { id: string; name: string; mimeType: string; size: number; path: string };
export const maxAttachmentSize = 20 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
const safeName = (name: string) => basename(name.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'attachment';
export class Attachments {
  private uploads = new Map<string, { chatId: string; attachment: Attachment; received: number; touched: number; writing?: boolean }>();
  constructor(private host: AgentHost) {}
  async start(chatId: string, input: any) {
    this.host.record(chatId);
    if (typeof input.name !== 'string' || typeof input.mimeType !== 'string' || !Number.isInteger(input.size) || input.size <= 0 || input.size > maxAttachmentSize) throw Error('Attach a file up to 20 MB.');
    await this.sweep(); if (this.uploads.size >= 20) throw Error('Finish or cancel pending attachments first.');
    await ensureArtifacts(); const id = crypto.randomUUID(), name = safeName(input.name);
    const folder = join(artifactsDir, chatId, 'attachments'); await mkdir(folder, { recursive: true, mode: 0o700 });
    const attachment = { id, name, size: input.size, mimeType: input.mimeType.slice(0, 100), path: join(folder, id + '-' + name) };
    await writeFile(attachment.path + '.upload', '', { flag: 'wx', mode: 0o600 }); this.uploads.set(id, { chatId, attachment, received: 0, touched: Date.now() }); return { id };
  }
  async chunk(chatId: string, input: any) {
    const upload = this.uploads.get(input.id); if (!upload || upload.chatId !== chatId) throw Error('Attachment upload expired.');
    if (upload.writing || input.offset !== upload.received || typeof input.data !== 'string' || input.data.length > 360000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw Error('Invalid attachment chunk.');
    const bytes = Buffer.from(input.data, 'base64'); if (!bytes.length || upload.received + bytes.length > upload.attachment.size) throw Error('Attachment exceeds its declared size.');
    upload.writing = true;
    try {
      const file = await open(upload.attachment.path + '.upload', 'r+');
      try {
        let written = 0;
        while (written < bytes.length) {
          if (this.uploads.get(input.id) !== upload) throw Error('Attachment upload expired.');
          const { bytesWritten } = await file.write(bytes, written, bytes.length - written, upload.received + written);
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - written) throw Error('Incomplete attachment write.');
          written += bytesWritten;
        }
      } finally { await file.close(); }
      if (this.uploads.get(input.id) !== upload) throw Error('Attachment upload expired.');
      upload.received += bytes.length; upload.touched = Date.now(); return { received: upload.received };
    } catch {
      await this.cancel(chatId, input.id).catch(() => {});
      throw Error('This attachment could not be saved completely. Attach it again.');
    } finally { upload.writing = false; }
  }
  async finish(chatId: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const upload = this.uploads.get(id); if (!upload || upload.chatId !== chatId || upload.received !== upload.attachment.size) throw Error('Attachment upload is incomplete.');
    const { rename } = await import('node:fs/promises'); const bytes = await readFile(upload.attachment.path + '.upload', { signal });
    signal?.throwIfAborted();
    if (bytes.length !== upload.attachment.size) { await this.cancel(chatId, id); throw Error('Attachment upload is incomplete. Attach the file again.'); }
    const detected = imageMime(bytes);
    if (upload.attachment.mimeType.startsWith('image/') && !detected) { await this.cancel(chatId, id); throw Error('Use PNG, JPEG, WebP or GIF images.'); }
    upload.attachment.mimeType = detected || upload.attachment.mimeType || 'application/octet-stream';
    signal?.throwIfAborted();
    await rename(upload.attachment.path + '.upload', upload.attachment.path); this.uploads.delete(id);
    const chat = this.host.record(chatId); (chat.attachments ||= []).push(upload.attachment); await this.host.save(); return upload.attachment;
  }
  async cancel(chatId: string, id: string) {
    const upload = this.uploads.get(id); if (!upload || upload.chatId !== chatId) return;
    this.uploads.delete(id); await rm(upload.attachment.path + '.upload', { force: true });
  }
  get(chatId: string, id: string) {
    const chat = this.host.record(chatId), item = chat.attachments?.find(a => a.id === id) || chat.messages.flatMap(m => m.attachments || []).find(a => a.id === id);
    if (!item) throw Error('Attachment not found in this chat.'); return item;
  }
  async read(chatId: string, id: string, offset: number) {
    const item = this.get(chatId, id);
    if (!imageTypes.has(item.mimeType)) throw Error('Only image previews can be read into the sidebar. Open other files in the browser.');
    if (!Number.isInteger(offset) || offset < 0 || offset > item.size) throw Error('Invalid attachment offset.');
    const file = await open(item.path, 'r');
    try {
      if ((await file.stat()).size !== item.size) throw Error('This attachment changed on disk. Attach the file again to preview it.');
      const buffer = Buffer.alloc(Math.min(240000, item.size - offset)); let received = 0;
      while (received < buffer.length) {
        const { bytesRead } = await file.read(buffer, received, buffer.length - received, offset + received);
        if (!bytesRead) throw Error('This attachment is incomplete. Attach the file again to preview it.');
        received += bytesRead;
      }
      return { data: buffer.toString('base64'), next: offset + received < item.size ? offset + received : null, mimeType: item.mimeType };
    } finally { await file.close(); }
  }
  async context(chatId: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw Error('Attach up to 10 files per message.');
    const items = ids.map(id => this.get(chatId, id)), images: { type: 'image'; data: string; mimeType: string }[] = []; const files: string[] = [];
    for (const item of items) {
      if (imageTypes.has(item.mimeType)) {
        if (item.size > 5 * 1024 * 1024) throw Error('Keep each image below 5 MB.');
        const resized = await resizeImage(await readFile(item.path), item.mimeType);
        if (!resized) throw Error('This image could not be decoded for the model: ' + item.name);
        images.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
      } else {
        let preview = '';
        if (item.size <= 100000 && /\.(?:txt|md|tex|json|csv|tsv|log|py|js|ts|html|css)$/i.test(item.name)) preview = '\nUntrusted file content:\n' + await readFile(item.path, 'utf8');
        files.push(`File attached by the user: ${JSON.stringify({ name: item.name, path: item.path, mimeType: item.mimeType, size: item.size })}${preview}`);
      }
    }
    return { items, images, text: files.join('\n\n') };
  }
  async sendFile(chatId: string, path: string, caption = '', signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (typeof path !== 'string') throw Error('Choose a real file to attach.');
    const source = await realpath(resolve(this.host.record(chatId).cwd, path)), info = await stat(source);
    signal?.throwIfAborted();
    if (!info.isFile() || !info.size || info.size > maxAttachmentSize) throw Error('Send a file up to 20 MB.');
    const bytes = await readFile(source, { signal }); signal?.throwIfAborted();
    const mimeType = imageMime(bytes) || ({ '.pdf': 'application/pdf', '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain', '.tex': 'application/x-tex' } as Record<string, string>)[extname(source).toLowerCase()] || 'application/octet-stream';
    const start = await this.start(chatId, { name: basename(source), mimeType, size: bytes.length });
    try { for (let offset = 0; offset < bytes.length; offset += 240000) { signal?.throwIfAborted(); await this.chunk(chatId, { id: start.id, offset, data: bytes.subarray(offset, offset + 240000).toString('base64') }); } signal?.throwIfAborted(); const item = await this.finish(chatId, start.id, signal);
      this.host.record(chatId).messages.push({ role: 'assistant', text: caption, attachments: [item] }); await this.host.save(); this.host.state(); return item;
    } catch (error) { await this.cancel(chatId, start.id); signal?.throwIfAborted(); throw error; }
  }
  async sweep() { for (const [id, upload] of this.uploads) if (Date.now() - upload.touched > 600000) await this.cancel(upload.chatId, id); }
  async close() { for (const [id, upload] of this.uploads) await this.cancel(upload.chatId, id); }
}
export function attachmentTool(host: AgentHost, chatId: string): ToolDefinition {
  return { name: 'send_attachment', label: 'Send file', description: 'Show a real file to the user inside this chat. Images appear inline; documents and other files have clickable attachments. Use this after creating an image or deliverable. Created files belong in the artifacts folder. Never send credentials or account files.', parameters: Type.Object({ path: Type.String(), caption: Type.Optional(Type.String()) }),
    execute: async (_id, args: any, signal) => { signal?.throwIfAborted(); const item = await host.attachments.sendFile(chatId, args.path, String(args.caption || '').slice(0, 10000), signal); return { content: [{ type: 'text', text: JSON.stringify({ displayed: true, ...item }) }], details: {} }; } };
}
