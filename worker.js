// Speech-to-text worker: runs Whisper in the browser with transformers.js.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let asr = null;
let loadedKey = '';

async function load(model, device) {
  const key = model + '|' + device;
  if (asr && loadedKey === key) return;
  const dtype = { encoder_model: 'q8', decoder_model_merged: 'q8' };
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress') {
        self.postMessage({ type: 'dl', file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  });
  loadedKey = key;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      try {
        await load(m.model, m.device);
      } catch (err) {
        if (m.device !== 'webgpu') throw err;
        await load(m.model, 'wasm');
        self.postMessage({ type: 'note', text: 'Using normal mode (this phone has no GPU support).' });
      }
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const opts = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };
      if (m.language) opts.language = m.language;
      const out = await asr(m.audio, opts);
      self.postMessage({ type: 'result', id: m.id, text: (out.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, text: String(err && err.message || err) });
  }
};
