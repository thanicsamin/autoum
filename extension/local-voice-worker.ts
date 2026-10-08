import { env, pipeline, AutoTokenizer, StyleTextToSpeech2Model, Tensor } from '@huggingface/transformers';
import { Language } from '@met4citizen/headtts/modules/language-en-us.mjs';
import dictionary from '@met4citizen/headtts/dictionaries/en-us.txt';
env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false;
env.localModelPath = new URL('voice-models/', self.location.href).href;
env.backends.onnx.wasm!.wasmPaths = new URL('voice-runtime/', self.location.href).href;
env.backends.onnx.wasm!.numThreads = 1; env.backends.onnx.wasm!.proxy = false;
let asr: any, model: any, tokenizer: any, language: Language | undefined;
const styles = new Map<string, Float32Array>();
self.onmessage = async ({ data }) => {
  const { id, kind } = data; const status = (message: string) => self.postMessage({ id, status: message });
  try {
    if (kind === 'transcribe') {
      if (!asr) { status('Loading bundled speech recognition…'); asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'wasm', local_files_only: true }); }
      status('Understanding speech…'); const result = await asr(data.audio, { chunk_length_s: 30, stride_length_s: 5 }); self.postMessage({ id, text: result.text });
    } else {
      if (!['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_puck'].includes(data.voice)) throw Error('Choose a bundled fallback voice.');
      if (!model) { status('Loading bundled natural voice…'); [model, tokenizer] = await Promise.all([StyleTextToSpeech2Model.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm', local_files_only: true }), AutoTokenizer.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { local_files_only: true })]); language = new Language(); language.dictionary = {}; for (const line of dictionary.split(/\r?\n/)) language.addToDictionary(line); }
      const { phonemes } = language!.generate(data.text), { input_ids } = tokenizer(phonemes.join(''), { truncation: true }); const length = Math.min(Math.max(input_ids.size - 2, 0), 509);
      let style = styles.get(data.voice);
      if (!style) { const response = await fetch(new URL(`voice-models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/${data.voice}.bin`, self.location.href)); if (!response.ok) throw Error('Bundled voice data is missing.'); style = new Float32Array(await response.arrayBuffer()); styles.set(data.voice, style); }
      status('Speaking…'); const { waveform } = await model({ input_ids, style: new Tensor('float32', style.slice(length * 256, (length + 1) * 256), [1, 256]), speed: new Tensor('float32', [1], [1]) });
      const audio = new Float32Array(waveform.data); self.postMessage({ id, audio, sampleRate: 24000 }, { transfer: [audio.buffer] });
    }
  } catch (e: any) { self.postMessage({ id, error: e.message || 'Bundled voice could not run.' }); }
};
