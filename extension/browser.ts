import { BrowserConnections, type BrowserScope } from './browser-connections.ts';
const connections = new BrowserConnections(chrome.debugger);
const queues = new Map<number, Promise<any>>();
const groupQueues = new Map<number, Promise<void>>();
type ResearchAction = { chatId: string; windowId: number; activeTabId?: number; collapsed: boolean; popup: number; created: Promise<void>; notifyCreated: () => void; children: Promise<void>[] };
const researchActions = new Map<number, ResearchAction>();
async function researchTab(chatId?: string): Promise<chrome.tabs.Tab | undefined> {
  if (!chatId) return;
  const key = 'researchTab:' + chatId, stored = await chrome.storage.session.get(key);
  if (typeof stored[key] !== 'number') return;
  try {
    const tab = await chrome.tabs.get(stored[key]);
    const group = (await chrome.storage.local.get('agentGroup:' + tab.windowId))['agentGroup:' + tab.windowId];
    if (!tab.incognito && tab.groupId === group) return tab;
  } catch {}
  throw Error('The research tab was closed or moved out of its group. Open a new research tab or specify a tabId.');
}
async function rememberResearchTab(chatId: string | undefined, tabId: number) {
  if (chatId) await chrome.storage.session.set({ ['researchTab:' + chatId]: tabId });
}
async function groupAgentTab(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) throw Error('The new tab could not be created.');
  const previous = groupQueues.get(tab.windowId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const key = 'agentGroup:' + tab.windowId, defaultsKey = key + ':backgroundDefaults'; const stored = await chrome.storage.local.get([key, defaultsKey]);
    let groupId = stored[key];
    if (typeof groupId === 'number') {
      try { const existing = await chrome.tabGroups.get(groupId); if (existing.windowId !== tab.windowId) groupId = undefined; }
      catch { groupId = undefined; }
    }
    if (groupId === undefined) groupId = (await chrome.tabGroups.query({ windowId: tab.windowId, title: 'Autoum' }))[0]?.id;
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id!], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: 'Autoum', color: 'green', collapsed: !tab.active });
    } else await chrome.tabs.group({ tabIds: [tab.id!], groupId });
    let initialized = stored[defaultsKey] === groupId;
    if (!initialized && !tab.active) {
      const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
      if (active?.groupId !== groupId) { await chrome.tabGroups.update(groupId, { collapsed: true }); initialized = true; }
    }
    if (stored[key] !== groupId || initialized && stored[defaultsKey] !== groupId) await chrome.storage.local.set({ [key]: groupId, ...(initialized ? { [defaultsKey]: groupId } : {}) });
  });
  groupQueues.set(tab.windowId, task); try { await task; } finally { if (groupQueues.get(tab.windowId) === task) groupQueues.delete(tab.windowId); }
}
chrome.debugger?.onEvent.addListener((source, method) => {
  if (method === 'Page.windowOpen' && source.tabId !== undefined) { const action = researchActions.get(source.tabId); if (action) action.popup++; }
});
chrome.tabs.onCreated.addListener(tab => {
  // Chromium can report the user's active tab as opener for a background CDP click.
  const pending = [...researchActions.values()].filter(action => action.popup > action.children.length);
  const action = (tab.openerTabId === undefined ? undefined : researchActions.get(tab.openerTabId)) || pending.find(action => action.windowId === tab.windowId) || (pending.length === 1 ? pending[0] : undefined);
  if (!action || action.popup <= action.children.length || tab.id === undefined || tab.incognito) return;
  const task = (async () => {
    let child = await chrome.tabs.get(tab.id!);
    if (child.active && action.activeTabId !== undefined) {
      const active = (await chrome.tabs.query({ active: true, windowId: child.windowId }))[0];
      if (active?.id === child.id) await chrome.tabs.update(action.activeTabId, { active: true }).catch(() => {});
    }
    if (child.windowId !== action.windowId) { await chrome.tabs.move(child.id!, { windowId: action.windowId, index: -1 }); child = await chrome.tabs.get(child.id!); }
    await groupAgentTab(child); await rememberResearchTab(action.chatId, child.id!);
    const grouped = await chrome.tabs.get(child.id!), active = (await chrome.tabs.query({ active: true, windowId: action.windowId }))[0];
    if (action.collapsed && active?.groupId !== grouped.groupId) await chrome.tabGroups.update(grouped.groupId!, { collapsed: true });
  })();
  action.children.push(task); action.notifyCreated();
  void task.catch(() => {});
});
export async function releaseBrowser(chatId?: string) { await connections.release(chatId); }
chrome.debugger?.onDetach.addListener(source => { if (source.tabId !== undefined) connections.forget(source.tabId); });
export function permittedUrl(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol) || parsed.protocol === 'about:' && url !== 'about:blank')
    throw Error('Choose a web page or local file. Browser settings and extension pages cannot be controlled.');
  return parsed.href;
}
async function evaluatePage(scope: BrowserScope, tabId: number, expression: string, frameId?: string, returnByValue = true) {
  let contextId: number | undefined;
  if (frameId) contextId = (await connections.command(tabId, scope, 'Page.createIsolatedWorld', { frameId, worldName: 'autoum-browser' })).executionContextId;
  const result = await connections.command(tabId, scope, 'Runtime.evaluate', { expression, contextId, returnByValue, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page action failed.');
  return returnByValue ? result.result?.value : result.result;
}
// Function is serialized into a page's isolated world; no privileged browser APIs enter it.
export function describeControl(el: Element) {
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  const ancestors: Element[] = []; let parent: Element | null = el;
  while (parent) { ancestors.push(parent); const root = parent.getRootNode(); parent = parent.parentElement || (root instanceof ShadowRoot ? root.host : null); }
  const visible = !!box.width && !!box.height && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
    && !el.closest('[hidden],[inert],[aria-hidden="true"]') && !ancestors.some(node => Number(getComputedStyle(node).opacity) === 0 || node.matches('[hidden],[inert],[aria-hidden="true"]'));
  const enabled = style.pointerEvents !== 'none' && !el.matches(':disabled,[aria-disabled="true"]') && !el.closest('[aria-disabled="true"],[inert]');
  const root = el.getRootNode() as Document | ShadowRoot;
  const referenced = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => root.querySelector('#' + CSS.escape(id))?.textContent || '').join(' ').trim();
  const labels = Array.from((el as HTMLInputElement).labels || []).map(label => label.textContent || '').join(' ').trim();
  const label = (el.getAttribute('aria-label') || referenced || labels || el.getAttribute('placeholder') || el.textContent || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0, 220);
  const contenteditable = (el as HTMLElement).isContentEditable === true;
  const type = el.getAttribute('type') || (el instanceof HTMLInputElement ? el.type : null);
  const fillable = !(el as HTMLInputElement).readOnly && (contenteditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    || el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(el.type));
  const container = el.closest('article,li,tr,fieldset,[role="listitem"],[role="group"]');
  return { tag: el.localName, type, label, visible, enabled, fillable, contenteditable,
    context: container?.textContent?.trim().slice(0, 350),
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
    value: (el instanceof HTMLInputElement && el.type !== 'password' || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) ? (el as HTMLInputElement).value.slice(0, 200) : undefined };
}
export function pageSnapshot() {
  const elements: any[] = [];
  const selectorFor = (el: Element): string => {
    const scope = el.getRootNode() as Document | ShadowRoot;
    if (el.id && scope.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return (scope instanceof ShadowRoot ? selectorFor(scope.host) + ' >>> ' : '') + '#' + CSS.escape(el.id);
    const parent = el.parentElement;
    const part = el.localName + ':nth-of-type(' + (parent ? [...parent.children].filter(c => c.localName === el.localName).indexOf(el) + 1 : 1) + ')';
    if (parent) return selectorFor(parent) + ' > ' + part;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? selectorFor(root.host) + ' >>> ' + part : part;
  };
  const visit = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (elements.length >= 250 || !el.matches('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],summary')) continue;
      const description = describeControl(el); if (!description.visible) continue;
      elements.push({ selector: selectorFor(el), ...description });
    }
  };
  visit(document);
  return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 40000), elements };
}
const locateSource = `(selector) => { let root = document; let el; for (const part of selector.split(' >>> ')) { el = root.querySelector(part); if (!el) throw Error('Element not found: '+part); root = el.shadowRoot; } return el; }`;
async function targetPage(scope: BrowserScope, tabId: number, selector: string, frameId?: string, body = 'return el;') {
  return evaluatePage(scope, tabId, `(() => { const el = (${locateSource})(${JSON.stringify(selector)}); ${body} })()`, frameId);
}
async function inspectPage(scope: BrowserScope, tab: chrome.tabs.Tab, args: any) {
  let element: any;
  if (args.selector) element = await targetPage(scope, tab.id!, args.selector, args.frameId, `return {
    ...(${describeControl.toString()})(el),
    href: el.href || '', formAction: el.form?.action || '', fields: el.form ? [...el.form.elements].map(x=>({type:x.type,name:x.name})).slice(0,25):[] };`);
  return { tabId: tab.id, url: tab.url, title: tab.title, element };
}
async function execute(args: any, scope: BrowserScope): Promise<any> {
  connections.check(scope);
  const attach = (tabId: number) => connections.attach(tabId, scope);
  const command = (tabId: number, method: string, params?: any) => connections.command(tabId, scope, method, params);
  const evaluate = (tabId: number, expression: string, frameId?: string, returnByValue = true) => evaluatePage(scope, tabId, expression, frameId, returnByValue);
  const target = (tabId: number, selector: string, frameId?: string, body?: string) => targetPage(scope, tabId, selector, frameId, body);
  const inspect = (tab: chrome.tabs.Tab, args: any) => inspectPage(scope, tab, args);
  if (args.action === 'tabs') return (await chrome.tabs.query({})).filter(t => !t.incognito).map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, groupId: t.groupId }));
  if (args.action === 'downloads') return (await chrome.downloads.search({ limit: 30, orderBy: ['-startTime'] })).map(d => ({ id: d.id, filename: d.filename, state: d.state, url: d.url }));
  if (args.action === 'open') {
    const research = !!args.chatId && args.viewer !== true;
    let lane: chrome.tabs.Tab | undefined; if (research) { try { lane = await researchTab(args.chatId); } catch {} }
    connections.check(scope);
    const active = args.active === true && !research;
    const tab = await chrome.tabs.create({ url: permittedUrl(args.url), active, ...(lane ? { windowId: lane.windowId } : {}) });
    try { if (args.viewer !== true) await groupAgentTab(tab); }
    catch (error) { if (tab.id !== undefined) await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
    if (research) await rememberResearchTab(args.chatId, tab.id!);
    if (active) await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id, url: tab.url };
  }
  if (args.action === 'download') {
    const url = permittedUrl(args.url); const id = await chrome.downloads.download({ url, filename: args.filename, saveAs: false }); return { downloadId: id };
  }
  const tab = args.tabId ? await chrome.tabs.get(args.tabId) : await researchTab(args.chatId) || (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(t => !t.url?.startsWith('chrome-extension:'));
  if (!tab?.id) throw Error('Open a page first, or choose a tab.');
  if (tab.incognito) throw Error('Agents are disabled in private windows.');
  connections.check(scope);
  const tabId = tab.id; permittedUrl(tab.url || 'about:blank');
  if (args.expectedTarget) {
    await attach(tabId); const current = await inspect(tab, args);
    if (JSON.stringify(current) !== JSON.stringify(args.expectedTarget)) throw Error('The page changed after review. Inspect it and request the action again.');
  }
  if (args.action === 'activate') {
    if (args.chatId && args.viewer !== true) return { tabId, active: false, instruction: 'Research stays in the background; continue with this tabId.' };
    const ownGroup = (await chrome.storage.local.get('agentGroup:' + tab.windowId))['agentGroup:' + tab.windowId];
    // Move reports created by earlier versions out before showing them, keeping research tucked away.
    const legacyViewer = args.viewer === true && tab.groupId >= 0 && tab.groupId === ownGroup;
    if (legacyViewer) await chrome.tabs.ungroup(tabId);
    await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
    if (legacyViewer) await chrome.tabGroups.update(ownGroup, { collapsed: true }).catch(() => {});
    return { tabId };
  }
  if (args.action === 'close') { await chrome.tabs.remove(tabId); connections.forget(tabId); return { closed: tabId }; }
  if (args.action === 'navigate') { await chrome.tabs.update(tabId, { url: permittedUrl(args.url) }); return { tabId }; }
  if (args.action === 'reload') { await chrome.tabs.reload(tabId); return { tabId }; }
  if (args.action === 'back') { await chrome.tabs.goBack(tabId); return { tabId }; }
  if (args.action === 'forward') { await chrome.tabs.goForward(tabId); return { tabId }; }
  await attach(tabId);
  if (args.action === 'inspect') return inspect(tab, args);
  if (args.action === 'snapshot') {
    const snapshot = await evaluate(tabId, `(() => { const describeControl = ${describeControl.toString()}; return (${pageSnapshot.toString()})(); })()`, args.frameId);
    const tree = await command(tabId, 'Page.getFrameTree');
    const frames: any[] = []; const walk = (node: any) => { frames.push({ id: node.frame.id, url: node.frame.url, name: node.frame.name }); node.childFrames?.forEach(walk); }; walk(tree.frameTree);
    return { tabId, ...snapshot, frames };
  }
  if (args.action === 'screenshot') { const result = await command(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false }); return { tabId, image: result.data }; }
  if (args.action === 'evaluate') return { tabId, result: await evaluate(tabId, args.expression, args.frameId) };
  if (args.action === 'click') {
    if (args.selector) {
      if (args.frameId) { await target(tabId, args.selector, args.frameId, 'el.scrollIntoView({block:"center"}); el.click(); return true;'); return { tabId, clicked: true }; }
      const point = await target(tabId, args.selector, undefined, 'el.scrollIntoView({block:"center"}); const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; let hit=document.elementFromPoint(x,y); while(hit?.shadowRoot){const deeper=hit.shadowRoot.elementFromPoint(x,y);if(!deeper||deeper===hit)break;hit=deeper;} if(!hit || !(hit===el||el.contains(hit))) throw Error("The target is covered by another element. Inspect the page."); return {x,y};');
      args = { ...args, ...point };
    }
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw Error('Choose a selector or coordinates.');
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: args.x, y: args.y, button: 'left', clickCount: 1 });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: args.x, y: args.y, button: 'left', clickCount: 1 }); return { tabId, clicked: true };
  }
  if (args.action === 'type') {
    const matched = await target(tabId, args.selector, args.frameId, `el.focus();
      if (el.isContentEditable) el.textContent=${JSON.stringify(args.text)};
      else { const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(args.text)}); }
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return (el.isContentEditable ? el.textContent : el.value) === ${JSON.stringify(args.text)};`);
    return { tabId, filled: true, matched };
  }
  if (args.action === 'press') {
    if (args.selector) await target(tabId, args.selector, args.frameId, 'el.focus(); if(el.getRootNode().activeElement!==el) throw Error("The selected control cannot receive keyboard input."); return true;');
    const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
    const parts = String(args.key).split('+'); const key = parts.pop()!;
    const modifiers = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') || parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
    await command(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, windowsVirtualKeyCode: keys[key] || key.toUpperCase().charCodeAt(0), ...(key === 'Enter' ? { text: '\r' } : {}) });
    await command(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers }); return { tabId };
  }
  if (args.action === 'scroll') {
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: args.x || 200, y: args.y || 200, deltaX: args.deltaX || 0, deltaY: args.deltaY ?? 600 }); return { tabId };
  }
  if (args.action === 'upload') {
    const obj = await evaluate(tabId, `(${locateSource})(${JSON.stringify(args.selector)})`, args.frameId, false);
    const node = await command(tabId, 'DOM.describeNode', { objectId: obj.objectId });
    await command(tabId, 'DOM.setFileInputFiles', { files: args.paths, backendNodeId: node.node.backendNodeId });
    await command(tabId, 'Runtime.releaseObject', { objectId: obj.objectId }); return { tabId, uploaded: args.paths.length };
  }
  if (args.action === 'dialog') { await command(tabId, 'Page.handleJavaScriptDialog', { accept: !!args.accept, promptText: args.promptText }); return { tabId }; }
  throw Error('Unknown browser action.');
}
export async function runBrowser(args: any) {
  const scope = connections.scope(args.chatId);
  if (['tabs', 'downloads', 'open', 'download'].includes(args.action)) return execute(args, scope);
  if (!args.tabId) {
    const tab = await researchTab(args.chatId) || (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(t => !t.url?.startsWith('chrome-extension:'));
    if (!tab?.id) throw Error('Open a page first, or choose a tab.');
    args = { ...args, tabId: tab.id };
  }
  connections.check(scope);
  const key = args.tabId;
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    if (!args.chatId || args.viewer === true || !['click', 'press', 'type', 'evaluate'].includes(args.action)) return execute(args, scope);
    const tab = args.tabId ? await chrome.tabs.get(args.tabId) : await researchTab(args.chatId) || (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(t => !t.url?.startsWith('chrome-extension:'));
    if (!tab?.id || tab.incognito) return execute(args, scope);
    const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    const ownGroup = (await chrome.storage.local.get('agentGroup:' + tab.windowId))['agentGroup:' + tab.windowId];
    const collapsed = tab.groupId !== ownGroup || (await chrome.tabGroups.get(ownGroup)).collapsed;
    let notifyCreated!: () => void;
    const action: ResearchAction = { chatId: args.chatId, windowId: tab.windowId, activeTabId: active?.id, collapsed, popup: 0, children: [], created: new Promise(resolve => { notifyCreated = resolve; }), notifyCreated: () => notifyCreated() };
    researchActions.set(tab.id, action);
    try {
      const result = await execute({ ...args, tabId: tab.id }, scope);
      if (action.popup) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([action.created, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); } finally { clearTimeout(timer); }
        await Promise.all(action.children);
      }
      return result;
    } finally { if (researchActions.get(tab.id) === action) researchActions.delete(tab.id); }
  });
  queues.set(key, next); try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
