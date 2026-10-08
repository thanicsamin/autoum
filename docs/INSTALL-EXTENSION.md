# Autoum in Vivaldi or Chrome

Autoum has two editions: a browser with the sidebar included, and an unpacked extension for your existing Chromium browser. Both use the same local agent. The extension requires that companion for account login, files, MCP, tools and native model audio.

## Linux extension bundle

Extract the standalone Linux extension bundle into a permanent folder. Close Vivaldi, then open `Setup-extension`. It installs Autoum under `~/.local/share/autoum-vivaldi`, registers the local companion and updates your per-user Vivaldi launcher. Open Vivaldi normally and use Autoum's toolbar button or Ctrl+Shift+O.

For Chrome, run `runtime/node scripts/install-extension.mjs --chrome`. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `~/.local/share/autoum-google-chrome/extension`. In Autoum's extension details, enable **Allow access to file URLs** for local lessons and reports.

The extension keeps the browser's existing new-tab page. Its accounts, settings and chats are separate from the bundled browser. Settings → AI accounts connects accounts; no account or credential is included in downloads. If you installed from source and want to import your own Autoum configuration privately, `--import-settings` is opt-in.

On update, close the target browser before rerunning setup, then reload Autoum from the browser's Extensions page. The installer preserves existing accounts and chats. Keep a backup of your browser/profile as you would for any development extension.

## Other platforms

The full browser downloads include the platform's Node companion and setup launcher for Windows, Intel Mac and Apple Silicon. The standalone one-click extension installer currently supports Linux; do not treat the Windows/macOS browser archives as tested standalone extension installers.

## Why a companion?

A browser extension cannot directly run local SDKs or access arbitrary computer files. Autoum uses Chromium's [native messaging interface](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) to reach its per-user local helper. This is a sideloaded development extension, not a Chrome Web Store listing.
