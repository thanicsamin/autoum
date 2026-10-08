# Autoum in Vivaldi or Chrome

Autoum has two editions: a browser with the sidebar included, and an unpacked extension for your existing Chromium browser. Both use the same local agent. The extension requires that companion for account login, files, MCP, tools and native model audio.

## Windows extension installer

Download **Autoum-Extension-Setup-0.1.0-preview-windows-x64.exe** from [GitHub releases](https://github.com/thanicsamin/autoum/releases). This is the extension setup for an existing browser; the separate **Autoum-Setup** download installs the full browser.

1. Close Chrome and Vivaldi before setup. Run the installer and select the browsers you want. It installs the local companion, Node and fallback voice models for your Windows user; no administrator access or separate runtime is needed.
2. Open the selected browser’s menu → **Extensions → Manage extensions**. Enable **Developer mode**, then choose **Load unpacked**.
3. From Start → **Autoum Extension**, open **Chrome extension folder** or **Vivaldi extension folder**. Copy that folder’s address and select it in the browser’s folder picker. The default paths are `%LOCALAPPDATA%\Autoum-Extension\google-chrome\extension` and `%LOCALAPPDATA%\Autoum-Extension\vivaldi\extension`.
4. In Autoum’s **Details**, enable **Allow access to file URLs** for local reports and lessons. Pin it to the toolbar and connect your own accounts in Settings.

Loading the extension is a one-time browser approval. Setup does not change browser policies, preferences, tabs or browsing history. Chrome/Vivaldi each get their own companion name and account/chat folder; both can coexist with the full Autoum browser. The installer is for Windows x64 and is currently unsigned.

For updates, close the selected browsers, run the new installer, then click **Reload** on the extension’s card. Accounts, chats and preferences are preserved. Windows Settings → Apps → **Autoum Extension** uninstalls the companion; remove the extension from the browser’s Extensions page too. Your independent data stays under `%LOCALAPPDATA%\Autoum-Extension\<browser>\data` for a later reinstall. Setup leaves existing custom registrations alone and reports conflicts.

The optional Windows ZIP contains `Setup-extension.cmd` for Vivaldi. To install Chrome from that ZIP, run `runtime\node.exe scripts\install-extension.mjs --chrome` in the extracted folder, then use the same browser steps above. The executable installer is the easier option.

## Linux extension bundle

Extract the standalone Linux extension bundle into a permanent folder. Close Vivaldi, then open `Setup-extension`. It installs Autoum under `~/.local/share/autoum-vivaldi`, registers the local companion and updates your per-user Vivaldi launcher. Open Vivaldi normally and use Autoum's toolbar button or Ctrl+Shift+O.

For Chrome, run `runtime/node scripts/install-extension.mjs --chrome`. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `~/.local/share/autoum-google-chrome/extension`. In Autoum's extension details, enable **Allow access to file URLs** for local lessons and reports.

The extension keeps the browser's existing new-tab page. Its accounts, settings and chats are separate from the bundled browser. Settings → AI accounts connects accounts; no account or credential is included in downloads. If you installed from source and want to import your own Autoum configuration privately, `--import-settings` is opt-in.

On update, close the target browser before rerunning setup, then reload Autoum from the browser's Extensions page. The installer preserves existing accounts and chats. Keep a backup of your browser/profile as you would for any development extension.

## Other platforms

The full browser downloads include the platform's Node companion and setup launcher for Windows, Intel Mac and Apple Silicon. Standalone extension setup supports Linux and Windows x64. A standalone macOS extension installer has not been shipped.

## Why a companion?

A browser extension cannot directly run local SDKs or access arbitrary computer files. Autoum uses Chromium's [native messaging interface](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) to reach its per-user local helper. This is a sideloaded development extension, not a Chrome Web Store listing.
