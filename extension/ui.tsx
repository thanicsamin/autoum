import { localVoiceTurn } from './voice-turn.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown.js';
import { chatLinkPattern, chatLinkUrl } from './chat-links.js';
import { Conversation, CopyReply } from './conversation.js';
import { loadMessageText } from './message-text.js';
import { loadChatExport } from './export.js';
import 'katex/dist/katex.min.css';
import './ui.css';
import { Integrations } from './integrations.js';
import { FileAttachment, uploadAttachment, type Attachment } from './attachments.js';
import { useLocalVoice, fallbackVoices } from './local-voice.js';
import { useVoice } from './use-voice.js';
import { nativeVoices, voicePreferences } from './voice.js';
import { PortRpc } from './port-rpc.js';
type Packet = { id?: string; reply?: string; type?: string; data?: any; error?: string };
const port = chrome.runtime.connect({ name: 'autoum-ui' });
const requests = new PortRpc(port, () => chrome.runtime.lastError?.message || 'Extension port disconnected. Reconnect to continue.');
function call(type: string, data?: any): Promise<any> {
  return requests.request(type, data);
}
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(src)) node.removeAttribute('src');
    node.setAttribute('loading', 'lazy'); node.setAttribute('referrerpolicy', 'no-referrer');
  }
});
const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text, html => DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: chatLinkPattern, FORBID_TAGS: ['form', 'input', 'iframe', 'style'], FORBID_ATTR: ['style'] })), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
function StreamingMarkdown({ text }: { text: string }) {
  const visibleText = React.useDeferredValue(text);
  return <Markdown text={visibleText} />;
}
function ChatMessage({ message, chatId, index }: { message: any; chatId: string; index: number }) {
  const [fullText, setFullText] = useState<string>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const pending = useRef<Promise<string> | undefined>(undefined), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const truncated = message.textLength > message.text.length;
  const read = () => fullText !== undefined ? Promise.resolve(fullText) : pending.current ||= loadMessageText(chatId, index, call).finally(() => { pending.current = undefined; });
  const expand = async () => {
    setLoading(true); setError('');
    try { const text = await read(); if (mounted.current) setFullText(text); }
    catch (e: any) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setLoading(false); }
  };
  const text = fullText ?? message.text;
  return <article className={'message ' + message.role}>
    <div className="message-label">{message.role === 'user' ? 'You' : 'Autoum'}<div className="message-actions">
      {truncated && <button className="full-message" disabled={loading} onClick={() => fullText === undefined ? expand() : setFullText(undefined)}>{loading ? 'Loading…' : fullText === undefined ? 'Show full message' : 'Show less'}</button>}
      {message.role === 'assistant' && message.text && <CopyReply text={text} loadText={truncated && fullText === undefined ? read : undefined} />}
    </div></div>
    {message.role === 'user' ? <div className="user-text"><Markdown text={text} /></div> : <Markdown text={text} />}
    {truncated && fullText === undefined && <small className="message-preview-note">Showing the beginning of this message.</small>}
    {error && <p className="error" role="status">{error}</p>}
    {message.attachments?.length > 0 && <div className="message-attachments">{message.attachments.map((item: Attachment) => <FileAttachment key={item.id} item={item} chatId={chatId} call={call} />)}</div>}
  </article>;
}
function UsageBar({ account, chatId }: { account: any; chatId?: string }) {
  const [usage, setUsage] = useState<any>(); const [loading, setLoading] = useState(false);
  const refresh = async (force = false) => {
    setLoading(true);
    try { setUsage(await call('account_usage', { accountId: account.id, chatId, refresh: force })); }
    catch { setUsage({ windows: [], message: 'Usage unavailable.' }); } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, [account.id, account.configured]);
  const windows = usage?.windows || [];
  return <div className="account-usage" aria-label={'Usage for ' + (account.email || account.label)}>
    <div className="usage-heading"><span>Usage</span><button disabled={loading || !account.configured} title="Refresh usage" aria-label={'Refresh usage for ' + account.label} onClick={() => refresh(true)}>↻</button></div>
    {windows.length ? windows.map((window: any) => <div className="usage-window" key={window.label}>
      <div className="usage-label"><span>{window.label}</span><span>{Math.round(window.usedPercent)}% used</span></div>
      <div className={'usage-track ' + (window.usedPercent >= 90 ? 'high' : '')} role="progressbar" aria-label={window.label + ' usage'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}><span style={{ width: window.usedPercent + '%' }} /></div>
      {window.detail && <small>{window.detail}</small>}
      {window.resetsAt && <small title={new Date(window.resetsAt).toLocaleString()}>Resets {new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</small>}
    </div>) : <><div className="usage-track unavailable" /><small>{loading ? 'Checking usage…' : usage?.message || 'Usage unavailable.'}</small></>}
    {usage?.status === 'stale' && <small>{usage.message} Showing the last reported usage.</small>}
    {usage?.checkedAt && windows.length > 0 && <small>Updated {new Date(usage.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}
  </div>;
}
function MemorySettings({ enabled, lines, busy }: { enabled: boolean; lines: number; busy: boolean }) {
  const [options, setOptions] = useState({ enabled, lines }); const [saving, setSaving] = useState(false);
  useEffect(() => { if (!saving) setOptions({ enabled, lines }); }, [enabled, lines, saving]);
  const saveOptions = async (next: typeof options) => { setOptions(next); setSaving(true); setError(''); try { await call('memory_settings', next); } catch (e: any) { setOptions({ enabled, lines }); setError(e.message); } finally { setSaving(false); } };
  const [data, setData] = useState<any>(); const [query, setQuery] = useState('');
  const [text, setText] = useState(''); const [editing, setEditing] = useState<number>(); const [error, setError] = useState('');
  const load = async () => setData(await call('memory_list', { query }));
  const change = async (operation: () => Promise<any>) => { setError(''); try { await operation(); await load(); } catch (e: any) { setError(e.message); } };
  useEffect(() => { let current = true; call('memory_list', { query }).then(value => { if (current) setData(value); }).catch(e => { if (current) setError(e.message); }); return () => { current = false; }; }, [query]);
  return <section className="memory-settings" aria-label="Memory settings"><h3>Memory</h3><p className="muted">Autoum automatically remembers useful preferences and lasting context. OptMem keeps notes on this computer and shares them across your chats and AI accounts.</p>
    <label className="model-toggle"><input type="checkbox" aria-label="Remember useful preferences" checked={options.enabled} disabled={busy || saving} onChange={e => saveOptions({ ...options, enabled: e.target.checked })} />Remember useful preferences</label>
    <label>Memory context<select aria-label="Memory context" value={options.lines} disabled={busy || saving} onChange={e => saveOptions({ ...options, lines: Number(e.target.value) })}>{[8, 16, 32, 64, 96].map(n => <option key={n} value={n}>{n} notes · {n === 32 ? 'default' : n < 32 ? 'lighter' : 'more detail'}</option>)}</select></label>
    <details><summary>Saved memories{data ? ' · ' + data.count : ''}</summary><input aria-label="Search memories" placeholder="Search saved memories…" value={query} onChange={e => setQuery(e.target.value)} />
      <form onSubmit={e => { e.preventDefault(); change(async () => { await call(editing === undefined ? 'memory_note' : 'memory_edit', { id: editing, text }); setText(''); setEditing(undefined); }); }}><label>{editing === undefined ? 'Add a memory' : 'Edit memory'}<textarea aria-label="Memory note" value={text} onChange={e => setText(e.target.value)} rows={3} /></label><button disabled={!text.trim()}>{editing === undefined ? 'Save memory' : 'Save correction'}</button>{editing !== undefined && <button type="button" onClick={() => { setEditing(undefined); setText(''); }}>Cancel</button>}</form>
      {data?.entries.map((entry: any) => <div className="memory-entry" key={entry.id}><p>{entry.text}</p><small>{entry.date}</small><div><button aria-label={'Edit memory ' + entry.id} onClick={() => { setEditing(entry.id); setText(entry.text); }}>Edit</button><button className="danger" aria-label={'Forget memory ' + entry.id} onClick={() => change(() => call('memory_delete', { id: entry.id }))}>Forget</button></div></div>)}
      {data?.entries.length === 0 && <p className="muted">No saved memories.</p>}<button className="danger" disabled={!data?.count} onClick={() => { if (confirm('Permanently clear all saved memories? Your chats remain saved.')) change(() => call('memory_clear', { confirm: true })); }}>Clear all memories</button>
    </details>{error && <p className="error">{error}</p>}</section>;
}
function App() {
  const [state, setState] = useState<any>(); const [chatId, setChatId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [ready, setReady] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState('browser'); const [browserTheme, setBrowserTheme] = useState('system');
  const [chatTextScale, setChatTextScale] = useState(1.125);
  const [fontSize, setFontSize] = useState(0); const [browserFontSize, setBrowserFontSize] = useState(16);
  const [settings, setSettings] = useState(false); const [showChats, setShowChats] = useState(false);
  const [showArchived, setShowArchived] = useState(false); const [chatMenu, setChatMenu] = useState(''); const [refreshingModels, setRefreshingModels] = useState('');
  const [chatSearch, setChatSearch] = useState(''); const [folderFilter, setFolderFilter] = useState('all');
  const [folderDraft, setFolderDraft] = useState(''); const [folderForm, setFolderForm] = useState<'new' | 'rename' | undefined>();
  const [renameChat, setRenameChat] = useState(false); const [chatTitle, setChatTitle] = useState('');
  const [approvals, setApprovals] = useState<Packet[]>([]); const [auth, setAuth] = useState<Packet>(); const [authValue, setAuthValue] = useState('');
  const [approvalMode, setApprovalMode] = useState('ask');
  const [loginStatus, setLoginStatus] = useState(''); const [loginBusy, setLoginBusy] = useState(false);
  const [accountForm, setAccountForm] = useState<{ provider: string; id?: string; label: string; method: string }>();
  const [accountKey, setAccountKey] = useState(''); const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState(''); const [skills, setSkills] = useState(''); const [extensions, setExtensions] = useState('');
  const [artifactFolder, setArtifactFolder] = useState('');
  const [fileDrafts, setFileDrafts] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(false); const fileInput = useRef<HTMLInputElement>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [modelSearch, setModelSearch] = useState('');
  const [showControls, setShowControls] = useState(true);
  const focusProvider = useRef(false);
  const compose = useRef<HTMLTextAreaElement>(null); const providerSelect = useRef<HTMLSelectElement>(null);
  const sending = useRef(false);
  const exportRunning = useRef(false); const [exporting, setExporting] = useState(false);
  const chat = state?.chats.find((c: any) => c.id === chatId) || state?.chats.find((c: any) => c.id === state.activeChatId) || state?.chats[0];
  const earlierPage = chat?.historyEnd < chat?.historyTotal;
  const input = drafts[chat?.id] || '';
  const setInput = (text: string) => setDrafts(d => ({ ...d, [chat.id]: text }));
  const voiceChat = useRef(chat); voiceChat.current = chat;
  const native = useVoice(chat?.id, chat?.voiceCapability, call, port);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const fallbackEnabled = fallbackAvailable && native.preferences.fallbackEnabled && !chat?.voiceCapability?.supported && state?.accounts.some((a: any) => a.id === chat?.accountId && a.configured);
  const localSpeechPreferences = useRef(native.preferences); localSpeechPreferences.current = native.preferences;
  const fallback = useLocalVoice(chat?.id, !!fallbackEnabled, native.preferences.fallbackVoice, async (id, text, conversation, signal) => {
    const reply = await localVoiceTurn(id, text, conversation, call, port, signal, voiceChat.current?.historyTotal ?? voiceChat.current?.messages.length ?? 0);
    return localSpeechPreferences.current.speakReplies ? reply : undefined;
  });
  const voice = chat?.voiceCapability?.supported ? native : { ...fallback, preferences: native.preferences, setPreferences: native.setPreferences };
  const voiceAvailable = chat?.voiceCapability?.supported || fallbackEnabled;
  useEffect(() => { fetch(chrome.runtime.getURL('voice-models/manifest.json')).then(r => { if (r.ok) setFallbackAvailable(true); }).catch(() => {}); }, []);
  const replyWatch = useRef({ id: '', busy: false, started: 0 });
  useEffect(() => {
    if (!chat) return; const watch = replyWatch.current;
    if (fallback.conversationActive) { replyWatch.current = { id: chat.id, busy: !!chat.busy, started: chat.messages.length }; return; }
    if (watch.id !== chat.id) { replyWatch.current = { id: chat.id, busy: !!chat.busy, started: chat.messages.length }; return; }
    if (chat.busy && !watch.busy) watch.started = chat.messages.length;
    if (!chat.busy && watch.busy && chat.messages.length > watch.started && fallbackEnabled && native.preferences.speakReplies) {
      if (fallback.phase !== 'idle') return;
      const last = [...chat.messages].reverse().find((m: any) => m.role === 'assistant'); if (last?.text) void fallback.speak(last.text);
    }
    watch.busy = !!chat.busy;
  }, [chat?.id, chat?.busy, chat?.messages.length, fallback.phase, fallback.conversationActive]);
  const provider = state?.providers.find((p: any) => p.id === chat?.provider);
  const visibleModels = (p: any) => (p?.models || []).filter((m: any) => !(state?.hiddenModels?.[p.id] || []).includes(m.id));
  const selectedProvider = provider ? { ...provider, models: provider.accountModels?.[chat?.accountId] || provider.models } : provider;
  const modelChoices = visibleModels(selectedProvider);
  const selectedModel = selectedProvider?.models.find((m: any) => m.id === chat?.model);
  const reasoningLevels = chat?.provider === 'antigravity' ? selectedModel?.variants?.map((v: any) => v.thinking) || [] : selectedModel?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : [];
  const modelChoice = (model: any, thinking = chat?.thinking || 'medium') => ({ model: model.id, thinking: model.variants && !model.variants.some((v: any) => v.thinking === thinking) ? model.variants.find((v: any) => v.thinking === 'medium')?.thinking || model.variants[0].thinking : thinking });
  const providerAccounts = state?.accounts.filter((a: any) => a.provider === chat?.provider) || [];
  const account = providerAccounts.find((a: any) => a.id === chat?.accountId);
  useEffect(() => {
    if (!account?.configured) return;
    call('refresh_models', { accountId: account.id, chatId: chat?.id, automatic: true }).catch(() => {});
  }, [account?.id, account?.configured]);
  const folders = state?.folders || [];
  const run = async (fn: () => Promise<any>) => { setError(''); try { return await fn(); } catch (e: any) { setError(e.message); } };
  const reconnect = () => { if (requests.closed) window.location.reload(); else void run(() => call('state').then(setState)); };
  useEffect(() => {
    const listener = (packet: Packet) => {
      if (packet.type === 'state') { setState(packet.data); setChatId(packet.data.activeChatId || packet.data.chats[0]?.id || ''); }
      if (packet.type === 'delta') setState((s: any) => s && ({ ...s, chats: s.chats.map((c: any) => c.id === packet.data.chatId ? { ...c, current: (c.current || '') + packet.data.text } : c) }));
      if (packet.type === 'disconnected') setError('The local agent is unavailable. Run Autoum’s installer, then choose Reconnect. ' + packet.data.error);
      if (packet.type === 'approval') setApprovals(prev => prev.some(p => p.id === packet.id) ? prev : [...prev, packet]);
      if (packet.type === 'auth_prompt') { setAuth(packet); setAuthValue(''); }
      if (packet.type === 'auth_event') setLoginStatus(packet.data.message || packet.data.instructions || (packet.data.userCode ? 'Use this code: ' + packet.data.userCode : 'Finish sign-in in the browser tab.'));
      if (packet.type === 'notice') setNotice(packet.data.text);
      if (packet.type === 'interaction_cancelled') { setApprovals(prev => prev.filter(p => p.id !== packet.data.id)); setAuth(prev => prev?.id === packet.data.id ? undefined : prev); }
    };
    const disconnected = () => { void native.cancel(); fallback.cancel(); setError('Sidebar connection lost. Choose Reconnect to continue.'); };
    port.onMessage.addListener(listener); port.onDisconnect.addListener(disconnected); call('state').then(s => { setState(s); setChatId(s.activeChatId || s.chats[0]?.id || ''); }).catch(e => setError(e.message));
    chrome.storage.local.get(['theme', 'fontSize', 'drafts', 'folderFilter', 'showControls', 'chatTextScale', 'voice', 'fileDrafts']).then(v => {
      voice.setPreferences(voicePreferences(v.voice));
      setChatTextScale([1, 1.125, 1.25, 1.5].includes(v.chatTextScale) ? v.chatTextScale : 1.125);
      setTheme(['light', 'dark'].includes(v.theme) ? v.theme : 'browser'); setFontSize(typeof v.fontSize === 'number' && v.fontSize >= 12 && v.fontSize <= 32 ? v.fontSize : 0);
      setFileDrafts(v.fileDrafts || {}); setDrafts(v.drafts || {}); setFolderFilter(v.folderFilter || 'all'); setShowControls(v.showControls !== false); setReady(true);
    });
    return () => { port.onMessage.removeListener(listener); port.onDisconnect.removeListener(disconnected); };
  }, []);
  useEffect(() => {
    const refresh = () => call('browser_appearance').then(v => setBrowserTheme(v.theme)).catch(() => {});
    refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const changed = (details: { pixelSize: number }) => setBrowserFontSize(details.pixelSize);
    chrome.fontSettings.getDefaultFontSize((details: { pixelSize: number }) => { if (!chrome.runtime.lastError) changed(details); });
    chrome.fontSettings.onDefaultFontSizeChanged.addListener(changed);
    return () => chrome.fontSettings.onDefaultFontSizeChanged.removeListener(changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'browser' ? browserTheme : theme;
    document.documentElement.style.setProperty('--chat-text-scale', String(chatTextScale));
    document.documentElement.style.fontSize = (fontSize || browserFontSize) + 'px';
    if (ready) chrome.storage.local.set({ theme, fontSize, folderFilter, showControls, chatTextScale });
  }, [theme, fontSize, browserFontSize, browserTheme, folderFilter, showControls, chatTextScale, ready]);
  useEffect(() => { if (ready) chrome.storage.local.set({ fileDrafts }); }, [fileDrafts, ready]);
  useEffect(() => setArtifactFolder(state?.artifactsDir || ''), [state?.artifactsDir]);
  useEffect(() => { if (ready) chrome.storage.local.set({ voice: voice.preferences }); }, [voice.preferences, ready]);
  useEffect(() => { if (focusProvider.current && providerSelect.current) { providerSelect.current.focus(); focusProvider.current = false; } }, [showControls, settings]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => chrome.storage.local.set({ drafts }), 300); return () => clearTimeout(timer); }, [drafts, ready]);
  useEffect(() => { if (chat) { setFolder(chat.cwd); setChatTitle(chat.title); setApprovals(prev => prev.filter(p => state.chats.find((c: any) => c.id === p.data.chatId)?.busy)); } }, [chat?.id, chat?.cwd, chat?.busy]);
  useEffect(() => { if (chat?.id) call('view_chat', { chatId: chat.id }).catch(e => setError(e.message)); }, [chat?.id]);
  useEffect(() => { if (folderFilter !== 'all' && folderFilter !== 'unfiled' && state && !folders.some((f: any) => f.id === folderFilter)) setFolderFilter('all'); }, [state?.folders, folderFilter]);
  useEffect(() => { setSkills((state?.skillPaths || []).join('\n')); setExtensions((state?.extensionPaths || []).join('\n')); }, [state?.skillPaths?.join(), state?.extensionPaths?.join()]);
  useEffect(() => { setApprovalMode(approvals[0]?.data.mode || 'ask'); }, [approvals[0]?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 'm') { event.preventDefault(); if (voice.conversationActive) return; if (['idle', 'connected'].includes(voice.phase)) { if (chat?.voiceCapability?.supported) native.start(true, 'push'); else fallback.start(); } else if (voice.phase === 'recording') voice.stopRecording(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); focusProvider.current = true; setSettings(false); setShowControls(true); if (providerSelect.current?.getClientRects().length) { providerSelect.current.focus(); focusProvider.current = false; } }
      if (event.key === 'Escape') { voice.cancel(); voice.stopSpeaking(); if (!loginBusy) setAccountForm(undefined); if (chat?.busy) run(() => call('stop', { chatId: chat.id })); }
    }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [chat?.id, chat?.busy, loginBusy, voice.phase, voice.conversationActive]);
  const endVoice = () => voice.cancel();
  const update = (values: any) => call('update_chat', { chatId: chat.id, ...values });
  const setVisibility = async (provider: string, hidden: string[]) => {
    setState((s: any) => ({ ...s, hiddenModels: { ...s.hiddenModels, [provider]: hidden } }));
    try { return await call('model_visibility', { provider, hidden }); }
    catch (error) { call('state').then(setState).catch(() => {}); throw error; }
  };
  const newChat = async () => { const c = await call('new_chat', { folderId: folders.some((f: any) => f.id === folderFilter) ? folderFilter : undefined }); setChatId(c.id); setSettings(false); setRenameChat(false); setShowArchived(false); compose.current?.focus(); };
  const send = async () => {
    if ((!input.trim() && !fileDrafts[chat.id]?.length) || uploading || sending.current || !['idle', 'connected'].includes(voice.phase)) return; voice.stopSpeaking(); const text = input, id = chat.id; sending.current = true; setDrafts(d => ({ ...d, [id]: '' }));
    try { if (chat.voiceCapability?.supported && voice.phase === 'idle') await native.start(false, 'push'); const result = await call('send', { chatId: id, text, attachments: (fileDrafts[id] || []).map(a => a.id) }); if (result?.cancelled) setDrafts(d => ({ ...d, [id]: d[id] || text })); else setFileDrafts(d => ({ ...d, [id]: [] })); } catch (e: any) { setError(e.message); setDrafts(d => ({ ...d, [id]: d[id] || text })); } finally { sending.current = false; }
  };
  const addFiles = async (files: File[]) => {
    if (!chat || uploading) return; const id = chat.id;
    if ((fileDrafts[id]?.length || 0) + files.length > 10) { setError('Attach up to 10 files per message.'); return; }
    setUploading(true); setError('');
    try { for (const file of files) { const item = await uploadAttachment(file, id, call); setFileDrafts(d => { const next = { ...d, [id]: [...(d[id] || []), item] }; chrome.storage.local.set({ fileDrafts: next }); return next; }); } }
    catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };
  const chooseProvider = async (id: string) => {
    const p = state.providers.find((p: any) => p.id === id), last = state.lastModels[id];
    const selected = state.accounts.find((a: any) => a.id === last?.accountId && a.provider === id && a.configured) || state.accounts.find((a: any) => a.provider === id && a.configured);
    const available = visibleModels({ ...p, models: p.accountModels?.[selected?.id] || p.models });
    const model = available.find((m: any) => m.id === last?.model) || available[0];
    if (!model) throw Error('All models for this provider are hidden. Show a model in Settings first.');
    await update({ provider: id, ...modelChoice(model, last?.thinking || chat.thinking), accountId: selected?.id || '' });
  };
  const chooseAccount = async (id: string) => {
    const last = state.lastAccountModels?.[id];
    const available = visibleModels({ ...provider, models: provider.accountModels?.[id] || provider.models });
    const model = available.find((m: any) => m.id === last?.model) || available.find((m: any) => m.id === chat.model) || available[0];
    if (!model) throw Error('Show an available model in Settings first.');
    await update({ accountId: id, ...modelChoice(model, last?.thinking || chat.thinking) });
  };
  const exportData = async () => {
    if (exportRunning.current) return;
    exportRunning.current = true; setExporting(true);
    try {
      const text = await loadChatExport(call), url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      try { await chrome.downloads.download({ url, filename: 'autoum-conversations.json', saveAs: true }); } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
    } finally { exportRunning.current = false; setExporting(false); }
  };
  const signIn = async (p: any, method: string, key?: string, id?: string, label?: string) => {
    setLoginBusy(true); setLoginStatus('Connecting…');
    try { const result = await call('login', { provider: p.id, method, key, accountId: id, label, chatId: chat?.id });
      setLoginStatus('Connected.'); setKeys(k => ({ ...k, [p.id]: '' })); setAccountKey(''); setAccountForm(undefined); return result;
    } finally { setLoginBusy(false); setAuth(undefined); }
  };
  const editAccount = (p: any, a?: any) => { setAccountKey(''); setAccountForm({ provider: p.id, id: a?.id, label: a?.label || '', method: a?.method || (p.login ? 'oauth' : 'api_key') }); };
  const respond = (packet: Packet, value: any) => { port.postMessage({ reply: packet.id, data: value }); setApprovals(prev => prev.filter(p => p.id !== packet.id)); };
  const openLink = (event: React.MouseEvent) => {
    const anchor = (event.target as Element).closest('a[href]'); if (!anchor || event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault(); const href = anchor.getAttribute('href') || '';
    run(async () => {
      if (href.startsWith('#')) { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); return; }
      const url = chatLinkUrl(href, { cwd: chat?.cwd, home: state?.home, artifactsDir: state?.artifactsDir });
      if (event.shiftKey) await chrome.windows.create({ url: url.href });
      else await call('local_browser', { action: 'open', url: url.href, active: !(event.ctrlKey || event.metaKey || event.button === 1), viewer: true });
    });
  };
  const filteredChats = (state?.chats || []).filter((c: any) => !!c.archived === showArchived && (folderFilter === 'all' || folderFilter === 'unfiled' && !c.folderId || c.folderId === folderFilter) && c.title.toLowerCase().includes(chatSearch.toLowerCase()));
  const deleteChat = (id: string) => run(async () => { if (confirm('Delete this chat and its conversation history?')) { await call('delete_chat', { chatId: id }); setChatMenu(''); setDrafts(d => { const next = { ...d }; delete next[id]; return next; }); } });
  const deleteCurrent = () => deleteChat(chat.id);
  const formProvider = state?.providers.find((p: any) => p.id === accountForm?.provider);
  return <div className="app" onClick={openLink} onAuxClick={openLink}>
    <header><div className="brand"><img src="logo.svg" alt="" className="brand-logo" /><strong>Autoum</strong></div><div className="header-actions"><button aria-label="Chats and folders" className={showChats && !settings ? 'selected' : ''} onClick={() => { setShowChats(!showChats); setSettings(false); }}>Chats</button><button title="New chat" aria-label="New chat" onClick={() => run(newChat)}>＋</button><button title="Settings" aria-label="Settings" className={settings ? 'selected' : ''} onClick={() => setSettings(!settings)}>⚙</button></div></header>
    {!state && <div className="empty"><p>Connecting to your local agent…</p><button onClick={reconnect}>Reconnect</button></div>}
    {state && showChats && !settings && <section className="chat-browser" aria-label="Chats and folders">
      <div className="folder-controls"><select aria-label="Chat folder" value={folderFilter} onChange={e => setFolderFilter(e.target.value)}><option value="all">All chats</option><option value="unfiled">Unfiled</option>{folders.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select><button aria-label="New chat folder" onClick={() => { setFolderForm('new'); setFolderDraft(''); }}>＋ Folder</button></div>
      {folders.some((f: any) => f.id === folderFilter) && <div className="folder-actions"><button onClick={() => { setFolderForm('rename'); setFolderDraft(folders.find((f: any) => f.id === folderFilter).name); }}>Rename folder</button><button onClick={() => run(async () => { await call('delete_folder', { folderId: folderFilter }); setFolderFilter('all'); })}>Remove folder</button></div>}
      {folderForm && <form className="inline-form" onSubmit={e => { e.preventDefault(); run(async () => {
        if (folderForm === 'new') { const f = await call('create_folder', { name: folderDraft }); setFolderFilter(f.id); }
        else await call('rename_folder', { folderId: folderFilter, name: folderDraft }); setFolderForm(undefined); setFolderDraft('');
      }); }}><input autoFocus aria-label="Folder name" value={folderDraft} onChange={e => setFolderDraft(e.target.value)} placeholder="Folder name" maxLength={80} /><button type="submit" disabled={!folderDraft.trim()}>Save</button><button type="button" onClick={() => setFolderForm(undefined)}>×</button></form>}
      <input className="chat-search" aria-label="Search chats" value={chatSearch} onChange={e => setChatSearch(e.target.value)} placeholder="Search chats…" />
      <div className="chat-view-controls"><button aria-pressed={!showArchived} onClick={() => { setShowArchived(false); setChatMenu(''); }}>Chats</button><button aria-pressed={showArchived} onClick={() => { setShowArchived(true); setChatMenu(''); }}>Archived</button></div>
      <div className="chat-list">{[...filteredChats].sort((a: any, b: any) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0)).map((c: any) => <div className="chat-entry" key={c.id}><div className="chat-entry-heading"><button className={'chat-row ' + (c.id === chat?.id ? 'active' : '')} onClick={() => { setChatId(c.id); setRenameChat(false); }}><span>{c.pinned ? '⌖ ' : ''}{c.title}</span>{c.busy ? <span className="pulse" /> : drafts[c.id] ? <small>Draft</small> : null}</button><button className="chat-menu-toggle" aria-label={'Chat options for ' + c.title} aria-expanded={chatMenu === c.id} onClick={() => setChatMenu(chatMenu === c.id ? '' : c.id)}>⋯</button></div>{chatMenu === c.id && <div className="chat-actions" role="group" aria-label={'Actions for ' + c.title}><button onClick={() => run(() => call('chat_flags', { chatId: c.id, pinned: !c.pinned }))}>{c.pinned ? 'Unpin' : 'Pin'}</button><button disabled={c.busy} onClick={() => run(async () => { await call('chat_flags', { chatId: c.id, archived: !c.archived }); setChatMenu(''); })}>{c.archived ? 'Restore' : 'Archive'}</button><button className="danger" onClick={() => deleteChat(c.id)}>Delete</button></div>}</div>)}{!filteredChats.length && <p className="muted">{showArchived ? 'No archived chats in this folder.' : 'No chats in this folder.'}</p>}</div>
    </section>}
    {state && settings ? <main className="settings">
      <h2>Settings</h2>
      <label>New chat permission mode<select aria-label="New chat permission mode" value={state.lastMode} onChange={e => run(() => call('defaults', { mode: e.target.value }))}><option value="ask">Ask</option><option value="auto-review">Auto-review</option><option value="all">Always allow</option></select></label><p className="muted">Changing a chat’s mode also remembers it for the next chat.</p>
      <label>Appearance<select value={theme} onChange={e => setTheme(e.target.value)}><option value="browser">Follow browser</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <button onClick={() => chrome.tabs.create({ url: 'chrome://settings/appearance' })}>Browser appearance settings</button><p className="muted">On Linux, turn off “Use system title bar and borders” to remove the extra window title row.</p>
      <label>Font size<select aria-label="Font size" value={fontSize ? 'custom' : 'browser'} onChange={e => setFontSize(e.target.value === 'browser' ? 0 : browserFontSize)}><option value="browser">Follow browser · {browserFontSize}px</option><option value="custom">Custom</option></select></label>
      {fontSize > 0 && <label className="font-control">Sidebar font · {fontSize}px<input aria-label="Sidebar font size" type="range" min={12} max={32} step={1} value={fontSize} onChange={e => setFontSize(Number(e.target.value))} /></label>}
      <label>Chat text size<select aria-label="Chat text size" value={chatTextScale} onChange={e => setChatTextScale(Number(e.target.value))}><option value={1}>Standard</option><option value={1.125}>Larger · default</option><option value={1.25}>Large</option><option value={1.5}>Extra large</option></select></label>
      <MemorySettings enabled={state.memoryEnabled} lines={state.memoryLines} busy={state.chats.some((c: any) => c.busy)} />
      <h3>Models</h3><p className="muted">Choose which models appear in the dropdown. Your last model and account are remembered for each provider. Hiding a model keeps existing chats intact.</p>
      <input aria-label="Search models" placeholder="Search models…" value={modelSearch} onChange={e => setModelSearch(e.target.value)} />
      {state.providers.filter((p: any) => p.models.length).map((p: any) => <details className="model-settings" key={p.id} open={modelSearch ? true : undefined}><summary>{p.name} · {visibleModels(p).length}/{p.models.length} shown</summary><div className="model-actions"><button onClick={() => run(() => setVisibility(p.id, []))}>Show all</button><button onClick={() => run(() => setVisibility(p.id, p.models.map((m: any) => m.id)))}>Hide all</button></div><div className="model-list">{p.models.filter((m: any) => (m.name + ' ' + m.id).toLowerCase().includes(modelSearch.toLowerCase())).map((m: any) => <label className="model-toggle" key={m.id}><input type="checkbox" aria-label={'Show ' + p.id + '/' + m.id} checked={!(state.hiddenModels?.[p.id] || []).includes(m.id)} onChange={e => run(() => setVisibility(p.id, e.target.checked ? (state.hiddenModels?.[p.id] || []).filter((id: string) => id !== m.id) : [...(state.hiddenModels?.[p.id] || []), m.id]))} /><span>{m.name}<small>{m.id}</small></span></label>)}</div></details>)}
      <div className="section-heading"><h3>AI accounts</h3><button onClick={() => run(() => call('detect_accounts'))}>Detect accounts</button></div>
      {state.providers.filter((p: any) => p.id !== 'typesafe').map((p: any) => <section className="provider-card" key={p.id} aria-label={p.name + ' accounts'}>
        <div className="provider-title"><strong>{p.name}</strong><button disabled={loginBusy || p.id === 'antigravity' && !p.installed} onClick={() => editAccount(p)}>＋ Add account</button></div>
        {p.id === 'antigravity' && <><p className="muted">{p.ideFound || p.cliFound ? 'Installed Antigravity found. ' : ''}{p.installed ? 'Browser connector ready.' : 'Google’s separate browser connector is needed.'}</p>{!p.installed && <button disabled={loginBusy || !!refreshingModels} onClick={() => run(() => call('install_antigravity'))}>Install browser connector</button>}</>}
        {state.accounts.filter((a: any) => a.provider === p.id).map((a: any) => <div className="account-row" key={a.id}>
          <div className="account-identity"><strong>{a.email || a.label}</strong><span className={'status ' + (a.configured ? 'connected' : '')}>{a.configured ? 'Connected' : 'Disconnected'}</span></div>
          <p className="account-detail">{a.method === 'oauth' ? 'Account sign-in' : 'API-key connection'}{a.email ? ' · ' + a.label : ''}{a.source ? ' · Found in ' + a.source : ''}</p>
          {!a.email && a.method === 'oauth' && <small>The provider has not shared an email. Your account label is shown.</small>}
          <UsageBar account={a} chatId={chat?.id} />
          <button aria-label={'Refresh models for ' + a.label} disabled={!a.configured || loginBusy || !!refreshingModels || state.chats.some((c: any) => c.accountId === a.id && c.busy)} onClick={() => run(async () => { setRefreshingModels(a.id); try { await call('refresh_models', { accountId: a.id, chatId: chat?.id }); } finally { setRefreshingModels(''); } })}>{refreshingModels === a.id ? 'Refreshing models…' : 'Refresh models'}</button>
          {(p.accountCatalogs?.[a.id]?.checkedAt || p.catalog?.checkedAt) && <small>Models updated {new Date(p.accountCatalogs?.[a.id]?.checkedAt || p.catalog.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · updates automatically</small>}
          {p.accountCatalogs?.[a.id]?.error && <small>{p.accountCatalogs[a.id].error}</small>}
          {refreshingModels === a.id && <button onClick={() => run(() => call('cancel_login'))}>Cancel refresh</button>}
          <details><summary>Manage account</summary><div className="key-form"><input aria-label={'Account label for ' + a.id} value={accountLabels[a.id] ?? a.label} onChange={e => setAccountLabels(v => ({ ...v, [a.id]: e.target.value }))} maxLength={80} /><button onClick={() => run(() => call('rename_account', { accountId: a.id, label: accountLabels[a.id] ?? a.label }))}>Rename</button></div><button disabled={loginBusy || !!refreshingModels} onClick={() => editAccount(p, a)}>{a.configured ? 'Change sign-in' : 'Reconnect'}</button>{a.configured && <button className="subtle" disabled={loginBusy || !!refreshingModels} onClick={() => run(() => call('logout', { provider: p.id, accountId: a.id }))}>Disconnect</button>}</details>
        </div>)}
        {!state.accounts.some((a: any) => a.provider === p.id) && <p className="muted">No account connected.</p>}
        {p.id.startsWith('opencode') && <a href="https://opencode.ai/auth">OpenCode account ↗</a>}
      </section>)}
      {loginStatus && <div className="notice">{loginStatus}{loginBusy && <button onClick={() => run(() => call('cancel_login'))}>Cancel sign-in</button>}</div>}
      <h3>Fast browsing</h3><p className="muted">Jev uses its own provider and account, independently of your chat model. Use ChatGPT or Claude with Jev from TypeSafe.ai, OpenRouter or OpenCode. Every decision is checked; normal browsing continues if Jev is unavailable.</p>
      {[{ id: 'typesafe', name: 'TypeSafe.ai', url: 'https://console.typesafe.ai/keys' }, { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys' }, { id: 'opencode', name: 'OpenCode', url: 'https://opencode.ai/auth' }].map(connection => {
        const p = state.providers.find((p: any) => p.id === connection.id), accounts = state.accounts.filter((a: any) => a.provider === p.id);
        const a = accounts.find((a: any) => a.id === state.decisionAccounts[p.id]) || accounts.find((a: any) => a.configured);
        return <section className="provider-card" key={p.id} aria-label={connection.name + ' Jev connection'}><div className="provider-title"><strong>{connection.name}</strong><span className={'status ' + (a?.configured ? 'connected' : '')}>{a?.configured ? 'Key connected' : 'Not connected'}</span></div>
          {accounts.length > 0 && <label>Decision account<select aria-label={connection.name + ' decision account'} value={a?.id || ''} onChange={e => run(() => call('configure', { decisionAccounts: { [p.id]: e.target.value } }))}>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.email || a.label}{a.configured ? '' : ' · disconnected'}</option>)}</select></label>}
          <div className="key-form"><input type="password" autoComplete="off" aria-label={connection.name + ' Jev API key'} value={keys[p.id] || ''} onChange={e => setKeys(k => ({ ...k, [p.id]: e.target.value }))} placeholder={a?.configured ? 'Replace API key' : 'API key'} /><button disabled={loginBusy || !keys[p.id]} onClick={() => run(() => signIn(p, 'api_key', keys[p.id], a?.id))}>{a?.configured ? 'Replace' : 'Connect'}</button></div><a href={connection.url}>Get a key ↗</a>{a?.configured && <button className="subtle" onClick={() => run(() => call('logout', { provider: p.id, accountId: a.id }))}>Disconnect</button>}
          {p.id === 'typesafe' && accounts.map((a: any) => <div className="account-row" key={a.id}><strong>{a.label}</strong><UsageBar account={a} chatId={chat?.id} /></div>)}
        </section>;
      })}
      <label>Fast browsing model<select value={state.decisionModel ? state.decisionModel.provider + '/' + state.decisionModel.id : ''} onChange={e => run(() => { const model = state.classifiers.find((m: any) => m.provider + '/' + m.id === e.target.value); return call('configure', { decisionModel: model ? { provider: model.provider, id: model.id } : null }); })}><option value="">Automatic · connected free model</option>{state.classifiers.map((m: any) => <option disabled={!m.configured} value={m.provider + '/' + m.id} key={m.provider + '/' + m.id}>{m.name} · {state.providers.find((p: any) => p.id === m.provider)?.name || m.provider}{!m.configured ? ' (connect first)' : ''}</option>)}</select></label>
      <h3>Artifacts</h3><p className="muted">Autoum creates this folder automatically. Created files and pasted attachments stay here, organized by chat. HTML briefs use the same Autoum layout.</p><label>Artifacts folder<input aria-label="Artifacts folder" value={artifactFolder} onChange={e => setArtifactFolder(e.target.value)} /></label><button disabled={state.chats.some((c: any) => c.busy)} onClick={() => run(() => call('configure', { artifactsDir: artifactFolder }))}>Save artifacts folder</button><button onClick={() => run(() => call('open_research_folder'))}>Open artifacts folder</button>{state.artifactError && <p className="error">{state.artifactError}</p>}
      <h3>Computer access</h3><label>Working folder<input value={folder} onChange={e => setFolder(e.target.value)} /><button disabled={chat?.busy} onClick={() => run(() => update({ cwd: folder }))}>Use folder</button></label><p className="muted">Downloads: {state.downloads}</p>
      <Integrations state={state} chatId={chat?.id} call={call} run={run} />
      <section aria-label="Voice settings"><h3>Voice</h3><p className="muted">{chat?.voiceCapability?.reason || 'Choose a chat model to check native voice support.'}</p><p className="muted">Use the waveform button beside Send for voice chat. The microphone or Alt+M handles a single spoken turn. Native audio takes priority; enabled local fallback listens and speaks with your selected chat model.</p><button disabled={!voiceAvailable} onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('voice-permission.html') })}>Enable microphone</button><label className="model-toggle"><input type="checkbox" aria-label="Speak replies automatically" disabled={!voiceAvailable} checked={voice.preferences.speakReplies} onChange={e => voice.setPreferences(v => ({ ...v, speakReplies: e.target.checked }))} />Spoken replies</label><label>Model voice<select aria-label="Spoken voice" disabled={!chat?.voiceCapability?.supported || chat?.busy} value={voice.preferences.voice} onChange={e => voice.setPreferences(v => ({ ...v, voice: e.target.value }))}>{nativeVoices.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}</select></label><p className="muted">Native conversation uses an available GPT Realtime model with an OpenAI API account.</p>{chat?.provider === "openai" && account?.configured && account?.method === "api_key" && !chat?.voiceCapability?.supported && selectedProvider.models.some((m: any) => m.nativeVoice) && <button disabled={chat?.busy} onClick={() => run(() => update(modelChoice(selectedProvider.models.find((m: any) => m.nativeVoice))))}>Use native voice model</button>}<label className="model-toggle"><input type="checkbox" aria-label="Use bundled local voice fallback" checked={voice.preferences.fallbackEnabled} onChange={e => voice.setPreferences(v => ({ ...v, fallbackEnabled: e.target.checked }))} />Use bundled local fallback when native voice is unavailable</label><p className="muted">{fallbackAvailable ? "Whisper Base English and Kokoro are bundled. Local audio stays on this computer; the transcript goes to your selected chat model. Native model audio always takes priority." : "Bundled fallback models are unavailable. Rebuild or install the complete browser bundle."}</p><label>Fallback voice<select aria-label="Fallback voice" disabled={!fallbackAvailable} value={voice.preferences.fallbackVoice} onChange={e => { fallback.stopSpeaking(); voice.setPreferences(v => ({ ...v, fallbackVoice: e.target.value })); }}>{fallbackVoices.map(v => <option key={v.id} value={v.id}>{v.name} · Kokoro</option>)}</select></label><button disabled={!fallbackEnabled || fallback.phase !== "idle"} onClick={() => fallback.speak("Hello. This is Autoum’s local fallback voice.")}>Preview fallback voice</button></section>
      <details><summary>Conversation data</summary><button aria-label="Export chats" aria-busy={exporting} disabled={exporting} onClick={() => run(exportData)}>{exporting ? 'Exporting…' : 'Export chats'}</button><button className="danger" onClick={deleteCurrent}>Delete current chat</button></details>
    </main> : state && <>
      <div className="conversation-bar"><span title={chat?.title}>{chat?.title}</span><button title="Rename chat" aria-label="Rename chat" onClick={() => { setChatTitle(chat.title); setRenameChat(!renameChat); }}>✎</button>{showChats && <button className="danger" aria-label="Delete current chat" onClick={deleteCurrent}>×</button>}</div>
      {renameChat && <form className="inline-form" onSubmit={e => { e.preventDefault(); run(async () => { await update({ title: chatTitle }); setRenameChat(false); }); }}><input autoFocus aria-label="Chat title" value={chatTitle} onChange={e => setChatTitle(e.target.value)} maxLength={100} /><button disabled={!chatTitle.trim()}>Save</button></form>}
      {showChats && <label className="move-chat">Move chat to<select aria-label="Move chat to folder" value={chat?.folderId || ''} onChange={e => run(() => update({ folderId: e.target.value }))}><option value="">Unfiled</option>{folders.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
      <Conversation chatId={chat?.id} pageEnd={chat?.historyEnd} historical={earlierPage} onLatest={earlierPage ? () => run(() => call('history_latest', { chatId: chat.id })) : undefined}>{chat?.historyStart > 0 && <button className="older-messages" onClick={() => run(() => call('history_more', { chatId: chat.id }))}>Load older messages</button>}{earlierPage && <div className="history-navigation"><span>Messages {chat.historyStart + 1}–{chat.historyEnd} of {chat.historyTotal}</span><button onClick={() => run(() => call('history_newer', { chatId: chat.id }))}>Newer messages</button><button onClick={() => run(() => call('history_latest', { chatId: chat.id }))}>Back to latest</button></div>}{chat?.messages.map((message: any, index: number) => <ChatMessage key={chat.id + ":" + ((chat.historyStart || 0) + index)} message={message} chatId={chat.id} index={(chat.historyStart || 0) + index} />)}{chat?.current && !earlierPage && <article className="message assistant"><div className="message-label">Autoum</div><StreamingMarkdown text={chat.current} /></article>}{chat?.busy && <div className="activity"><span className="pulse" />{chat.activity || 'Thinking…'}</div>}{chat?.error && <div className="error">{chat.error}</div>}</Conversation>
      <footer><div className="composer"><textarea onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); addFiles(files); } }} ref={compose} aria-label="Message Autoum" placeholder="Message Autoum…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} rows={2} />
        <div id="provider-controls" className="provider-controls" hidden={!showControls}><label>Provider<select ref={providerSelect} aria-label="AI provider" disabled={chat?.busy} value={chat?.provider || ''} onChange={e => run(() => chooseProvider(e.target.value))}>{state.providers.filter((p: any) => p.models.length > 0).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Account<select aria-label="AI account" disabled={chat?.busy || !providerAccounts.length} value={chat?.accountId || ''} title={account?.email || account?.label} onChange={e => run(() => chooseAccount(e.target.value))}>{!chat?.accountId && <option value="">Not connected</option>}{providerAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.email || a.label}{a.configured ? '' : ' · disconnected'}</option>)}</select></label></div>
        <div className="draft-attachments">{(fileDrafts[chat?.id] || []).map(item => <FileAttachment key={item.id} item={item} chatId={chat.id} call={call} remove={() => setFileDrafts(d => ({ ...d, [chat.id]: d[chat.id].filter(a => a.id !== item.id) }))} />)}</div>{uploading && <p className="muted" role="status">Attaching files…</p>}<input ref={fileInput} type="file" multiple hidden aria-label="Attach files" onChange={e => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /><div className="composer-bottom"><button type="button" aria-label="Add attachment" title="Attach files or paste an image · Ctrl+V" disabled={uploading} onClick={() => fileInput.current?.click()}>＋</button><button className={'microphone ' + voice.phase} type="button" aria-label={voice.phase === 'recording' ? 'Finish speaking' : voice.phase === 'connecting' ? 'Cancel voice' : 'Start voice'} disabled={!voiceAvailable || voice.conversationActive} title={chat?.voiceCapability?.supported ? "Microphone · single spoken turn · Alt+M" : fallbackEnabled ? "Bundled local voice fallback · Alt+M" : chat?.voiceCapability?.reason} aria-pressed={voice.phase === 'recording'} onClick={() => ['idle', 'connected'].includes(voice.phase) ? chat?.voiceCapability?.supported ? native.start(true, 'push') : fallback.start() : voice.phase === 'recording' ? voice.stopRecording() : voice.cancel()}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg></button><label id="model-control" hidden={!showControls}>Model<select aria-label="AI model" disabled={chat?.busy} value={chat?.model || ''} onChange={e => run(() => update(modelChoice(modelChoices.find((m: any) => m.id === e.target.value))))}>{!modelChoices.some((m: any) => m.id === chat?.model) && <option value={chat?.model}>{selectedProvider?.models.find((m: any) => m.id === chat?.model)?.name || (chat?.provider === 'antigravity' && chat?.model === 'default' ? 'Provider default model' : chat?.model)}{chat?.provider === 'antigravity' && chat?.model === 'default' ? '' : selectedModel ? ' · hidden for new chats' : ' · unavailable'}</option>}{modelChoices.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{!showControls && <span className="collapsed-model" title={[provider?.name, selectedProvider?.models.find((m: any) => m.id === chat?.model)?.name || (chat?.provider === 'antigravity' && chat?.model === 'default' ? 'Provider default model' : chat?.model), account?.email || account?.label].filter(Boolean).join(" · ")}>{selectedProvider?.models.find((m: any) => m.id === chat?.model)?.name || (chat?.provider === 'antigravity' && chat?.model === 'default' ? 'Provider default model' : chat?.model)}</span>}<button type="button" className="controls-toggle" aria-label={showControls ? "Hide model controls" : "Show model controls"} title={showControls ? "Hide provider, account, model and reasoning controls" : "Show provider, account, model and reasoning controls"} aria-expanded={showControls} aria-controls="provider-controls model-control reasoning-control" onClick={() => setShowControls(v => !v)}>{showControls ? "⌃" : "⌄"}</button>{chat?.busy ? <button className="stop" title="Stop and take over" aria-label="Stop and take over" onClick={() => { void voice.cancel(); run(() => call('stop', { chatId: chat.id })); }}>■</button> : null}<button className="send" title={chat?.busy ? "Steer · send a correction to the running task" : "Send"} aria-label={chat?.busy ? "Steer" : "Send"} disabled={(!input.trim() && !fileDrafts[chat?.id]?.length) || uploading || !account?.configured || !['idle', 'connected'].includes(voice.phase)} onClick={send}>↑</button><button type="button" className={"voice-chat" + (voice.conversationActive ? " active" : "") + (voice.speaking ? " speaking" : "")} aria-label={voice.conversationActive ? "End voice chat" : "Start voice chat"} aria-pressed={voice.conversationActive} title={voice.conversationActive ? "End voice chat" : !voiceAvailable ? (chat?.voiceCapability?.reason || "Connect an account and enable voice in Settings") : chat?.voiceCapability?.supported ? "Voice chat · native audio" : "Voice chat · local fallback"} disabled={!voice.conversationActive && (!voiceAvailable || chat?.busy || !["idle", "connected"].includes(voice.phase))} onClick={() => voice.conversationActive ? endVoice() : voice.startConversation()}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg></button></div>
        {!account?.configured && <button className="connect-current" onClick={() => { setSettings(true); editAccount(provider, account); }}>Connect {provider?.name}</button>}
      </div><div className="permission-bar"><select aria-label="Permission mode" value={chat?.mode || 'ask'} onChange={e => run(() => update({ mode: e.target.value }))}><option value="ask">Ask</option><option value="auto-review">Auto-review</option><option value="all">Always allow</option></select><select id="reasoning-control" hidden={!showControls || !reasoningLevels.length} aria-label="Reasoning" title="Reasoning" disabled={chat?.busy} value={chat?.thinking || 'medium'} onChange={e => run(() => update({ thinking: e.target.value }))}>{reasoningLevels.map((v: string) => <option key={v} value={v}>{v === 'off' ? 'Reasoning off' : v[0].toUpperCase() + v.slice(1) + ' reasoning'}</option>)}</select></div></footer>
    </>}
    {(voice.status || voice.error || voice.phase !== 'idle' || voice.speaking) && <div className={'voice-status ' + (voice.error ? 'error' : '')} role="status"><span>{voice.error || voice.status}</span>{voice.phase !== 'idle' && <button aria-label="End voice" onClick={endVoice}>End voice</button>}{voice.speaking && <button aria-label="Stop speaking" onClick={voice.stopSpeaking}>Stop speaking</button>}</div>}
    {(error || notice) && <div className={error ? 'global-error' : 'global-notice'}>{error || notice}<button aria-label="Dismiss" onClick={() => { setError(''); setNotice(''); }}>×</button>{error && <button onClick={reconnect}>Reconnect</button>}</div>}
    {accountForm && <div className="overlay"><form className="approval account-dialog" role="dialog" aria-modal="true" aria-label="Connect AI account" onSubmit={e => { e.preventDefault(); run(async () => { const result = await signIn(formProvider, accountForm.method, accountKey, accountForm.id, accountForm.label); if (chat?.provider === formProvider.id && !chat.busy) await update({ accountId: result.accountId }); }); }}>
      <h2>{accountForm.id ? 'Reconnect account' : 'Add account'}</h2><p>{formProvider?.name}</p><label>Account label<input autoFocus aria-label="New account label" placeholder="Personal, work, family…" value={accountForm.label} onChange={e => setAccountForm(v => v && ({ ...v, label: e.target.value }))} maxLength={80} /></label>
      {formProvider?.login && formProvider?.apiKey && <label>Connect with<select aria-label="Account connection method" value={accountForm.method} onChange={e => setAccountForm(v => v && ({ ...v, method: e.target.value }))}><option value="oauth">Regular sign-in</option><option value="api_key">API key</option></select></label>}
      {accountForm.method === 'api_key' && <label>API key<input type="password" autoComplete="off" aria-label="New account API key" value={accountKey} onChange={e => setAccountKey(e.target.value)} /></label>}
      <div className="dialog-actions"><button type="button" onClick={() => { if (loginBusy) call('cancel_login'); else { setAccountForm(undefined); setAccountKey(''); } }}>{loginBusy ? 'Cancel sign-in' : 'Cancel'}</button><button className="primary" type="submit" disabled={loginBusy || accountForm.method === 'api_key' && !accountKey.trim()}>{loginBusy ? 'Connecting…' : accountForm.method === 'oauth' ? 'Sign in with your account' : 'Connect'}</button></div>
    </form></div>}
    {approvals.length > 0 && <div className="overlay"><section className="approval" role="dialog" aria-modal="true" aria-label="Approve action"><h2>Allow this action?</h2><p>{approvals[0].data.tool === 'browser' ? 'Autoum wants to ' + approvals[0].data.input.action + ' in your browser.' : 'Autoum wants to use ' + approvals[0].data.tool + '.'}</p>{approvals[0].data.target?.url && <p className="target-url">{approvals[0].data.target.url}</p>}<pre>{JSON.stringify(approvals[0].data.input, null, 2)}</pre><label>After this approval<select aria-label="Approval permission mode" value={approvalMode} onChange={e => setApprovalMode(e.target.value)}><option value="ask">Ask</option><option value="auto-review">Auto-review</option><option value="all">Always allow</option></select></label><div className="dialog-actions"><button onClick={() => respond(approvals[0], false)}>Decline</button><button className="primary" onClick={() => respond(approvals[0], approvalMode === approvals[0].data.mode ? true : { decision: 'allow', mode: approvalMode })}>{approvalMode === approvals[0].data.mode ? 'Allow once' : 'Allow and save mode'}</button></div></section></div>}
    {auth && <div className="overlay"><form className="approval" role="dialog" aria-modal="true" onSubmit={e => { e.preventDefault(); respond(auth, authValue); setAuth(undefined); }}><h2>Finish connecting</h2><p>{auth.data.message}</p>{auth.data.type === 'select' ? <select value={authValue} onChange={e => setAuthValue(e.target.value)}><option value="">Choose…</option>{auth.data.options.map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> : <input autoFocus type={auth.data.type === 'secret' ? 'password' : 'text'} value={authValue} onChange={e => setAuthValue(e.target.value)} placeholder={auth.data.placeholder} autoComplete="off" />}<div className="dialog-actions"><button type="button" onClick={() => { call('cancel_login'); setAuth(undefined); }}>Cancel</button><button className="primary" disabled={!authValue}>Continue</button></div></form></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
