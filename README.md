# Audio to text

Free website that turns a big audio file (WhatsApp voice notes, recordings up to 150 MB and more) into text, with a Copy button. Works with Tamil, English and mixed speech.

**Live site:** https://aixiomx-dev.github.io/audio-to-text/

## Two modes

- **Fast mode** (recommended): uses Whisper large-v3 on [Groq](https://console.groq.com/keys) with your own free API key. The audio is cut into 10-minute pieces in the browser and sent straight from your phone to Groq. The key is saved only in your browser.
- **On this phone**: runs Whisper (base or small) fully in the browser with transformers.js. No account and nothing leaves the phone, but it is slow on long audio and weaker at Tamil.

## How it works

`ffmpeg.wasm` reads any audio or video format and cuts it into small 16 kHz mono pieces without loading the whole file into memory. Each piece is transcribed and the text appears as it is ready.

No server, no build step: plain static files served by GitHub Pages.

Uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (core is GPL-2.0+), [transformers.js](https://github.com/huggingface/transformers.js) and OpenAI Whisper models.

## No-key mode (key hidden on Cloudflare)

`proxy/worker.js` is a free Cloudflare Worker that holds the site owner's Groq key, so visitors don't need one.

1. Cloudflare dashboard → Workers & Pages → Create → Worker → Deploy, then Edit code, paste `proxy/worker.js`, Deploy.
2. Worker → Settings → Variables and Secrets → Add → type Secret, name `GROQ_KEY`, value your Groq key.
3. Put the worker URL in `PROXY` at the top of `app.js`. The key box then disappears from the site.

Groq's free limit is shared by every visitor (roughly 2 hours of audio per hour, 8 hours per day).
