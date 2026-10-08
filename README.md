# Autoum

A personal AI browser sidebar for the Autoum browser and Vivaldi/Chrome. The bundled browser uses Thorium; its local agent uses Pi. Browse normally, or ask your agent to use the same tabs, website logins, local HTML pages, Downloads folder, and computer tools.

Autoum bundles the browser and local agent alongside one another. It does not require a Chromium source build. The browser engine and its MV2 behavior are upstream Thorium; the Autoum sidebar uses MV3.

## Extension edition

The Linux standalone extension bundle and Windows extension installer include their own Node companion and local audio models. It keeps your existing new-tab page and browser profile. See [Vivaldi/Chrome installation](docs/INSTALL-EXTENSION.md). Windows offers both editions; macOS downloads currently provide the complete browser edition. Release notes and testing limits are in [the release guide](docs/RELEASE.md).

## Start

Extract the bundle for your computer into a permanent folder, then open its launcher:

| Computer | Launcher | Setup |
| --- | --- | --- |
| Linux x64 | `Autoum` | `Setup` creates the desktop entry |
| Windows x64 | `Autoum.cmd` | `Setup.cmd` registers the local host |
| macOS Intel / Apple Silicon | `Autoum.command` | `Setup.command` creates `~/Applications/Autoum.app` |

The first launch installs the local host and creates a separate browser profile. Pin the Autoum extension, or press **Ctrl+Shift+O** (**Command+Shift+O** on Mac) to open the sidebar. Visit Settings → AI accounts, then choose your model below the message box. Use the chevron beside Send to hide or show provider, account, model and reasoning controls; this preference is remembered. **Ctrl+K** reveals the controls and focuses the provider dropdown.

Launchers require no separate Node installation. Linux still needs Thorium's normal system graphics libraries. The locally prepared Linux bundle uses AVX2; the fresh-download script selects SSE3 for wider CPU compatibility. Windows uses its built-in .NET Framework compiler to create a small executable native host. macOS may request approval to open downloaded applications; desktop screen/input tools also require the usual OS permissions. Keep the extracted folder in place; if you move it, close Autoum and run Setup again.

From source, with Node 24 or newer:

```sh
npm ci
npm run browser:voices
npm run build
npm run browser:fetch
npm run setup
npm start
```

You can use an installed Thorium by setting `AUTOUM_BROWSER` to its executable instead of downloading one. `AUTOUM_DATA_DIR` and `AUTOUM_PROFILE_DIR` override the data and browser-profile locations. Autoum does not import or modify your normal browser profile.

## Accounts

| Provider | Account login | API keys | Integration |
| --- | --- | --- | --- |
| ChatGPT / OpenAI | Pi's Sign in with ChatGPT flow; existing Codex credentials can be detected separately | Yes | Pi model runtime |
| Claude | Pi's account sign-in flow; existing Claude Code file credentials can be detected | Yes | Pi model runtime |
| OpenCode Zen / Go | Detects credentials from an installed OpenCode. Account website sign-in is linked in Settings; Zen/Go model access uses the resulting key | Yes | Pi model runtime and OpenCode endpoints |
| Antigravity | Google account OAuth through the official Antigravity ACP runtime | No | Official ACP SDK and pinned Google runtime |

Settings also supports Gemini, OpenRouter, TypeSafe, and Vercel. Account detection reads supported credential files and copies usable credentials into Autoum's private store without overwriting an account you already connected. Browser cookies alone are not a model credential. OpenCode currently exposes model access through a key, so Autoum cannot turn an ordinary OpenCode website cookie into OAuth access.

Restart Autoum after upgrading so both the sidebar and local agent load the new code.

Antigravity includes the Gemini, Claude and GPT models advertised for your Google account, with their actual supported reasoning levels. Settings → AI accounts → Refresh models updates each account’s catalog. Connected providers refresh automatically every 15 minutes and when selected, using supported provider model endpoints and Pi’s live typed catalogs. Removed models leave saved preferences intact; failed updates keep the previous working list. The pinned connector receives a narrow Autoum renderer opt-in adaptation in a separate local copy because its upstream model picker otherwise filters third-party models for unknown clients. Autoum keeps its own client identity; account entitlement and model validation remain enforced by Google. Original downloads, license notices and hash receipts are retained. Unknown connector versions are left unchanged.

