# Third-party components

Autoum's own source uses the MIT license. Third-party software retains its own license.

- Thorium/Chromium: upstream code and included notices are preserved. Linux/Windows product text and logo resources are adapted; the pinned unsigned Windows executable has icon resources changed, with code and layout retained. The signed macOS engine is preserved. Each modified browser has a resource hash receipt in `browser/branding.json`. Chromium uses a BSD-style license and includes many separately licensed components; consult the browser's `chrome://credits` and the upstream source notices. [Thorium source](https://github.com/Alex313031/thorium), [Chromium source/license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE). Platform source/release URLs and exact binary hashes are recorded in each bundle's `browser/upstream.json`.
- Node.js: portable unmodified Node runtime. Its complete bundled license is copied to `runtime/NODE-LICENSE`.
- Pi: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, their agent/TUI dependencies, and published native prebuilds. Their packaged license files are retained in `node_modules`.
- KaTeX: MIT; local report assets and fonts are copied from the pinned package. Its license is included in the distribution’s `node_modules/katex`.
- Local audio fallback: Transformers.js (Apache-2.0), ONNX Runtime (MIT and included third-party notices), and HeadTTS phonemization/dictionary support (MIT and CMU dictionary BSD notice). Full notices are bundled in the extension. Whisper Base English uses OpenAI Whisper’s MIT license; Kokoro 82M uses Apache-2.0. Pinned model revisions, complete weights and per-file hashes ship in `dist/extension/voice-models`, with model cards and license files. No MMS-TTS model is bundled.
- ACP SDK, MCP SDK, React, React DOM, TypeBox, DOMPurify, marked, yauzl and transitive dependencies: package versions are pinned in `package-lock.json`; their installed package notices/licenses remain included in the distribution.
- Antigravity: optional official Google ACP runtime, downloaded separately from Google's published platform URLs and checked against a pinned SHA-256. It is not included in Autoum browser archives. A separate local compatibility copy of the pinned connector adds Autoum to its client renderer model opt-in; original runtime files and included licenses remain intact. The adapted Python module is marked as modified, and before/after hashes are recorded beside the copy. Its provider terms and runtime notices apply separately.

T3Code and Jev browsing projects are design references, not bundled source. Their repository links and the implementation choices they inspired are documented in `docs/DESIGN.md`.

Autoum memory independently implements the fixed-record and age-biased summary design described by [Victor Taelin’s OptMem](https://github.com/VictorTaelin/OptMem). Upstream Python source is not bundled.

The native audio adapter uses the official OpenAI SDK (Apache-2.0), already included with Pi and explicitly listed as a production dependency. KaTeX is MIT-licensed and ships local JavaScript, styles and fonts for the sidebar and saved reports.
