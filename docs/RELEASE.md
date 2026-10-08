# Autoum preview release

Autoum is a personal AI browser sidebar, distributed as a complete Thorium-based browser and as a Linux/Windows standalone Vivaldi/Chrome extension with a local companion.

## Downloads

- Windows x64: full browser setup/portable ZIP, or **Autoum-Extension-Setup** for your existing Chrome/Vivaldi.
- Linux x64: browser archive, or standalone extension/companion archive.
- macOS: separate Intel and Apple Silicon browser archives.
- Each archive has a SHA-256 sidecar.

No downloads contain personal accounts, API keys, browser profiles, chats or memory. Connect your own accounts in Settings. Native messaging and broad browser permissions are needed for the requested browsing and computer tools. Ask, Auto-review and Always allow remain explicit choices.

Provider lists refresh from supported provider endpoints and Pi's live typed catalogs. Catalogs are cached locally per account and rechecked automatically; Settings also has a manual refresh. Provider failures preserve the previous working list. New mixed-protocol OpenCode models require matching SDK protocol metadata before being offered. Existing model preferences remain saved when a model is retired.

Native Voice chat is offered for available OpenAI Realtime models with an OpenAI API account. ChatGPT subscription login does not grant Realtime API access. Other supported chat models use bundled Whisper Base English/Kokoro for local dictation and spoken replies when fallback is enabled.

## Validation limits

Linux disposable-profile checks exercise the actual sidebar/native agent, browser tools, file links, research groups, settings/account/model persistence, attachments, Markdown/KaTeX, MCP and voice lifecycle. Native Realtime is tested through private SDK protocol fixtures; a paid OpenAI audio account has not been tested. Windows/macOS packaging is not native execution or audio testing. Standalone Vivaldi registration and normal launching succeeded; automated native Vivaldi checks remain limited by launch/attachment failures in this environment.

The browser engine is an older upstream Thorium binary, with upstream notices and source URLs included. This preview is not an up-to-date Chromium security release. Windows setup is unsigned; macOS preserves the original engine signature. Source is MIT-licensed; third-party licenses remain included.
