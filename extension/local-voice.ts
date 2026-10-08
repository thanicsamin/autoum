import { useEffect, useRef, useState } from 'react';
export const fallbackVoices = [{ id: 'af_heart', name: 'Heart' }, { id: 'af_bella', name: 'Bella' }, { id: 'af_nicole', name: 'Nicole' }, { id: 'am_michael', name: 'Michael' }, { id: 'am_puck', name: 'Puck' }];
export function speechChunks(text: string) {
  const words = text.replace(/```[\s\S]*?```/g, ' Code example omitted. ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12000).split(' ');
  const chunks: string[] = []; let current = ''; for (const word of words) { if (current.length + word.length > 220) { chunks.push(current); current = ''; } current += (current ? ' ' : '') + word; } if (current) chunks.push(current); return chunks;
}
export function useLocalVoice(chatId: string | undefined, enabled: boolean, voice: string, onText: (id: string, text: string) => Promise<any>) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle'), [status, setStatus] = useState(''), [error, setError] = useState(''), [speaking, setSpeaking] = useState(false);
  const engine = useRef<Worker | undefined>(undefined), pending = useRef<any>(undefined), generation = useRef(0), mic = useRef<MediaStream | undefined>(undefined), recorder = useRef<MediaRecorder | undefined>(undefined), timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const context = useRef<AudioContext | undefined>(undefined), playing = useRef<AudioBufferSourceNode | undefined>(undefined), finishPlay = useRef<(() => void) | undefined>(undefined);
  const request = (kind: string, data: any) => new Promise<any>((resolve, reject) => {
    if (pending.current) { reject(Error('Local voice is busy.')); return; }
    engine.current ||= new Worker(chrome.runtime.getURL('local-voice-worker.js'), { type: 'module' }); const id = crypto.randomUUID(); pending.current = { id, resolve, reject };
    engine.current.onmessage = ({ data }) => { if (data.id !== pending.current?.id) return; if (data.status) setStatus(data.status); else { const p = pending.current; pending.current = undefined; data.error ? p.reject(Error(data.error)) : p.resolve(data); } };
    engine.current.onerror = () => { pending.current?.reject(Error('Bundled voice failed to load.')); pending.current = undefined; engine.current?.terminate(); engine.current = undefined; };
    engine.current.postMessage({ id, kind, ...data }, data.audio ? [data.audio.buffer] : []);
  });
  const stopSpeaking = () => { generation.current++; try { playing.current?.stop(); } catch {} finishPlay.current?.(); playing.current = undefined; setSpeaking(false); setStatus(''); if (pending.current) { engine.current?.terminate(); engine.current = undefined; pending.current.reject(new DOMException('Cancelled', 'AbortError')); pending.current = undefined; } };
  const cancel = () => { stopSpeaking(); clearTimeout(timeout.current); recorder.current?.stop(); recorder.current = undefined; mic.current?.getTracks().forEach(t => t.stop()); mic.current = undefined; setPhase('idle'); };
  const start = async (_listen = true) => {
    if (!enabled || !chatId || phase !== 'idle') return; stopSpeaking(); setError(''); const epoch = generation.current;
    try {
      context.current ||= new AudioContext(); await context.current.resume(); const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== generation.current) { stream.getTracks().forEach(t => t.stop()); return; } mic.current = stream;
      const recording = new MediaRecorder(stream), parts: Blob[] = []; recorder.current = recording; recording.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      recording.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); clearTimeout(timeout.current); if (epoch !== generation.current) return; setPhase('transcribing'); setStatus('Understanding speech…');
        try {
          const decoded = await context.current!.decodeAudioData(await new Blob(parts).arrayBuffer()); const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000); const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start(); const samples = (await offline.startRendering()).getChannelData(0);
          let energy = 0; for (const sample of samples) energy += sample * sample; if (Math.sqrt(energy / samples.length) < 0.002) throw Error('No speech heard. Try again.');
          const result = await request('transcribe', { audio: samples }); if (epoch !== generation.current) return; if (!result.text.trim()) throw Error('No speech heard. Try again.'); await onText(chatId, result.text.trim());
        } catch (e: any) { if (epoch === generation.current && e.name !== 'AbortError') setError(e.message); }
        finally { if (epoch === generation.current) { setPhase('idle'); setStatus(''); } }
      };
      recording.start(); setPhase('recording'); setStatus('Listening · local fallback · click to send'); timeout.current = setTimeout(() => recording.state === 'recording' && recording.stop(), 60000);
    } catch (e: any) { setError(e.name === 'NotAllowedError' ? 'Microphone access was denied.' : e.message); cancel(); }
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
  useEffect(() => { cancel(); if (!enabled) { engine.current?.terminate(); engine.current = undefined; } }, [chatId, enabled]);
  useEffect(() => () => { cancel(); engine.current?.terminate(); void context.current?.close(); }, []);
  return { phase, status, error, speaking, start, stopRecording, cancel, stopSpeaking, speak };
}
