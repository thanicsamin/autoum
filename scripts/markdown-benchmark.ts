import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { renderMarkdown } from '../extension/markdown.ts';

const text = Array.from({ length: 80 }, (_, i) => `## Finding ${i + 1}\n\nThe example uses $x^2+y^2=z^2$ and $\\frac{a}{b}$. Read the linked evidence carefully.\n\n- [Source](https://example.test/${i})\n\n`).join('');
const times: number[] = []; let html = '';
for (let end = 24; end < text.length + 24; end += 24) {
  const start = performance.now(); html = renderMarkdown(text.slice(0, end), h => h); times.push(performance.now() - start);
}
assert.match(html, /class="katex"/); assert.equal((html.match(/<h2>/g) || []).length, 80);
const sorted = times.slice().sort((a, b) => a - b);
const result = { fixture: '80 short findings with two equations; 24-character deltas', characters: text.length, renders: times.length, totalLocalRenderMs: +times.reduce((a, b) => a + b, 0).toFixed(2), medianRenderMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95RenderMs: +sorted[Math.floor(sorted.length * .95)].toFixed(2), maxRenderMs: +sorted.at(-1)!.toFixed(2), finalKatexPresent: true, sanitizerIncluded: false, browserDomIncluded: false, providerLatencyIncluded: false };
await writeFile(process.argv[2] || 'test-results/stream-render-after-2026-10-06.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
