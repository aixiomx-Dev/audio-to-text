// Cloudflare Worker: forwards audio pieces to Groq Whisper so visitors need no API key.
// Setup: Cloudflare dashboard > Workers > Create > paste this file > Deploy.
// Then Settings > Variables and Secrets > add a Secret named GROQ_KEY with your Groq key.
const ALLOWED = ['https://aixiomx-dev.github.io'];
const MAX_BYTES = 25 * 1024 * 1024;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const h = cors(origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return new Response('Audio to text proxy is running.', { headers: h });
    if (!ALLOWED.includes(origin)) return new Response('Not allowed', { status: 403, headers: h });
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return new Response('Piece too big', { status: 413, headers: h });
    if (!env.GROQ_KEY) return new Response('GROQ_KEY secret is missing', { status: 500, headers: h });

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.GROQ_KEY, 'Content-Type': req.headers.get('Content-Type') },
      body: req.body,
    });
    const out = new Headers(h);
    out.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    const ra = res.headers.get('Retry-After');
    if (ra) out.set('Retry-After', ra);
    return new Response(res.body, { status: res.status, headers: out });
  },
};
