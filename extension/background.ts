import { runBrowser, releaseBrowser, permittedUrl } from './browser.ts';
import { PortRpc } from './port-rpc.js';
let native: chrome.runtime.Port | undefined;
let requests: PortRpc | undefined;
let latest: any;
const views = new Set<chrome.runtime.Port>();
const interactions = new Map<string, any>();
function postView(port: chrome.runtime.Port, packet: any) { try { port.postMessage(packet); } catch { views.delete(port); } }
function broadcast(packet: any) { for (const port of views) { try { port.postMessage(packet); } catch {} } }
function connect() {
  if (native) return native;
  const connection = chrome.runtime.connectNative('rocks.autoum.agent'); native = connection;
  requests = new PortRpc(connection, () => chrome.runtime.lastError?.message || 'Agent disconnected.');
  connection.onMessage.addListener(async packet => {
    if (packet.reply) return;
    if (packet.type === 'browser') {
      try {
        const data = await runBrowser(packet.data);
        if (native === connection) connection.postMessage({ reply: packet.id, data });
      }
      catch (e: any) { try { if (native === connection) connection.postMessage({ reply: packet.id, error: e.message }); } catch {} } return;
    }
    if (packet.type === 'open_url') {
      try { const url = permittedUrl(packet.data.url); if (url.startsWith('https:') || url.startsWith('http://127.0.0.1')) await chrome.tabs.create({ url }); } catch {} return;
    }
    if (packet.type === 'release_browser') { await releaseBrowser(packet.data?.chatId); return; }
    if (packet.type === 'state') latest = packet.data;
    if (packet.id && ['approval', 'auth_prompt'].includes(packet.type)) interactions.set(packet.id, packet);
    if (packet.type === 'interaction_cancelled') interactions.delete(packet.data.id);
    broadcast(packet);
  });
  connection.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'Agent disconnected.'; if (native !== connection) return; native = undefined; requests = undefined;
    interactions.clear();
    broadcast({ type: 'disconnected', data: { error } }); releaseBrowser();
  });
  return native;
}
async function rpc(type: string, data?: any) {
  connect(); return requests!.request(type, data);
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'autoum-ui' || port.sender?.id !== chrome.runtime.id || !port.sender?.url?.startsWith(chrome.runtime.getURL(''))) return; views.add(port);
  if (latest) postView(port, { type: 'state', data: latest });
  for (const packet of interactions.values()) postView(port, packet);
  port.onDisconnect.addListener(() => views.delete(port));
  port.onMessage.addListener(async packet => {
    if (packet.reply) { interactions.delete(packet.reply); connect().postMessage(packet); return; }
    try {
      const data = packet.type === 'local_browser' ? await runBrowser(packet.data) : await rpc(packet.type, packet.data);
      postView(port, { reply: packet.id, data });
    } catch (e: any) { postView(port, { reply: packet.id, error: e.message }); }
  });
  rpc('state').catch(e => postView(port, { type: 'disconnected', data: { error: e.message } }));
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.commands.onCommand.addListener(async command => {
  if (command === 'toggle-sidebar') { const window = await chrome.windows.getLastFocused(); if (window.id) await chrome.sidePanel.open({ windowId: window.id }); }
});
chrome.runtime.onInstalled.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }); });
