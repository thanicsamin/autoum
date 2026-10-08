import { test } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { parseMarkdown, renderMarkdown } from '../extension/markdown.ts';
test('Markdown math supports common delimiters, fractions, matrices, lists and tables', () => {
  const text = String.raw`# Math

Inline $x^2$ and \(\frac{a}{b}\).

$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$

\[\int_0^1 x\,dx=\frac12\]

| Name | Value |
| --- | --- |
| term | $y_i$ |

- **Bold** and *italic*`;
  const parsed = parseMarkdown(text); assert.equal(parsed.math.size, 5);
  const html = renderMarkdown(text, h => h); assert.match(html, /<h1>Math/); assert.match(html, /<table>/); assert.match(html, /class="katex-display"/); assert.match(html, /<math /); assert.doesNotMatch(html, /data-autoum-math/);
});
test('Math never consumes code, escaped dollars, prices or raw HTML attributes', () => {
  const text = 'Costs $49 and another $79. \\$5. `\\(x\\) $y$`\n\n```latex\n$$z$$\n```\n\n<span title="$unsafe$">text</span>\n\nMath $5$ and $a_1$.';
  const parsed = parseMarkdown(text); assert.equal(parsed.math.size, 2); assert.match(parsed.html, /\$49 and another \$79/); assert.match(parsed.html, /<code class="language-latex">\$\$z\$\$/); assert.match(parsed.html, /title="\$unsafe\$"/);
});
test('Invalid, unfinished, huge and hostile LaTeX remains readable and cannot inject HTML', () => {
  const html = renderMarkdown(String.raw`$\frac{1$ and $\href{javascript:alert(1)}{click}$ and $\htmlStyle{position:fixed}{oops}$ and $\def\a{\a}\a$`, h => h);
  assert.match(html, /katex-error/); assert.doesNotMatch(html, /<a |style="[^"]*position:fixed|onclick=/);
  assert.doesNotThrow(() => renderMarkdown('Streaming \\(\\frac{x', h => h));
  const first = parseMarkdown('$x$'), second = parseMarkdown('$x$'); assert.notEqual([...first.math.keys()][0], [...second.math.keys()][0]);
});
test('Repeated streamed formulas reuse layout while every message still sanitizes its own HTML', t => {
  const source = 'x_{' + crypto.randomUUID().replaceAll('-', '') + '}';
  const render = t.mock.method(katex, 'renderToString');
  let sanitizations = 0;
  const sanitize = (html: string) => { sanitizations++; return html.replace(/<script>[\s\S]*?<\/script>/g, ''); };
  const inline = renderMarkdown(`$${source}$ and $${source}$`, sanitize);
  const second = renderMarkdown(`<script>malicious()</script>\n\n$${source}$`, sanitize);
  assert.equal(render.mock.callCount(), 1, 'Identical formula layout should be computed only once');
  assert.deepEqual(render.mock.calls[0].arguments[1], { displayMode: false, output: 'htmlAndMathml', trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 10 });
  assert.equal(sanitizations, 2); assert.match(inline, /class="katex"/); assert.doesNotMatch(second, /malicious|<script>/);
  renderMarkdown(`$$${source}$$`, sanitize);
  assert.equal(render.mock.callCount(), 2, 'Inline and display layouts must remain separate');
  assert.match(renderMarkdown(`$$${source}$$`, sanitize), /katex-display/); assert.equal(render.mock.callCount(), 2);
});
test('Formula reuse is bounded and oversized layouts are not retained', t => {
  const prefix = crypto.randomUUID().replaceAll('-', '');
  // Tiny layouts keep this case below the character budget, isolating entry eviction.
  const render = t.mock.method(katex, 'renderToString', () => '<span>layout</span>');
  renderMarkdown(`$x_{${prefix}0}$`, h => h);
  for (let i = 1; i <= 150; i++) renderMarkdown(`$x_{${prefix}${i}}$`, h => h);
  assert.equal(render.mock.callCount(), 151);
  renderMarkdown(`$x_{${prefix}150}$`, h => h); assert.equal(render.mock.callCount(), 151, 'Recent formula stays reusable');
  renderMarkdown(`$x_{${prefix}0}$`, h => h); assert.equal(render.mock.callCount(), 152, 'Old layout must be evicted');
  render.mock.restore();
  const large = t.mock.method(katex, 'renderToString', () => 'x'.repeat(300_000));
  for (let i = 0; i < 3; i++) renderMarkdown(`$x_{oversized${prefix}}$`, h => h);
  assert.equal(large.mock.callCount(), 3, 'Oversized formula output must not be cached');
});
test('Formula layouts also obey the total character budget and escape renderer failures', t => {
  const prefix = crypto.randomUUID().replaceAll('-', '');
  const render = t.mock.method(katex, 'renderToString', () => 'x'.repeat(150_000));
  renderMarkdown(`$x_{${prefix}a}$`, h => h); renderMarkdown(`$x_{${prefix}b}$`, h => h);
  renderMarkdown(`$x_{${prefix}b}$`, h => h); assert.equal(render.mock.callCount(), 2);
  renderMarkdown(`$x_{${prefix}a}$`, h => h); assert.equal(render.mock.callCount(), 3, 'Combined layouts must evict even below the entry limit');
  render.mock.restore();
  t.mock.method(katex, 'renderToString', () => { throw Error('Incomplete math'); });
  const html = renderMarkdown(`$x_{${prefix}}<img src=x onerror="boom">&$`, h => h);
  assert.doesNotMatch(html, /<img|onerror="/); assert.match(html, /&lt;img/); assert.match(html, /&amp;/);
});
test('Removed math placeholders do no layout work and user-made placeholders never receive formulas', t => {
  const source = 'x_{' + crypto.randomUUID().replaceAll('-', '') + '}';
  const render = t.mock.method(katex, 'renderToString');
  const html = renderMarkdown(`<span data-autoum-math="forged"></span>\n\n$${source}$`, h => h.replace(/<span data-autoum-math="autoum-math-[^"]+"><\/span>/g, ''));
  assert.equal(render.mock.callCount(), 0, 'Sanitized-away placeholders must not compute unused layout');
  assert.match(html, /data-autoum-math="forged"/); assert.doesNotMatch(html, /class="katex"/);
  assert.doesNotMatch(renderMarkdown(`$${source}$ and $${source}$`, h => h), /data-autoum-math/);
  assert.equal(render.mock.callCount(), 1);
});
