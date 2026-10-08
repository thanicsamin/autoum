import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentHost } from './agent.ts';
import { mkdir, writeFile, readFile, rename, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { artifactsDir, ensureArtifacts } from './artifacts.ts';
export const researchInstructions = `HTML is the default format for long output: detailed explanations, plans, guides, reports, research, recommendations, searches that produce a useful list, comparisons, and compiled findings. Use research_report to create a concise HTML brief and open it for the viewer. Job searches based on a resume must produce an HTML job list with direct listing links and fit explanations; shopping recommendations must produce an HTML product list with purchase links and tradeoffs. Make HTML briefs the normal deliverable for these requests, even when the user does not say research. Prefer its summary, items and sections fields for fast output: use simple English wherever possible, explain jargon with concrete examples, cite source links, distinguish uncertainty, and add useful expandable details. For explainers, prefer clear labeled diagrams and useful interactive elements (sliders, reveal controls, filters, worked examples) wherever they help understanding. Use inline SVG diagrams and small local scripts rather than remote diagram libraries. KaTeX is provided automatically for math: use LaTeX inside \\( ... \\) for inline math, or \\[ ... \\] or $$ ... $$ for display math. Avoid single-dollar delimiters, which conflict with prices. Use custom html when diagrams or interactive examples help; keep the same clean, responsive Autoum visual style, readable typography, keyboard-accessible controls, and light/dark browser inheritance. Keep follow-up edits in the same reportId. Briefly confirm the saved file link. Honor requests for another format or not opening a tab. Do not run the full html-teacher tutorial workflow unless the user asks for it.`;
let mathAssets: Promise<void> | undefined; let mathRoot = '';
async function ensureMathAssets() {
  if (mathRoot !== artifactsDir) { mathAssets = undefined; mathRoot = artifactsDir; }
  mathAssets ||= (async () => {
    const source = fileURLToPath(new URL('.', import.meta.resolve('katex'))), target = join(artifactsDir, '_assets', 'katex');
    await mkdir(target, { recursive: true, mode: 0o700 });
    await Promise.all([cp(join(source, 'katex.min.css'), join(target, 'katex.min.css')), cp(join(source, 'katex.min.js'), join(target, 'katex.min.js')), cp(join(source, 'contrib/auto-render.min.js'), join(target, 'auto-render.min.js')), cp(join(source, 'fonts'), join(target, 'fonts'), { recursive: true })]);
    await writeFile(join(target, 'autoum-math.js'), String.raw`document.addEventListener('DOMContentLoaded',()=>{renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false,ignoredClasses:['no-math']});});`, { mode: 0o600 });
  })().catch(error => { mathAssets = undefined; throw error; });
  await mathAssets;
}
export function withReportMath(html: string) {
  const assets = '<!-- Autoum local KaTeX -->\n<link rel="stylesheet" href="../_assets/katex/katex.min.css"><style>.katex-display{overflow-x:auto;overflow-y:hidden;padding:.25rem 0}.katex{font-size:1.1em}</style><script defer src="../_assets/katex/katex.min.js"></script><script defer src="../_assets/katex/auto-render.min.js"></script><script defer src="../_assets/katex/autoum-math.js"></script>';
  if (html.includes('<!-- Autoum local KaTeX -->')) return html;
  return /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, head => head + assets) : html.replace(/<html(?:\s[^>]*)?>/i, head => head + assets);
}
const escape = (value: string) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function researchHtml(input: any, logo = '') {
  const sections = input.sections || [];
  if (!input.summary || !Array.isArray(sections) || !Array.isArray(input.items || []) || !(sections.length || input.items?.length) || sections.length > 30 || input.items?.length > 100) throw Error('Provide a summary with up to 30 sections or 100 linked items.');
  const sourceLink = (source: any) => { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol)) throw Error('Cite a web source URL.'); return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(source.title || url.hostname)}</a>`; };
  const items = input.items || [];
  const details = (text: string, title = 'Explore the details') => text ? `<details><summary>${escape(title)}</summary><p>${escape(text)}</p></details>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.title)}</title><style>:root{color-scheme:light dark}body{font:1.125rem/1.6 system-ui,sans-serif;margin:0;padding:clamp(1rem,5vw,4rem);background:light-dark(#faf9f6,#171b18);color:light-dark(#292e29,#e5eae1)}main{max-width:50rem;margin:auto}h1{font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.2}h2{font-size:1.35rem;margin-top:2rem}p{white-space:pre-line}a{color:light-dark(#38664e,#b1d3ba);overflow-wrap:anywhere}details{border-top:1px solid light-dark(#d5dbd4,#485147);padding:.8rem 0}summary{cursor:pointer;font-weight:600}a:focus-visible,summary:focus-visible{outline:3px solid #65a976;outline-offset:4px}.sources{display:flex;gap:1rem;flex-wrap:wrap;font-size:.9em}.meta{font-size:.85em;opacity:.7}.brand{display:flex;align-items:center;gap:.6rem}.brand svg{width:1.8rem;height:1.8rem}.filter{width:100%;font:inherit;padding:.6rem;border:1px solid light-dark(#dedfd7,#394238);background:light-dark(#fff,#202621);color:inherit;border-radius:8px;margin:1rem 0}.result{border-top:1px solid light-dark(#dedfd7,#394238);padding:.4rem 0 1rem}.attributes{display:flex;gap:1rem;flex-wrap:wrap;font-size:.9em}.attributes span{color:light-dark(#71776e,#a4ae9e)}[hidden]{display:none!important}</style><main><div class="brand">${logo}<strong>Autoum</strong><span class="meta">HTML brief</span></div><h1>${escape(input.title)}</h1><p>${escape(input.summary)}</p>${items.length ? `<label for="filter">Filter results</label><input class="filter" id="filter" type="search" placeholder="Search this list…" aria-label="Filter results"><p class="meta" id="result-count" role="status">${items.length} results</p><div id="results">${items.map((item: any) => `<article class="result"><h2>${sourceLink({ title: item.title, url: item.url })}</h2>${item.attributes?.length ? `<div class="attributes">${item.attributes.map((attribute: any) => `<div><span>${escape(attribute.label)}:</span> ${escape(attribute.value)}</div>`).join('')}</div>` : ''}<p>${escape(item.text)}</p>${details(item.detail, item.detailTitle)}</article>`).join('')}</div>` : ''}${sections.map((section: any) => `<section><h2>${escape(section.title)}</h2><p>${escape(section.text)}</p>${section.detail ? `<details><summary>${escape(section.detailTitle || 'Explore the evidence')}</summary><p>${escape(section.detail)}</p></details>` : ''}<div class="sources">${(section.sources || []).map(sourceLink).join('')}</div></section>`).join('')}<p class="meta">Saved ${new Date().toISOString().slice(0, 10)} · Sources open in a new tab.</p></main>${items.length ? `<script>document.querySelector('#filter').addEventListener('input',event=>{const query=event.target.value.toLocaleLowerCase().trim();let count=0;for(const result of document.querySelectorAll('.result')){result.hidden=!result.textContent.toLocaleLowerCase().includes(query);if(!result.hidden)count++;}document.querySelector('#result-count').textContent=count+' results';});</script>` : ''}</html>`;
}
export function researchTool(host: AgentHost, chatId: string): ToolDefinition {
  return { name: 'research_report', label: 'HTML brief', description: 'Save long output as a concise interactive HTML brief locally, open it in a visible result tab while keeping background research collapsed. Prefer summary plus items for job/product/recommendation lists with direct links, actual filterable results and fit explanations. Use sections for explanations, plans, guides and research findings. The built-in template renders instantly with sources and expandable details. KaTeX math rendering is included automatically; use LaTeX \\( \\) inline or \\[ \\] display delimiters. Favor simple English, labeled diagrams and meaningful interactions for explainers. Provide custom html with inline SVG diagrams or small interactive simulations when useful. Returns actual path, reportId and tabId for verification. Reuse reportId to edit a prior report in this chat. Set open to false only when the user requests saving without opening.',
    parameters: Type.Object({ title: Type.String(), html: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), items: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String(), text: Type.String(), detail: Type.Optional(Type.String()), detailTitle: Type.Optional(Type.String()), attributes: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))) }))), sections: Type.Optional(Type.Array(Type.Object({ title: Type.String(), text: Type.String(), detail: Type.Optional(Type.String()), detailTitle: Type.Optional(Type.String()), sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))) }))), reportId: Type.Optional(Type.String()), open: Type.Optional(Type.Boolean()) }),
    execute: async (_id, input: any, signal) => {
      signal?.throwIfAborted();
      if (input.html === undefined) input = { ...input, html: researchHtml(input, await readFile(new URL('../extension/logo.svg', import.meta.url), 'utf8')) };
      const title = String(input.title || '').trim().slice(0, 160);
      if (!title || typeof input.html !== 'string' || !/^\s*<!doctype html>/i.test(input.html) || !/<html[\s>]/i.test(input.html) || !/<\/html>\s*$/i.test(input.html)) throw Error('Provide a titled, complete HTML5 document.');
      input = { ...input, html: withReportMath(input.html) };
      if (Buffer.byteLength(input.html) > 5_000_000) throw Error('Keep the report below 5 MB.');
      const reportId = input.reportId || crypto.randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(reportId) || !/^[0-9a-f-]{36}$/i.test(chatId)) throw Error('Invalid report ID.');
      const folder = join(artifactsDir, chatId), path = join(folder, reportId + '.html'), temporary = path + '.' + crypto.randomUUID() + '.tmp';
      await ensureArtifacts();
      await ensureMathAssets(); signal?.throwIfAborted();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try { await writeFile(temporary, input.html, { mode: 0o600 }); signal?.throwIfAborted(); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
      signal?.throwIfAborted();
      if (input.open === false) { const result = { saved: true, opened: false, title, reportId, path }; return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; }
      const url = pathToFileURL(path).href;
      const tabs = await host.transport.request('browser', { chatId, action: 'tabs' }, signal);
      const existing = tabs.find((tab: any) => tab.url === url);
      let tab;
      if (existing) { await host.transport.request('browser', { chatId, action: 'reload', tabId: existing.id }, signal); tab = await host.transport.request('browser', { chatId, action: 'activate', tabId: existing.id, viewer: true }, signal); }
      else tab = await host.transport.request('browser', { chatId, action: 'open', url, active: true, viewer: true }, signal);
      const result = { saved: true, opened: true, title, reportId, path, ...tab, instruction: 'Check that the report opened correctly. For custom HTML, verify any meaningful controls.' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } };
}
