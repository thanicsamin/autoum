import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const run = (file: string, args: string[], signal?: AbortSignal) => exec(file, args, { signal, timeout: 30000, maxBuffer: 1000000, windowsHide: true });
const ps = (source: string, signal?: AbortSignal) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], signal);
const psText = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
const has = async (binary: string) => {
  for (const folder of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) if (await access(join(folder, binary)).then(() => true).catch(() => false)) return true;
  return false;
};
export async function computerStatus() {
  return { platform: process.platform, session: process.env.XDG_SESSION_TYPE,
    screenshot: process.platform !== 'linux' || await has('spectacle') || await has('import'),
    pointer: process.platform === 'win32' || process.platform === 'darwin' && await has('cliclick') || process.platform === 'linux' && await has('xdotool'),
    keyboard: process.platform !== 'linux' || await has('xdotool'),
    note: process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' ? 'xdotool can control XWayland applications only. Browser tools work across the whole browser. Native Wayland desktop input needs a user-installed compositor integration through Pi extensions.' : process.platform === 'darwin' ? 'Desktop input requires macOS Accessibility permission; screenshots require Screen Recording permission. Install cliclick for pointer actions.' : 'Desktop tools operate the current interactive user session; elevated applications may require OS permission.' };
}
export const computerSchema = Type.Object({ action: Type.Union(['status', 'screenshot', 'click', 'type', 'key', 'scroll'].map(x => Type.Literal(x))),
  x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), text: Type.Optional(Type.String()), key: Type.Optional(Type.String()), deltaY: Type.Optional(Type.Number()) });
export function computerTool(): ToolDefinition {
  return { name: 'computer', label: 'Computer', parameters: computerSchema,
    description: 'Inspect desktop capabilities, capture the real screen, or use the mouse/keyboard in other applications. Check status first. Prefer browser tools for browser tabs. screenshot coordinates are scaled; its details include original dimensions where known. OS permissions and Wayland limitations apply. click needs x/y in actual desktop pixels; type needs exact text; key uses combinations such as Ctrl+L or Enter; scroll needs deltaY. Files and shell are available through other tools.',
    execute: async (_id, args: any, signal) => {
      if (args.action === 'status') { const status = await computerStatus(); return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status }; }
      if (args.action === 'screenshot') {
        const folder = await mkdtemp(join(tmpdir(), 'autoum-screen-')); const png = join(folder, 'screen.png'), jpeg = join(folder, 'screen.jpg');
        try {
          if (process.platform === 'win32') await ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object Drawing.Bitmap($r.Width,$r.Height); $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size); $b.Save(${psText(jpeg)},[Drawing.Imaging.ImageFormat]::Jpeg); $g.Dispose(); $b.Dispose()`, signal);
          else if (process.platform === 'darwin') { await run('screencapture', ['-x', '-t', 'jpg', jpeg], signal); await run('sips', ['-Z', '1600', jpeg], signal); }
          else {
            if (await has('spectacle')) await run('spectacle', ['-b', '-n', '-o', png], signal);
            else await run('import', ['-window', 'root', png], signal);
            await run('convert', [png, '-resize', '1600x1600>', '-quality', '65', jpeg], signal);
          }
          const bytes = await readFile(jpeg); if (bytes.length > 700000) throw Error('Desktop screenshot is too large. Use a browser screenshot or capture a smaller region with the shell.');
          return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' }], details: { scaledMaxDimension: process.platform === 'win32' ? undefined : 1600 } };
        } finally { await rm(folder, { recursive: true, force: true }); }
      }
      if (args.action === 'click' && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) throw Error('Supply real desktop coordinates.');
      if (args.action === 'type' && (typeof args.text !== 'string' || args.text.length > 10000)) throw Error('Supply at most 10,000 characters.');
      if (args.action === 'scroll' && (!Number.isFinite(args.deltaY) || Math.abs(args.deltaY) > 10000)) throw Error('Supply a bounded scroll delta.');
      if (process.platform === 'linux') {
        if (args.action === 'click') await run('xdotool', ['mousemove', '--sync', String(Math.round(args.x)), String(Math.round(args.y)), 'click', '1'], signal);
        else if (args.action === 'type') await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', args.text], signal);
        else if (args.action === 'key') await run('xdotool', ['key', '--clearmodifiers', '--', String(args.key).replace('Control+', 'ctrl+').replace('Ctrl+', 'ctrl+').replace('Enter', 'Return')], signal);
        else if (args.action === 'scroll') await run('xdotool', ['click', '--repeat', String(Math.min(30, Math.ceil(Math.abs(args.deltaY) / 100))), args.deltaY > 0 ? '5' : '4'], signal);
        else throw Error('Unknown computer action.');
      } else if (process.platform === 'darwin') {
        if (args.action === 'click') await run('cliclick', [`c:${Math.round(args.x)},${Math.round(args.y)}`], signal);
        else if (args.action === 'type') await run('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(args.text)}`], signal);
        else if (args.action === 'key') {
          const parts = String(args.key).split('+'), key = parts.pop()!;
          const codes: Record<string, number> = { Enter: 36, Tab: 48, Escape: 53, Backspace: 51, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126 };
          const modifiers = parts.map(p => ({ Ctrl: 'control down', Control: 'control down', Meta: 'command down', Command: 'command down', Shift: 'shift down', Alt: 'option down' })[p]).filter(Boolean);
          await run('osascript', ['-e', `tell application "System Events" to ${codes[key] !== undefined ? `key code ${codes[key]}` : `keystroke ${JSON.stringify(key)}`}${modifiers.length ? ` using {${modifiers.join(',')}}` : ''}`], signal);
        } else throw Error('Use cliclick or an installed Pi integration for desktop scrolling on macOS.');
      } else if (process.platform === 'win32') {
        if (args.action === 'click' || args.action === 'scroll') {
          const setup = `Add-Type 'using System; using System.Runtime.InteropServices; public class AutoumInput { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,UIntPtr e); }'; `;
          await ps(setup + (args.action === 'click' ? `[AutoumInput]::SetCursorPos(${Math.round(args.x)},${Math.round(args.y)}) | Out-Null; [AutoumInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [AutoumInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)` : `[AutoumInput]::mouse_event(2048,0,0,${-Math.round(args.deltaY)},[UIntPtr]::Zero)`), signal);
        } else {
          const keys: Record<string, string> = { Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}', Backspace: '{BACKSPACE}', Delete: '{DELETE}', ArrowDown: '{DOWN}', ArrowUp: '{UP}', ArrowLeft: '{LEFT}', ArrowRight: '{RIGHT}' };
          const parts = String(args.key || '').split('+'), key = parts.pop()!;
          const text = args.action === 'type' ? args.text.replace(/[+^%~(){}[\]]/g, (c: string) => `{${c}}`) : parts.map(p => ({ Ctrl: '^', Control: '^', Shift: '+', Alt: '%' })[p] || '').join('') + (keys[key] || key);
          await ps(`Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.SendKeys]::SendWait(${psText(text)})`, signal);
        }
      } else throw Error('Unsupported desktop platform.');
      return { content: [{ type: 'text', text: 'Desktop input dispatched. Capture the screen or inspect the result to verify it.' }], details: {} };
    },
  };
}
