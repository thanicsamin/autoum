import { useEffect, useRef, useState } from 'react';
import { voicePreferences } from './voice.js';
type Call = (type: string, data?: any) => Promise<any>;
export function useVoice(chatId: string | undefined, capability: any, call: Call, port: chrome.runtime.Port) {
  const [preferences, setPreferences] = useState(voicePreferences(undefined)); const prefs = useRef(preferences); prefs.current = preferences;
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'recording' | 'connected'>('idle'); const phaseRef = useRef(phase); phaseRef.current = phase;
  const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [speaking, setSpeaking] = useState(false);
  const session = useRef<{ id: string; chatId: string; mode: 'push' | 'conversation' } | undefined>(undefined); const generation = useRef(0);
  const pendingStart = useRef<{ chatId: string; startupId: string } | undefined>(undefined);
  const mic = useRef<MediaStream | undefined>(undefined), audio = useRef<AudioContext | undefined>(undefined), recorder = useRef<AudioWorkletNode | undefined>(undefined), capture = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const queued = useRef<Promise<any>>(Promise.resolve()), sources = useRef<AudioBufferSourceNode[]>([]), nextStart = useRef(0);
  const played = useRef<{ itemId?: string; contentIndex: number; milliseconds: number }>({ contentIndex: 0, milliseconds: 0 }), outputStart = useRef(0);
  const heartbeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined), gain = useRef<GainNode | undefined>(undefined);
  const stopSpeaking = () => { for (const source of sources.current) { try { source.stop(); } catch {} } sources.current = []; nextStart.current = 0; setSpeaking(false); };
  const dispose = () => { generation.current++; clearInterval(heartbeat.current); stopSpeaking(); recorder.current?.disconnect(); capture.current?.disconnect(); mic.current?.getTracks().forEach(t => t.stop()); mic.current = undefined; recorder.current = undefined; capture.current = undefined; queued.current = Promise.resolve(); void audio.current?.close().catch(() => {}); audio.current = undefined; gain.current = undefined; session.current = undefined; phaseRef.current = 'idle'; setPhase('idle'); setStatus(''); };
  const cancel = async () => { const active = session.current, pending = pendingStart.current; pendingStart.current = undefined; dispose(); if (active) await call('voice_end', { chatId: active.chatId, voiceId: active.id }).catch(() => {}); else if (pending) await call('voice_cancel_start', pending).catch(() => {}); };
  const fail = (e: any) => { setError(e.name === 'NotAllowedError' ? 'Microphone access was denied. Enable it in Voice settings.' : e.message || 'Voice failed.'); void cancel(); };
  const playedTime = () => ({ ...played.current, milliseconds: Math.min(played.current.milliseconds, Math.max(0, ((audio.current?.currentTime || 0) - outputStart.current) * 1000)) });
  const startRecording = async () => {
    const active = session.current, context = audio.current, epoch = generation.current; if (!active || !context) return;
    const current = () => epoch === generation.current && session.current === active && audio.current === context;
    phaseRef.current = 'connecting'; setPhase('connecting'); setStatus('Starting microphone…');
    await call('voice_begin', { chatId: active.chatId, voiceId: active.id, played: playedTime() }); if (!current()) return; stopSpeaking();
    if (!mic.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      mic.current = stream;
      await context.audioWorklet.addModule(chrome.runtime.getURL('voice-capture.js'));
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      recorder.current = new AudioWorkletNode(context, 'autoum-voice-capture'); capture.current = context.createMediaStreamSource(stream); capture.current.connect(recorder.current); recorder.current.connect(context.destination);
      recorder.current.port.onmessage = ({ data }) => {
        const ownsSession = () => session.current === active && audio.current === context;
        if (!ownsSession() || phaseRef.current !== 'recording') return;
        const bytes = new Uint8Array(data); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
        queued.current = queued.current.then(() => ownsSession() ? call('voice_audio', { chatId: active.chatId, voiceId: active.id, audio: btoa(binary) }) : undefined).catch(e => { if (ownsSession()) fail(e); });
      };
    }
    mic.current.getTracks().forEach(t => { t.enabled = true; }); phaseRef.current = 'recording'; setPhase('recording'); setStatus(active.mode === 'conversation' ? 'Listening · speak naturally' : 'Listening · click the microphone to send');
  };
  const start = async (listen = true, mode = prefs.current.mode) => {
    if (!chatId || !capability?.supported || phaseRef.current === 'connecting') return;
    setError(''); const epoch = ++generation.current;
    try {
      if (!session.current) {
        phaseRef.current = 'connecting'; setPhase('connecting'); setStatus('Connecting native voice…');
        const context = new AudioContext({ sampleRate: 24000 }); audio.current = context; await context.resume(); if (epoch !== generation.current) return; gain.current = context.createGain(); gain.current.connect(context.destination); gain.current.gain.value = prefs.current.speakReplies ? 1 : 0;
        const pending = { chatId, startupId: crypto.randomUUID() }; pendingStart.current = pending;
        let result: any;
        try { result = await call('voice_start', { ...pending, voice: prefs.current.voice, mode }); }
        finally { if (pendingStart.current === pending) pendingStart.current = undefined; }
        if (epoch !== generation.current) { await call('voice_end', { chatId, voiceId: result.voiceId }); return; }
        const active = { id: result.voiceId, chatId, mode }; session.current = active; heartbeat.current = setInterval(() => { if (session.current === active) call('voice_ping', { chatId: active.chatId, voiceId: active.id }).catch(e => { if (session.current === active) fail(e); }); }, 5000);
      }
      if (listen) await startRecording(); else { phaseRef.current = 'connected'; setPhase('connected'); setStatus('Voice connected · click the microphone to speak'); }
    } catch (e) { if (epoch === generation.current) fail(e); }
  };
  const startConversation = async () => {
    if (phaseRef.current !== 'idle' || !capability?.supported) return;
    setPreferences(value => ({ ...value, mode: 'conversation' }));
    await start(true, 'conversation');
  };
  const stopRecording = async () => {
    if (session.current?.mode === 'conversation') { await cancel(); return; }
    const active = session.current, epoch = generation.current; if (!active) return;
    mic.current?.getTracks().forEach(t => { t.enabled = false; }); recorder.current?.port.postMessage('flush');
    await new Promise(resolve => setTimeout(resolve, 30)); await queued.current;
    if (epoch !== generation.current || session.current !== active) return;
    phaseRef.current = 'connected'; setPhase('connected'); setStatus('Voice connected · click the microphone to speak');
    try { await call('voice_commit', { chatId: active.chatId, voiceId: active.id }); } catch (e: any) { if (epoch === generation.current && session.current === active) setError(e.message); }
  };
  useEffect(() => { if (gain.current) gain.current.gain.value = preferences.speakReplies ? 1 : 0; }, [preferences.speakReplies]);
  useEffect(() => {
    const listener = (packet: any) => {
      const event = packet.data; if (packet.type !== 'voice_event' || event.chatId !== session.current?.chatId || event.voiceId !== session.current?.id) return;
      if (event.kind === 'closed') { dispose(); return; }
      if (event.kind === 'interrupt') { stopSpeaking(); return; }
      if (event.kind !== 'audio' || !audio.current || !gain.current) return;
      try {
        const binary = atob(event.audio), samples = new Int16Array(Uint8Array.from(binary, c => c.charCodeAt(0)).buffer), buffer = audio.current.createBuffer(1, samples.length, 24000);
        const floats = buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
        const source = audio.current.createBufferSource(); source.buffer = buffer; source.connect(gain.current);
        const when = Math.max(nextStart.current, audio.current.currentTime);
        if (when - audio.current.currentTime > 30) throw Error('Voice playback fell behind. Start a new conversation.');
        if (event.itemId !== played.current.itemId) { played.current = { itemId: event.itemId, contentIndex: event.contentIndex, milliseconds: 0 }; outputStart.current = when; }
        played.current.milliseconds += buffer.duration * 1000;
        sources.current.push(source); source.onended = () => { sources.current = sources.current.filter(s => s !== source); if (!sources.current.length) setSpeaking(false); }; source.start(when); nextStart.current = when + buffer.duration; setSpeaking(prefs.current.speakReplies);
      } catch (e) { fail(e); }
    };
    port.onMessage.addListener(listener); return () => port.onMessage.removeListener(listener);
  }, []);
  useEffect(() => { void cancel(); }, [chatId]);
  useEffect(() => { const close = () => { void cancel(); }; window.addEventListener('pagehide', close); return () => { window.removeEventListener('pagehide', close); void cancel(); }; }, []);
  return { preferences, setPreferences, phase, status, error, speaking, start, startConversation, stopRecording, cancel, stopSpeaking };
}