Each provider supports separate named accounts with independent credential stores. The sidebar shows the selected account (email when the provider supplies it, otherwise your label). Settings offers read-only usage bars for ChatGPT/Codex, Claude, OpenCode Go, and OpenRouter key budgets when their endpoints report limits; unsupported or unavailable limits are labeled explicitly. Usage checks are cached and do not block browsing. Disconnecting an account leaves its chats intact.

Subscription access depends on the provider's account entitlement. Autoum does not scrape the ChatGPT/Claude websites or borrow tokens from arbitrary browser pages. The local host keeps provider credentials out of extension messages and conversation exports. On Unix, the credential store is written with mode 600.

## Browsing and computer access

- Real tabs, background research tabs, navigation, DOM snapshots, screenshots, selectors, coordinates, forms, keyboard input, scrolling, JavaScript, frames, open shadow roots, file uploads, downloads, and JavaScript dialogs.
- **Local `file://` pages work directly**, including html-teacher lessons and their interactive solution buttons. Setup enables file access for this extension in the separate profile. There is no global web-security or browser-sandbox disabling flag.
- Filesystem reads/writes/edits, folder listing, search, and shell/PowerShell use the current user's real permissions. Downloads is shown in Settings. Existing Pi/Codex skills are discovered; additional skill folders and Pi extensions can be configured.
- The `computer` tool exposes desktop capability inspection, screenshots, and input where the OS allows it. Linux uses xdotool plus Spectacle/ImageMagick; xdotool controls X11/XWayland applications, not arbitrary native Wayland applications. macOS uses AppleScript/screencapture and optional `cliclick` for pointer actions. Windows uses PowerShell and system input APIs. These helpers are not installed automatically. Browser control is independent of these desktop helpers.
- Ask permits observation and asks before mutations. Auto-review makes a separate tool-free review of your request and proposed action; uncertain, failed, or consequential reviews ask you. Always allow permits tool actions without individual approvals. While an agent is working, sending a message steers its current task by default. Stop/Escape aborts the agent and pending approvals. One agent task runs at a time to avoid conflicting browser/desktop actions.
- Tabs opened with the agent’s browser tool join a single **Autoum** tab group per browser window. Human-opened tabs are left where you place them. Tab and workspace navigation stays in the browser.
- Chats and folders, search, renaming, drafts, pins, archiving/restoring and deletion. The ⋯ menu beside each chat offers Pin/Unpin, Archive/Restore and Delete. Pinned chats stay above recent-message-first ordering; archived chats have a separate view. Deletion asks for confirmation and removes local conversation history; saved HTML reports remain available. Removing a folder keeps its chats. The latest model/account and reasoning choice are remembered per account, per provider and for new chats. Gemini, Claude and GPT reasoning variants appear as one model with only its supported reasoning levels in the separate picker. Settings has searchable model show/hide controls; hiding a model does not alter existing chats.
- Theme and sidebar font size follow browser preferences by default, with persistent overrides. Chat text defaults to 1.125 times the sidebar font (18 pixels when the browser uses 16); Settings can change that separately. Permission controls read **Ask → Auto-review → Always allow**; the approval popup can save a new mode while allowing an action. Settings also configures the default mode for new chats, integrations, working folder, accounts, fast browsing, and conversation export.
- Switching between Pi providers keeps model context; switching between Pi and Antigravity starts the other backend’s session while retaining the visible transcript.

## HTML output and memory

Long output defaults to a saved HTML page: detailed explanations, plans, guides, reports, research, comparisons and useful lists. The agent uses a lightweight Autoum template with source links, expandable details and filterable lists. Job searches based on a resume produce linked listings with fit explanations; shopping recommendations produce linked products with tradeoffs. Chat keeps a short confirmation and file link. Explicit requests for another format are respected.

