import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'autoum-report-suite-')); process.env.AUTOUM_DATA_DIR = directory; process.env.AUTOUM_ARTIFACTS_DIR = join(directory, 'artifacts');
const { researchHtml, researchTool, researchInstructions, withReportMath } = await import('../host/research.ts'); after(() => rm(directory, { recursive: true, force: true }));
test('fast report boilerplate safely renders linked lists, useful details and filtering without remote assets', () => {
  const html = researchHtml({ title: '<script>bad</script>', summary: 'Summary', items: [{ title: 'Job', url: 'https://example.test/job?q=1&x=2', text: 'Fits the resume', detail: 'Useful evidence', attributes: [{ label: 'Location', value: 'Remote' }] }] });
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;')); assert.ok(html.includes('id="filter"')); assert.ok(html.includes('Fits the resume')); assert.ok(html.includes('Useful evidence')); assert.ok(!html.includes('<details open')); assert.ok(!html.includes('src="https:'));
  assert.throws(() => researchHtml({ title: 'Bad', summary: 'Summary', items: [{ title: 'Bad', url: 'javascript:alert(1)' }] }), /web source/);
  assert.ok(researchInstructions.includes('HTML is the default format for long output')); assert.ok(researchInstructions.includes('Job searches')); assert.ok(researchInstructions.includes('shopping recommendations'));
});
test('HTML reports persist privately, open actively, reuse a file/tab for corrections and stop before writing on cancellation', async () => {
  const requests: any[] = []; let tabUrl = '', id = 7;
  const host: any = { transport: { request: async (_type: string, data: any) => { requests.push(data); if (data.action === 'tabs') return tabUrl ? [{ id, url: tabUrl }] : []; if (data.action === 'open') tabUrl = data.url; return { tabId: id }; } } };
  const chatId = crypto.randomUUID(), tool = researchTool(host, chatId), input = { title: 'Shopping brief', summary: 'Evidence', items: [{ title: 'Item', url: 'https://example.test/item', text: 'Why it fits' }] };
  const result: any = await tool.execute('test', input, undefined, undefined, {} as any); assert.ok(result.details.saved && result.details.opened); assert.ok(requests.some(r => r.action === 'open' && r.active === true));
  assert.ok((await readFile(join(directory, 'artifacts/_assets/katex/autoum-math.js'), 'utf8')).includes("trust:false"));
  const path = result.details.path; assert.ok((await readFile(path, 'utf8')).includes('Why it fits'));
  const updated: any = await tool.execute('test', { ...input, reportId: result.details.reportId, summary: 'Corrected evidence' }, undefined, undefined, {} as any);
  assert.equal(updated.details.path, path); assert.equal(requests.filter(r => r.action === 'open').length, 1); assert.ok(requests.some(r => r.action === 'reload')); assert.ok(requests.some(r => r.action === 'activate')); assert.ok((await readFile(path, 'utf8')).includes('Corrected evidence'));
  const requestCount = requests.length;
  const saved: any = await tool.execute('test', { ...input, open: false }, undefined, undefined, {} as any);
  assert.equal(saved.details.opened, false); assert.equal(requests.length, requestCount); assert.ok((await readFile(saved.details.path, 'utf8')).includes('Why it fits'));
  const controller = new AbortController(); controller.abort(); await assert.rejects(tool.execute('test', input, controller.signal, undefined, {} as any));
  await assert.rejects(tool.execute('test', { ...input, reportId: '../../outside' }, undefined, undefined, {} as any), /Invalid report/);
});

test('KaTeX assets are local, injected once into complete documents, and instructions favor simple interactive explanations', () => {
  const document = '<!doctype html><html><head><title>Math</title></head><body><p>\\(x^2\\)</p></body></html>';
  const html = withReportMath(document); assert.match(html, /<head><!-- Autoum local KaTeX -->/); assert.match(html, /_assets\/katex\/auto-render.min.js/); assert.doesNotMatch(html, /https?:/); assert.equal(withReportMath(html), html);
  assert.ok(withReportMath('<!doctype html><html lang="en"><meta charset="utf-8"><body>Text</body></html>').includes('Autoum local KaTeX'));
  assert.match(researchInstructions, /simple English/); assert.match(researchInstructions, /labeled diagrams/); assert.match(researchInstructions, /interactive elements/); assert.match(researchInstructions, /KaTeX/);
});
