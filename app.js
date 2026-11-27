import { FFmpeg } from './ffmpeg/index.js';
{
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

// Set PROXY to the Cloudflare Worker URL to let visitors convert without their own key.
const PROXY = '';
const FAST_SEG = 600;   // seconds per upload chunk (10 min of 32 kbps opus is about 2.4 MB)
const LOCAL_SEG = 60;   // seconds per on-phone chunk
const PROMPTS = {
  tamil: 'இது தமிழ் மற்றும் English கலந்த பேச்சு. நாளைக்கு meeting-க்கு வரேன், okay வா? சரி, அப்புறம் பேசலாம்.',
  tanglish: 'Idhu Tamil and English mix pesura audio. Naan naalaikku meeting ku varen, okay va? Seri, apram pesalam.',
};

let file = null;
let mode = store.get('mode2') || 'local';
let running = false;
let stopFlag = false;
let ffmpeg = null;
let worker = null;
let wakeLock = null;
let parts = [];

// ---------- UI wiring ----------
$('key').value = store.get('groqKey');
$('lang').value = store.get('lang');
$('script').value = store.get('script');
$('model').value = store.get('model') || 'onnx-community/whisper-base';
$('out').value = store.get('lastText');
if ($('out').value) { $('outBox').hidden = false; updateCount(); }

function setMode(m) {
  mode = m; store.set('mode2', m);
  $('mFast').setAttribute('aria-pressed', m === 'fast');
  $('mLocal').setAttribute('aria-pressed', m === 'local');
  $('fastBox').hidden = m !== 'fast' || !!PROXY;
  $('scriptBox').hidden = m !== 'fast';
  $('localBox').hidden = m !== 'local';
  refreshGo();
}
$('mFast').onclick = () => setMode('fast');
$('mLocal').onclick = () => setMode('local');
setMode(mode);

$('key').oninput = () => { store.set('groqKey', $('key').value.trim()); refreshGo(); };
$('lang').onchange = () => store.set('lang', $('lang').value);
$('script').onchange = () => store.set('script', $('script').value);
$('model').onchange = () => store.set('model', $('model').value);

function refreshGo() {
  const needKey = mode === 'fast' && !PROXY && !$('key').value.trim();
  $('go').disabled = running || !file || needKey;
  $('go').textContent = !file ? 'Choose a file first' : needKey ? 'Paste your Groq key first' : 'Convert to text';
}

function pickFile(f) {
  if (!f) return;
  file = f;
  $('dropTitle').textContent = f.name;
  $('dropTitle').className = 'fname';
  $('dropSub').textContent = fmtSize(f.size) + ' · tap to change';
  refreshGo();
}
$('file').onchange = (e) => pickFile(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));

$('copy').onclick = async () => {
  const t = $('out').value;
  if (!t) return;
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; } catch {
    $('out').select();
    try { ok = document.execCommand('copy'); } catch {}
  }
  $('copy').textContent = ok ? 'Copied ✓' : 'Select & copy';
  $('copy').classList.toggle('done', ok);
  setTimeout(() => { $('copy').textContent = 'Copy'; $('copy').classList.remove('done'); }, 2000);
};
$('dl').onclick = () => {
  const blob = new Blob([$('out').value], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (file ? file.name.replace(/\.[^.]+$/, '') : 'transcript') + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('clear').onclick = () => { $('out').value = ''; store.set('lastText', ''); updateCount(); };
$('out').oninput = () => { store.set('lastText', $('out').value); updateCount(); };
$('stop').onclick = () => { stopFlag = true; status('Stopping after this part…'); };
$('go').onclick = () => run();

function updateCount() {
  const w = $('out').value.trim().split(/\s+/).filter(Boolean).length;
  $('count').textContent = w ? w + ' words' : '';
}
function status(t, cls) { $('status').textContent = t; $('status').className = cls || ''; }
function sub(t) { $('sub').textContent = t; }
function bar(f) { $('barI').style.width = Math.max(0, Math.min(100, f * 100)).toFixed(1) + '%'; }
function fmtSize(b) { return b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showText() {
  const t = parts.filter(Boolean).join('\n\n');
  $('out').value = t;
  store.set('lastText', t);
  updateCount();
}

// ---------- keep the screen awake ----------
async function lockScreen() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') lockScreen();
});

// ---------- ffmpeg: read any audio, cut it into small pieces ----------
let ffLog = '';
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  status('Loading audio tools (one time, about 30 MB)…');
  const ff = new FFmpeg();
  ff.on('log', ({ message }) => { ffLog += message + '\n'; });
  const base = new URL('ffmpeg/', location.href).href;
  await ff.load({
    coreURL: base + 'ffmpeg-core.js',
    wasmURL: base + 'ffmpeg-core.wasm',
  });
  ffmpeg = ff;
  return ff;
}

