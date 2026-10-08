class AutoumVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.port.onmessage = e => { if (e.data === 'flush') this.flush(); }; }
  flush() { if (!this.samples.length) return; const pcm = new Int16Array(this.samples); this.samples = []; this.port.postMessage(pcm.buffer, [pcm.buffer]); }
  process(inputs) { const input = inputs[0]?.[0]; if (input) for (const sample of input) { this.samples.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767)); if (this.samples.length >= 2400) this.flush(); } return true; }
}
registerProcessor('autoum-voice-capture', AutoumVoiceCapture);
