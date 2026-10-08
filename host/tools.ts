import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { NativeTransport } from './protocol.ts';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
export const browserSchema = Type.Object({
  action: Type.Union(['tabs', 'open', 'navigate', 'close', 'activate', 'back', 'forward', 'reload', 'snapshot', 'screenshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'upload', 'download', 'downloads', 'inspect', 'dialog'].map(x => Type.Literal(x))),
  active: Type.Optional(Type.Boolean()), tabId: Type.Optional(Type.Number()), url: Type.Optional(Type.String()), selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()), key: Type.Optional(Type.String()), expression: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()),
  paths: Type.Optional(Type.Array(Type.String())), filename: Type.Optional(Type.String()),
  accept: Type.Optional(Type.Boolean()), promptText: Type.Optional(Type.String()), frameId: Type.Optional(Type.String()),
});
export function browserTool(transport: NativeTransport, chatId: string): ToolDefinition {
  return {
    name: 'browser', label: 'Browser', parameters: browserSchema,
    description: `Control the user's real browser tabs, including file:// HTML explainers. tabs lists IDs. snapshot returns page text and interactive element selectors (including frames). Use tabs and an explicit tabId to read the user's current page when asked, then open your own background research tabs. New tabs and research popups stay in the collapsed Autoum group without taking focus. Keep using their tabIds; without a tabId, subsequent actions target this chat's latest research tab. Do not navigate, close or otherwise change the user's unrelated tabs. activate cannot bring research into the foreground; research_report opens the finished deliverable for the viewer. screenshot is visual. click uses selector or x/y; type fills selector; press uses key; scroll uses deltas. evaluate runs JavaScript with full page access (use only when needed). upload sets an input[type=file] to absolute paths. download saves url to Downloads. inspect describes the target before a mutation. dialog handles alerts/confirm/prompts. open/navigate support http, https and file URLs. PDFs can be downloaded and read with computer tools.`,
    execute: async (_id, args: any, signal) => {
      const result = await transport.request('browser', { ...args, chatId, viewer: false }, signal);
      if (result.image) return { content: [{ type: 'image' as const, data: result.image, mimeType: 'image/jpeg' }], details: { tabId: result.tabId } };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
export function directoryTool(cwd: string): ToolDefinition {
  return { name: 'list_directory', label: 'Files', description: 'List real folders, including Downloads. Absolute paths are supported.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async (_id, args: any) => {
      const path = resolve(cwd, args.path || '.'); const entries = await readdir(path, { withFileTypes: true });
      const files = await Promise.all(entries.slice(0, 500).map(async e => ({ name: e.name, directory: e.isDirectory(), size: e.isFile() ? (await stat(resolve(path, e.name))).size : undefined })));
      return { content: [{ type: 'text', text: JSON.stringify({ path, files }) }], details: {} };
    },
  };
}
