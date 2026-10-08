# Autoum design

The agreed first deliverable is a browser people can launch: Thorium, an AI side panel, and an embedded local Pi host. A source-level Chromium fork is unnecessary for the first version and cannot fit this machine's available disk.

## Components

```
Human + regular website sessions
            |
      Thorium profile
            |
     Autoum MV3 sidebar
       |            |
 UI/chats    chrome.debugger CDP
       |            |
 native messaging <- browser actions/results
       |
 local Node host
       |---------------------------|
  Pi agent SDK                 Google ACP
       |                           |
 ChatGPT / Claude /          Antigravity runtime
 OpenCode / others          authenticated MCP relay
       |
 optional classifier loop (Jev / compatible models)
```

Native messaging has length-framed UTF-8 packets, correlated requests, cancellation, and bounded results. The sidebar only receives provider capability/connection metadata, never provider credentials. The browser bridge is private to the extension. Antigravity's MCP relay listens on loopback and requires a random per-session bearer secret; it is not an unauthenticated debugging endpoint.

Pi provides session persistence, model protocols, OAuth, streaming, shell/file tools, skills, and extensions. Autoum adds actual browser tools and enforces permissions in Pi's tool-call hook. Antigravity uses the official ACP protocol SDK and official Google runtime, with the same browser/permission bridge. Its persisted session can resume when the runtime advertises resume/load support.

The local-file requirement is solved with extension file access and browser debugging APIs. It does not require disabling browser origin checks globally. A page is always treated as untrusted source material, including when the page is local.

## Permission modes

Ask permits observation but requires an explicit approval for mutations. Auto-review uses a separate tool-free call with human requests and a proposed action/target. It fails closed on errors, invalid output, missing authorization, and cancellation. Always allow skips individual approvals. Approval replies can atomically approve one action and persist a mode; invalid modes and stale approvals remain denied. A pending approval is invalidated when the permission epoch changes or the task stops. Reviewed browser actions are bound to the target's observed page/element identity and fail if it changes.

Desktop/file tools operate with the current user's permissions. The browser sandbox remains enabled. Native Wayland input is an OS integration limitation and is reported, not silently represented as working.

## Accounts and sidebar preferences

Each added account has an independent Pi credential runtime, or an independent Google ACP profile. Existing credentials migrate into default account slots. Chat model/account selections and permission defaults persist in the host; appearance, font overrides and drafts persist in extension storage. Native browser theme preferences are read without writing the active profile; browser font changes use the fontSettings API. Model visibility filters future selections while preserving existing chat choices. Chat recency is recorded on messages, with older session timestamps used for migration.

Quota requests are read-only and tied to the selected account, with five-minute caching and outage backoff. OpenCode usage requests carry the conversation ID and tool User-Agent. Missing quotas render as unavailable, never as zero usage. Browser-tool-created tabs reuse one native group in each window, including after worker restarts.

## Decision-model loop

The main model plans; a classifier selects from observed controls. Large control sets are classified in bounded parallel batches, followed by a final shortlist comparison. Accepted answers require an observed candidate, finite normalized probabilities, a winning probability of at least 0.75, confidence at least 0.7, and a margin of at least 0.1. The target must still have the observed URL, tag, label and link destination and surrounding context before execution. Disabled, hidden and read-only controls are excluded. Hit testing rejects covered click targets, and keyboard actions require actual focus. The ordinary action guard is invoked for each internal step.

Clicks/keys require a planned expected text or URL. Type actions verify exact value equality. Failed expected-result checks stop the plan and return to the main agent. A classifier service failure causes five minutes of backoff. Automatic selection only uses free connected classifier models. Provider-paid models require an explicit settings choice. No classifier is required for ordinary browser use.

## HTML output and persistent memory

Both Pi and Google ACP expose `research_report` through the same permission boundary. System instructions default long output to HTML. Structured summaries, sections and linked items render directly through a small shared template; custom HTML is optional. Reports write atomically with private permissions under `research/<chat UUID>/<report UUID>.html`, then open actively outside the collapsed native Autoum research group. User-clicked result links and attachment viewers also stay outside the research group. Reusing a report ID reloads and activates the existing tab. User-requested save-only output skips opening. The full html-teacher workflow is not required for ordinary output.

Shared memory follows OptMem’s fixed UTF-8 records and age-biased dyadic summary tree. The local host includes bounded context before a prompt and provides note, recall, zoom and summarization tools. Summaries use the active agent’s tool calls, without a hidden extra model. Corrections/deletions invalidate affected summaries; source fingerprints reject stale summaries. File writes serialize across hosts and observe cancellation. Disabling memory disposes cached Pi and Google sessions so tool availability and prompt context change together. Automatic note selection depends on the model following instructions; the UI can inspect and correct the stored evidence.

## Browser branding

A bounded DataPack parser rewrites product-facing locale strings and pinned logo payloads while retaining attribution and URLs. Windows icon replacement accepts only the pinned unsigned executable and replaces resource payloads within existing allocations, preserving code, imports and layout. Changes are recorded with before/after hashes. Signed macOS engine resources are retained; the Autoum launcher has its own icon. This does not change the compiled upstream version metadata or create a source-built engine.

## Inspiration and primary sources

- [T3Code](https://github.com/pingdotgg/t3code): restrained UI, clear account/model controls, provider boundaries, and ACP integration patterns. Autoum uses its own implementation, not copied UI code.
- [OptMem](https://github.com/VictorTaelin/OptMem): fixed-record notes and age-biased summary context, adapted independently for the local Node host.
- [Pi](https://github.com/badlogic/pi-mono): SDK-based local harness, model runtime, extensions, skills, and disk-backed sessions. The installed fork is `@earendil-works/pi-coding-agent` 1.0.0, matching Phoenix's harness.
- [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart): account-based model access through the SDK's supported OAuth flow.
- [OpenCode Zen](https://opencode.ai/docs/en/zen/): native model endpoints, account/key access, and Jev's `systemone` interface.
- [TypeSafe](https://docs.typesafe.ai/): decision questions/criteria and structured choice responses.
- [Jev browser](https://github.com/dennisonbertram/jev-browser) and [jev-browse](https://github.com/0x7067/jev-browse): separating planning from quick control selection. Their reported speeds are not treated as Autoum benchmarks.
- [ACP](https://agentclientprotocol.com/): official Node SDK, session/authentication protocol and permission callbacks.
- [Chromium native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): platform registration and framed transport.
- [Chromium Linux build requirements](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md) and [Thorium build notes](https://thorium.rocks/docs/building.html): source builds need at least 100 GB free disk and 8 GB RAM; substantially more RAM helps. This host had around 39 GB disk free and 15 GB total RAM at the initial check, so a full source build was not attempted.
- [Thorium releases](https://github.com/Alex313031/thorium/releases), [Windows releases](https://github.com/Alex313031/Thorium-Win/releases), [macOS releases](https://github.com/Alex313031/Thorium-MacOS/releases): official binaries and published digests.
- [Node](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt): portable runtime and official checksums.
