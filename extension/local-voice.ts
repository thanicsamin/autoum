import { useEffect, useRef, useState } from 'react';
export const fallbackVoices = [{ id: 'af_heart', name: 'Heart' }, { id: 'af_bella', name: 'Bella' }, { id: 'af_nicole', name: 'Nicole' }, { id: 'am_michael', name: 'Michael' }, { id: 'am_puck', name: 'Puck' }];
export function speechChunks(text: string) {
  const words = text.replace(/```[\s\S]*?```/g, ' Code example omitted. ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12000).split(' ');
  const chunks: string[] = []; let current = ''; for (const word of words) { if (current.length + word.length > 220) { chunks.push(current); current = ''; } current += (current ? ' ' : '') + word; } if (current) chunks.push(current); return chunks;
}
export function useLocalVoice(chatId: string | undefined, enabled: boolean, voice: string, onText: (id: string, text: string, conversation: boolean, signal: AbortSignal) => Promise<string | undefined>) {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'recording' | 'transcribing'>('idle'), [status, setStatus] = useState(''), [error, setError] = useState(''), [speaking, setSpeaking] = useState(false);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const conversation = useRef<object | undefined>(undefined), [conversationActive, setConversationActive] = useState(false);
  const detector = useRef<ReturnType<typeof setInterval> | undefined>(undefined), capture = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const stopDetector = () => { clearInterval(detector.current); detector.current = undefined; capture.current?.disconnect(); capture.current = undefined; };
  const engine = useRef<Worker | undefined>(undefined), pending = useRef<any>(undefined), generation = useRef(0), mic = useRef<MediaStream | undefined>(undefined), recorder = useRef<MediaRecorder | undefined>(undefined), timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turn = useRef<AbortController | undefined>(undefined);
  const context = useRef<AudioContext | undefined>(undefined), playing = useRef<AudioBufferSourceNode | undefined>(undefined), finishPlay = useRef<(() => void) | undefined>(undefined);
  const request = (kind: string, data: any) => new Promise<any>((resolve, reject) => {
    if (pending.current) { reject(Error('Local voice is busy.')); return; }
    engine.current ||= new Worker(chrome.runtime.getURL('local-voice-worker.js'), { type: 'module' }); const id = crypto.randomUUID(); pending.current = { id, resolve, reject };
    engine.current.onmessage = ({ data }) => { if (data.id !== pending.current?.id) return; if (data.status) setStatus(data.status); else { const p = pending.current; pending.current = undefined; data.error ? p.reject(Error(data.error)) : p.resolve(data); } };
    engine.current.onerror = () => { pending.current?.reject(Error('Bundled voice failed to load.')); pending.current = undefined; engine.current?.terminate(); engine.current = undefined; };
    engine.current.postMessage({ id, kind, ...data }, data.audio ? [data.audio.buffer] : []);
  });
  const stopSpeaking = () => { generation.current++; try { playing.current?.stop(); } catch {} finishPlay.current?.(); playing.current = undefined; setSpeaking(false); setStatus(''); if (pending.current) { engine.current?.terminate(); engine.current = undefined; pending.current.reject(new DOMException('Cancelled', 'AbortError')); pending.current = undefined; } };
  const cancel = () => { conversation.current = undefined; setConversationActive(false); turn.current?.abort(); turn.current = undefined; stopDetector(); phaseRef.current = 'idle'; stopSpeaking(); clearTimeout(timeout.current); const recording = recorder.current; recorder.current = undefined; if (recording?.state === 'recording') recording.stop(); mic.current?.getTracks().forEach(t => t.stop()); mic.current = undefined; setPhase('idle'); };
  const start = async (_listen = true, activeConversation = conversation.current) => {
    if (!enabled || !chatId || phaseRef.current !== 'idle') return; stopSpeaking(); setError(''); const epoch = generation.current;
    phaseRef.current = 'connecting'; setPhase('connecting'); setStatus('Starting microphone…');
    try {
      context.current ||= new AudioContext(); await context.current.resume(); const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== generation.current) { stream.getTracks().forEach(t => t.stop()); return; } mic.current = stream;
      const recording = new MediaRecorder(stream), parts: Blob[] = []; recorder.current = recording; recording.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      recording.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); if (epoch !== generation.current) return; stopDetector(); clearTimeout(timeout.current); recorder.current = undefined; mic.current = undefined; phaseRef.current = 'transcribing'; setPhase('transcribing'); setStatus('Understanding speech…');
        try {
          const bytes = await new Blob(parts).arrayBuffer(); if (epoch !== generation.current) return;
          const decoded = await context.current!.decodeAudioData(bytes); if (epoch !== generation.current) return; const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000); const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start(); const samples = (await offline.startRendering()).getChannelData(0);
          if (epoch !== generation.current) return;
          let energy = 0; for (const sample of samples) energy += sample * sample; if (Math.sqrt(energy / samples.length) < 0.002) throw Error('No speech heard. Try again.');
          const result = await request('transcribe', { audio: samples }); if (epoch !== generation.current) return; if (!result.text.trim()) throw Error('No speech heard. Try again.'); setStatus('Thinking…');
          const controller = new AbortController(); turn.current = controller;
          const reply = await onText(chatId, result.text.trim(), !!activeConversation, controller.signal); if (turn.current === controller) turn.current = undefined; if (epoch !== generation.current) return;
          if (activeConversation && conversation.current === activeConversation) {
            if (reply) { setStatus('Speaking…'); await speak(reply); }
            if (conversation.current !== activeConversation) return;
            phaseRef.current = 'idle'; setPhase('idle');
            await start(true, activeConversation);
          }
        } catch (e: any) { if (epoch === generation.current && e.name !== 'AbortError') { setError(e.message); cancel(); } }
        finally { if (epoch === generation.current) { phaseRef.current = 'idle'; setPhase('idle'); setStatus(''); } }
      };
      recording.start(); phaseRef.current = 'recording'; setPhase('recording'); setStatus(activeConversation ? 'Listening · speak naturally · local fallback' : 'Listening · local fallback · click to send');
      if (activeConversation) {
        const analyser = context.current!.createAnalyser(); analyser.fftSize = 2048;
        capture.current = context.current!.createMediaStreamSource(stream); capture.current.connect(analyser);
        const samples = new Float32Array(analyser.fftSize); let speechMs = 0, lastSpeech = 0, previous = performance.now();
        detector.current = setInterval(() => {
          if (epoch !== generation.current || recording.state !== 'recording') { stopDetector(); return; }
          const now = performance.now(); analyser.getFloatTimeDomainData(samples); let energy = 0; for (const value of samples) energy += value * value;
          if (Math.sqrt(energy / samples.length) > .012) { speechMs += Math.min(now - previous, 150); lastSpeech = now; }
          previous = now;
          if (speechMs >= 250 && now - lastSpeech >= 1000) recording.stop();
        }, 100);
      }
      timeout.current = setTimeout(() => recording.state === 'recording' && recording.stop(), 60000);
    } catch (e: any) { if (epoch !== generation.current) return; setError(e.name === 'NotAllowedError' ? 'Microphone access was denied.' : e.message); cancel(); }
  };
  const startConversation = async () => {
    if (!enabled || !chatId || phaseRef.current !== 'idle' || conversation.current) return;
    const active = {}; conversation.current = active; setConversationActive(true); await start(true, active);
  };
  const stopRecording = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };
  const speak = async (text: string) => {
    if (!enabled) return; stopSpeaking(); setError(''); const epoch = generation.current; setSpeaking(true);
    try {
      context.current ||= new AudioContext(); await context.current.resume();
      for (const chunk of speechChunks(text)) {
        const result = await request('synthesize', { text: chunk, voice }); if (epoch !== generation.current) return;
        const buffer = context.current.createBuffer(1, result.audio.length, result.sampleRate); buffer.copyToChannel(result.audio, 0); const source = context.current.createBufferSource(); source.buffer = buffer; source.connect(context.current.destination); playing.current = source;
        await new Promise<void>(resolve => { finishPlay.current = resolve; source.onended = () => { finishPlay.current = undefined; resolve(); }; source.start(); }); if (epoch !== generation.current) return;
      }
    } catch (e: any) { if (epoch === generation.current && e.name !== 'AbortError') setError(e.message); }
    finally { if (epoch === generation.current) { setSpeaking(false); setStatus(''); } }
  };
  useEffect(() => { cancel(); if (!enabled) { engine.current?.terminate(); engine.current = undefined; } }, [chatId, enabled, voice]);
  useEffect(() => () => { cancel(); engine.current?.terminate(); void context.current?.close(); }, []);
  return { phase, status, error, speaking, conversationActive, start, startConversation, stopRecording, cancel, stopSpeaking, speak };
}
