import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function CopyReply({ text, loadText }: { text: string; loadText?: () => Promise<string> }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const copying = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (status === 'idle' || status === 'copying') return;
    const timer = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return <button className="copy-reply" aria-label="Copy reply" title="Copy complete reply as Markdown" disabled={status === 'copying'} onClick={async () => {
    if (copying.current) return; copying.current = true; setStatus('copying');
    try {
      // Start the clipboard operation during the click, before asynchronous native reads.
      if (loadText) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': loadText().then(value => new Blob([value], { type: 'text/plain' })) })]);
      else await navigator.clipboard.writeText(text);
      if (mounted.current) setStatus('copied');
    }
    catch { if (mounted.current) setStatus('error'); }
    finally { copying.current = false; }
  }}><span aria-live="polite">{status === 'copying' ? 'Copying…' : status === 'copied' ? 'Copied' : status === 'error' ? 'Retry copy' : 'Copy'}</span></button>;
}

export function Conversation({ chatId, pageEnd, historical = false, onLatest, children }: { chatId?: string; pageEnd?: number; historical?: boolean; onLatest?: () => void; children: React.ReactNode }) {
  const viewport = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [detached, setDetached] = useState(false);
  const jump = () => { const element = viewport.current; if (element) element.scrollTop = element.scrollHeight; };
  const previousPageEnd = useRef(pageEnd);
  useLayoutEffect(() => { previousPageEnd.current = pageEnd; following.current = true; setDetached(false); jump(); }, [chatId]);
  useLayoutEffect(() => {
    if (historical && pageEnd !== undefined && previousPageEnd.current !== undefined && pageEnd !== previousPageEnd.current) {
      // A bounded page replaces the previous page; start at its first message.
      following.current = false; setDetached(true);
      if (viewport.current) viewport.current.scrollTop = 0;
    }
    previousPageEnd.current = pageEnd;
  }, [pageEnd, historical]);
  const wasHistorical = useRef(historical);
  useLayoutEffect(() => {
    if (wasHistorical.current && !historical) { following.current = true; setDetached(false); jump(); }
    wasHistorical.current = historical;
  }, [historical]);
  // Instant positioning follows tokens without queuing smooth-scroll animations.
  useLayoutEffect(() => { if (following.current) jump(); });
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (following.current) jump(); });
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return <div className="conversation-wrap">
    <main ref={viewport} className="conversation" aria-live="polite" onScroll={event => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      setDetached(!following.current);
    }}><div ref={content} className="conversation-content">{children}</div></main>
    {detached && <button className="jump-latest" onClick={() => { following.current = true; setDetached(false); jump(); onLatest?.(); }}>Jump to latest ↓</button>}
  </div>;
}
