import { mkdir, readFile, writeFile, access, rename, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), directory = join(root, '.cache/voice-models');
const models = [
  { id: 'onnx-community/whisper-base.en', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe', files: ['README.md', 'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'normalizer.json', 'merges.txt', 'vocab.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'] },
  { id: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', files: ['README.md', 'config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', ...['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_puck'].map(v => `voices/${v}.bin`)] },
];
const manifest = [];
for (const model of models) {
  const response = await fetch(`https://huggingface.co/api/models/${model.id}/revision/${model.revision}?blobs=true`);
  if (!response.ok) throw Error('Could not verify voice model revision.'); const metadata = await response.json();
  if (metadata.sha !== model.revision) throw Error('Voice model revision mismatch.');
  for (const name of model.files) {
    const meta = metadata.siblings.find(f => f.rfilename === name); if (!meta) throw Error('Missing voice model asset: ' + name);
    const path = join(directory, model.id, name); await mkdir(dirname(path), { recursive: true });
    const verify = async () => { const bytes = await readFile(path); if (bytes.length !== meta.size) return false; return meta.lfs ? createHash('sha256').update(bytes).digest('hex') === meta.lfs.sha256 : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === meta.blobId; };
    if (!await verify().catch(() => false)) {
      const download = await fetch(`https://huggingface.co/${model.id}/resolve/${model.revision}/${name}`);
      if (!download.ok) throw Error(`Voice download failed (${download.status}): ${name}`);
      await writeFile(path + '.tmp', Buffer.from(await download.arrayBuffer())); await rename(path + '.tmp', path);
      if (!await verify()) { await rm(path); throw Error('Voice asset checksum mismatch: ' + name); }
    }
    const bytes = await readFile(path); manifest.push({ model: model.id, revision: model.revision, file: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log('Verified voice asset: ' + model.id + '/' + name);
  }
}
for (const name of ['WHISPER-LICENSE.txt', 'KOKORO-LICENSE.txt']) await cp(join(root, 'extension', name), join(directory, name));
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ input: 'Whisper Base English', output: 'Kokoro 82M', assets: manifest }, null, 2));
console.log('Bundled local voice assets ready.');