Reports open in a visible foreground tab while the agent’s research group stays collapsed. Follow-up edits reuse the report file and its open tab. Files default to `~/autoum/artifacts`; custom artifact folders remain supported. Settings → HTML reports → Open reports folder opens their location. The built-in template needs no remote assets. Full html-teacher tutorials run only when explicitly requested.

Memory automatically captures useful preferences through a local tool shared across chats, accounts and providers. It follows [Taelin’s OptMem design](https://github.com/VictorTaelin/OptMem): fixed-size notes and age-biased summary ranges supply compact context, with recall and expansion when needed. This is an independent Node implementation. Settings lets you search, add, correct, forget or clear memories, disable automatic memory and set its context budget. Newer corrections and your current instructions take priority over saved notes. Memory files stay in the Autoum data folder and are excluded from distributed bundles.

## Optional Jev acceleration

Antigravity detects an installed IDE/CLI and reuses an available complete ACP connector from your PATH. Its separate Google browser connector is installed only if needed. An existing official ACP login is imported privately; an IDE/CLI login alone may still require one Google connection for browser access.

Jev’s provider/account is independent of the chat’s provider/account. For example, ChatGPT or Claude can use Jev through OpenCode, TypeSafe.ai or OpenRouter. Choose a separate decision account and fast browsing model in Settings; this does not change the main chat model.

The main agent can use `fast_browser` to execute a bounded plan through Jev or another compatible classifier. It supplies intent, exact text, and explicit expected results. Autoum observes real controls, asks the decision model to select only among them, checks calibrated probabilities and confidence, checks the target again, applies the same permission mode, acts, and verifies the resulting page. Every click/key step needs an explicit result check; typing must match the planned value.

Jev is redundant: ordinary browser tools work without it. Missing credentials, unavailable endpoints, invalid probabilities, timeouts, ambiguous choices, stale targets, or failed verification return `needs_agent`. Endpoint failures back off for five minutes. Automatic selection only chooses a connected free decision model; it never substitutes a paid classifier when free Jev fails. A paid decision model is used only when explicitly selected in Settings. The main agent can then inspect the page and continue with ordinary tools.

The OpenCode key also accesses `jev-1.13-free`. [OpenCode describes this offer as limited-time](https://opencode.ai/docs/en/zen/), with no published end date found on October 5, 2026. Fast browsing has dedicated masked key-entry controls for TypeSafe.ai, OpenRouter, and OpenCode. TypeSafe's direct service uses its own key; OpenRouter uses your OpenRouter key; OpenCode reuses its Zen key. No general speed claim is made: the live test verifies function, not an end-to-end benchmark.

## Build and share

```sh
npm run typecheck
npm test
npm run test:browser
npm run test:providers
npm run test:jev
npm run package -- linux-x64
npm run package -- win32-x64
npm run package -- darwin-arm64
npm run package -- darwin-x64
```

Packaging includes production dependencies, Node 24.21.0, the compiled sidebar/host, and a checksum-verified official Thorium build. Windows archive creation on a Unix host uses Python 3; Unix archives use `tar`. Browser and Node downloads have pinned SHA-256 hashes. Packages contain no account files, browser profiles, test output, or user skills.

Live tests are opt-in and use only the key file you authorize:

```sh
AUTOUM_TEST_KEY_FILE=/absolute/path/to/private-key-file npm run test:live
```

The test uses disposable local pages/profiles and removes its private credential copy afterward. See [validation](docs/VALIDATION.md), [design and sources](docs/DESIGN.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Current limits

This is a first working distribution using prebuilt Thorium. Autoum replaces product text and logo resources in the Linux/Windows browser, including the pinned unsigned Windows executable’s application and HTML/PDF icons. Launchers and the new-tab page use Autoum branding. Copyright, credits and upstream notices remain intact. The signed macOS engine retains upstream branding; full native identity changes require rebuilding and signing the engine. Upstream Thorium's newest downloadable assets found for these platforms are **138.0.7204.303**; newer release labels had no usable binaries. That is an old engine for daily browsing in October 2026. Autoum does not yet provide automatic browser updates. Prefer a maintained installed Thorium when available, or refresh the pinned assets after checking upstream releases. This remains a material limitation before treating the bundle as your everyday browser.

Linux browsing and the local host have been exercised in real Thorium, including live OpenCode/Jev requests. Windows extension setup/native messaging/update/uninstall pass native Windows runner checks. Windows/macOS browser GUI and ChatGPT/Claude/Google account sign-in require testing on those actual systems/accounts; preparation of a bundle is not proof of those flows. Desktop input requires the described OS helpers/permissions. Private windows and privileged browser-settings/extension pages are intentionally outside the browser agent's control.

### Voice

Native model audio takes priority. Available GPT Realtime models use the official OpenAI Realtime SDK with the selected OpenAI API account; ChatGPT subscription login does not grant Realtime API access. The composer’s Voice chat button starts automatic turn detection. Settings → Voice offers push-to-talk or automatic turn detection, native voice selection and optional spoken replies. Audio, transcripts, browser tools and approval modes share the same chat. End voice, Stop, chat changes and closing the sidebar release the microphone and connection.

When native audio is unavailable, the optional bundled fallback uses Whisper Base English for recognition and Kokoro 82M for natural speech. These open-source models and five voices ship with the browser, including their weights and local runtime. No first-use download is needed. Local audio stays on the computer; only its transcript goes to the selected chat model. Click the microphone to start and finish a spoken turn; this submits the recognized text. Disable the fallback in Settings to disable voice on unsupported models. The fallback is currently English and push-to-talk. First inference loads local model data and can be slower on low-powered computers.

For a source build, run `npm run browser:voices` before `npm run build`. Model revisions and asset hashes are recorded in `dist/extension/voice-models/manifest.json`. Voice permissions and audio support follow the operating system. A real paid OpenAI Realtime account has not been exercised in our controlled test suite.

### Markdown, math and attachments

Chat messages render Markdown headings, lists, tables, links, code and KaTeX math. Use `$x^2$` or `\(x^2\)` inline, and `$$...$$` or `\[...\]` for display equations. Code stays literal, ordinary prices retain their dollar signs, and invalid formulas remain readable. Math fonts and rendering ship locally; untrusted HTML is sanitized.

Paste images/files with Ctrl+V or use Attach files. Previews, file names, removal and draft attachments survive reopening. Up to ten files, each at most 20 MB, can accompany a message; model image inputs are limited to 5 MB per image. Models without image input reject images with a clear message. Text attachments include bounded content; other documents are accessible through filesystem tools. The AI can use `send_attachment` to show an image inline or deliver a clickable file. Saved chats retain attachment metadata and files.

### Skills and MCP

Settings lists installed Pi, Codex and .agents skills and lets you enable/disable each skill or add paths. All providers receive the same skill catalog and read instructions using the skill tool, including Antigravity through its browser MCP bridge. User instructions and chat permissions remain authoritative.

MCP settings support local executable/argument servers, Streamable HTTP and legacy SSE, along with connection tests, enable/disable/remove and standard `mcpServers` JSON import. The official MCP SDK discovers tools, resources and prompts. External calls follow Ask/Auto-review/Always allow; server read-only annotations do not bypass approval. Local credentials are stored privately in `mcp.json`; Settings masks saved environment/header values, and `${env:NAME}` references are supported. MCP OAuth sign-in is not implemented; authenticated remote servers can use configured headers.

### Artifacts

Created deliverables, HTML briefs and pasted attachments default to `~/autoum/artifacts` inside your home folder, organized by chat. Autoum creates it automatically on startup; no administrator command or setup script is needed. The folder is configurable in Settings; `AUTOUM_ARTIFACTS_DIR` provides an environment override. Existing source edits and explicit requested destinations remain in place. Account, memory and session data remain in the private application folder. Old HTML reports are copied without deleting their original files or breaking old links. Saved settings pointing to the old unwritable `/autoum/artifacts` default migrate automatically to the home-folder destination. Writable saved folders, custom destinations and explicit environment overrides are preserved.