async function mountInput(ff, f) {
  try { await ff.unmount('/in'); } catch {}
  try { await ff.deleteDir('/in'); } catch {}
  await ff.createDir('/in');
  const ext = (f.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase();
  const safe = new File([f], 'input' + ext, { type: f.type });
  await ff.mount('WORKERFS', { files: [safe] }, '/in');
  return '/in/' + safe.name;
}

async function probeDuration(ff, inp) {
  ffLog = '';
  try { await ff.exec(['-hide_banner', '-i', inp]); } catch {}
  const m = ffLog.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

async function cut(ff, inp, start, len, kind) {
  const out = kind === 'fast' ? 'seg.ogg' : 'seg.raw';
  const enc = kind === 'fast'
    ? ['-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-compression_level', '0', '-f', 'ogg']
    : ['-f', 'f32le', '-c:a', 'pcm_f32le'];
  ffLog = '';
  await ff.exec(['-hide_banner', '-nostdin', '-y', '-ss', String(start), '-t', String(len), '-i', inp,
    '-vn', '-ac', '1', '-ar', '16000', ...enc, out]);
  let data;
  try { data = await ff.readFile(out); } catch { data = new Uint8Array(0); }
  try { await ff.deleteFile(out); } catch {}
  return data;
}

// ---------- engines ----------
async function groqChunk(bytes, i) {
  const key = $('key').value.trim();
  const lang = $('lang').value;
  const prompt = PROMPTS[$('script').value];
  for (let attempt = 0; attempt < 30; attempt++) {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'audio/ogg' }), `part${i + 1}.ogg`);
    fd.append('model', 'whisper-large-v3');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (lang) fd.append('language', lang);
    if (prompt) fd.append('prompt', prompt);
    let res;
    try {
      res = PROXY
        ? await fetch(PROXY, { method: 'POST', body: fd })
        : await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
        });
    } catch {
      sub('Network problem, trying again…');
      await sleep(4000);
      continue;
    }
    if (res.ok) return ((await res.json()).text || '').trim();
    const body = await res.text().catch(() => '');
    if (res.status === 401 && PROXY) throw new Error('The site key stopped working. Tell the site owner.');
    if (res.status === 401) throw new Error('That Groq key is not working. Check it and paste it again.');
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(120, parseFloat(res.headers.get('retry-after')) || 20);
      sub(res.status === 429 ? `Free limit reached for now, waiting ${Math.ceil(wait)}s…` : 'Groq is busy, trying again…');
      await sleep(wait * 1000);
      continue;
    }
    let msg = body;
    try { msg = JSON.parse(body).error.message; } catch {}
    throw new Error('Groq said: ' + (msg || res.status));
  }
  throw new Error('Groq kept refusing. Try again later.');
}

let reqId = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'dl') {
      dl[m.file] = [m.loaded || 0, m.total || 0];
      let a = 0, b = 0;
      for (const k in dl) { a += dl[k][0]; b += dl[k][1]; }
      if (b) { bar(a / b); sub(`${fmtSize(a)} of ${fmtSize(b)}`); }
    } else if (m.type === 'note') sub(m.text);
    else if (m.type === 'ready') { const p = pending.get('load'); pending.delete('load'); p && p.res(); }
    else if (m.type === 'result' || m.type === 'error') {
      const key = m.id === undefined ? 'load' : m.id;
      const p = pending.get(key); pending.delete(key);
      if (!p) return;
      m.type === 'result' ? p.res(m.text) : p.rej(new Error(m.text));
    }
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.rej(new Error('Could not load or run the speech model. Check your internet, or try the Base model or Turbo.'));
    pending.clear();
    worker = null;
  };
  return worker;
}
const dl = {};
function loadModel() {
  status('Downloading speech model (one time)…');
  bar(0);
  const device = navigator.gpu && $('model').value.endsWith('base') ? 'webgpu' : 'wasm';
  return new Promise((res, rej) => {
    pending.set('load', { res, rej });
    getWorker().postMessage({ type: 'load', model: $('model').value, device });
  });
}
function localChunk(bytes) {
  const audio = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const copy = new Float32Array(audio);
  const id = ++reqId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    getWorker().postMessage({ type: 'run', id, audio: copy, language: $('lang').value || null }, [copy.buffer]);
  });
}

// ---------- main ----------
async function run() {
  if (running || !file) return;
  running = true; stopFlag = false; parts = [];
  $('stop').hidden = false;
  refreshGo();
  $('progBox').hidden = false;
  $('outBox').hidden = false;
  $('out').value = '';
  updateCount();
  bar(0); sub('');
  await lockScreen();
  const t0 = Date.now();
  try {
    const ff = await getFFmpeg();
    const inp = await mountInput(ff, file);
    status('Reading the audio…');
    const dur = await probeDuration(ff, inp);
    if (mode === 'local') await loadModel();

    const seg = mode === 'fast' ? FAST_SEG : LOCAL_SEG;
    const total = dur ? Math.ceil(dur / seg) : 0;
    const tStart = Date.now();
    const inflight = new Set();
    let done = 0;
    let jobErr = null;
    for (let i = 0, start = 0; ; i++, start += seg) {
      if (stopFlag) break;
      if (dur && start >= dur) break;
      const label = total ? `Part ${i + 1} of ${total}` : `Part ${i + 1}`;
      status(`${label}: preparing audio…`);
      const bytes = await cut(ff, inp, start, seg, mode);
      if (bytes.byteLength < (mode === 'fast' ? 800 : 3200)) {
        if (!dur || i === 0) {
          if (i === 0) throw new Error('Could not read any sound from this file. Is it really an audio file?');
          break;
        }
        continue;
      }
      const finish = (text) => {
        parts[i] = text;
        showText();
        done++;
        if (total) {
          bar(done / total);
          const per = (Date.now() - tStart) / done;
          sub(`${done} of ${total} parts done · about ${fmtTime(per * (total - done) / 1000)} left`);
        } else sub(`${done} parts done`);
      };
      if (mode === 'fast') {
        // Upload this piece in the background and start cutting the next one.
        status(`${label}: sending…`);
        const job = groqChunk(bytes, i).then(finish);
        inflight.add(job);
        job.catch((e) => { jobErr = jobErr || e; stopFlag = true; }).finally(() => inflight.delete(job));
        if (inflight.size >= 3) await Promise.race(inflight).catch(() => {});
      } else {
        status(`${label}: listening…`);
        finish(await localChunk(bytes));
      }
    }
    if (inflight.size) { status('Finishing the last parts…'); await Promise.allSettled([...inflight]); }
    if (jobErr) throw jobErr;
    const took = fmtTime((Date.now() - t0) / 1000);
    if (stopFlag) status(`Stopped. Text so far is below (${took}).`);
    else { bar(1); status(`Done in ${took}. Tap Copy.`, 'okc'); sub(''); }
    $('outBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    status(err.message || String(err), 'err');
  } finally {
    running = false;
    $('stop').hidden = true;
    try { wakeLock && (await wakeLock.release()); } catch {}
    wakeLock = null;
    refreshGo();
  }
}
}
