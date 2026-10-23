# Anikage API

**in Worker.js please add your [plyr](https://github.com/Anikage-Group/plyr) and [api](https://github.com/Anikage-Group/Anime-API) urls before deploying. otherwise API will be only partially functional**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-USERNAME/YOUR-REPO)

A Cloudflare Worker that takes an **AniList ID + episode number** and returns one JSON response containing every playable source it can find: HLS streams (wrapped in a ready-to-use player link), embed pages, download links, subtitles, and intro/outro skip times.

It also bundles a **stream proxy** (`/p/…`) that rewrites HLS/DASH manifests so playback works from the browser, and a small **playground page** (`index.html`) served at `/`.

---

## Features

- **One endpoint, many providers** – queries several upstream providers in parallel (sub and dub) and merges the results.
- **Server categories** – sources are grouped by type (see [Response](#response)).
- **Skip times** – uses the provider's own intro/outro ranges when present, otherwise falls back to AniSkip.
- **Episode metadata** – title and thumbnail via ani.zip.
- **Built-in proxy** – referer/header injection, HLS and DASH manifest rewriting, playlist-key decryption, default-audio switching (sub/dub), FlixCloud HD-2 image-segment unwrapping.
- **SSRF protection** – private/local/loopback addresses and credentialed URLs are rejected.
- **Playground UI** – test requests, preview the player, browse results and build proxy URLs.

---

## Project structure

```
Anikage API/
├── worker.js              # Worker entry: routing, provider aggregation, player-link builder
├── flixcloud.js           # FlixCloud embed resolver (extracts the m3u8 URL, keys, subtitles, chapters)
├── index.html             # Playground / docs page (bundled into the Worker as text)
├── proxy/
│   ├── proxy-core.js      # Proxy handler: URL parsing, manifest rewriting, redirects, CORS
│   ├── node-safety.js     # Node-only: DNS-resolving SSRF check (not used by the Worker)
│   └── wreq-fallback.js   # Node-only: optional wreq-js fallback on 403 (not used by the Worker)
├── wrangler.toml          # Worker config (service binding, text rule for .html, vars)
└── package.json           # Scripts and dev dependencies
```

> `.wrangler/` is local Wrangler/Miniflare state. Don't commit it – add it to `.gitignore`.

---

## Getting started

### Requirements

- Node.js ≥ 20
- A Cloudflare account and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

### Install and run locally

```bash
npm install
npm run dev:worker      # wrangler dev
```

### Deploy

**One click:** use the **Deploy to Cloudflare Workers** button at the top of this README. It clones the repo into your GitHub/GitLab account and deploys the Worker to your Cloudflare account.

Before deploying, note:

- `wrangler.toml` has a service binding (`HAT` → `hat`). The upstream `hat` Worker must already exist on your account, or the deploy will fail. Change `service` to your Worker's name, or remove the binding and set `ANIVEXA_API_URL` to a public URL instead.
- Set `PROXY_TOKEN`, `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` after deploying (Workers dashboard → Settings → Variables) so the proxy isn't open to everyone.

**CLI:**

```bash
npm run deploy          # wrangler deploy
```

---

## Configuration

`wrangler.toml` defines:

| Setting | Purpose |
| --- | --- |
| `main = "worker.js"` | Worker entry point |
| `compatibility_flags = ["nodejs_compat"]` | Needed for `node:zlib`, `node:buffer`, `node:crypto` |
| `[[rules]]` Text for `**/*.html` | Bundles `index.html` into the Worker |
| `[[services]] HAT → hat` | Service binding to the upstream "hat" Worker on the same account (avoids Cloudflare error 1042 for Worker → workers.dev calls). Change `service` if your Worker has a different name. |

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ANIVEXA_API_URL` | `https://hat.anikage.workers.dev` | Base URL of the upstream provider API |
| `STREAM_PROXY_URL` | _(unset)_ | External proxy base URL. If unset, the Worker's own `/p/` route is used |
| `PROXY_TOKEN` | _(unset)_ | If set, proxy requests must send it as `X-Proxy-Token` (or the packed/query `access` field) |
| `ALLOWED_HOSTS` | _(unset)_ | Comma-separated hostnames the proxy may fetch (subdomains included) |
| `ALLOWED_ORIGINS` | _(unset)_ | Comma-separated origins for CORS on proxy routes (`*` allowed). Unset = `*` |
| `PROXY_USER_AGENT` | _(unset)_ | User-Agent used by the proxy when the client doesn't send one |

**The proxy is open by default.** For any public deployment, set `PROXY_TOKEN`, `ALLOWED_HOSTS` and `ALLOWED_ORIGINS`.

---

## API

### `GET /:anilistId/:episode`

Alias: `GET /api/public/watch/:anilistId/:episode`

| Query param | Default | Description |
| --- | --- | --- |
| `ap` | `true` | Autoplay flag embedded in the player link |
| `ski` | `false` | Auto-skip intro flag embedded in the player link |
| `sko` | `false` | Auto-skip outro flag embedded in the player link |

Boolean values accept `true/1/yes/y` and `false/0/no/n`.

```bash
curl https://<your-worker>/21/1
curl "https://<your-worker>/21/1?ski=true&sko=true&ap=false"
```

### Response

```jsonc
{
  "anilistId": 21,
  "malId": 21,
  "episode": 1,
  "title": "Episode title",
  "player": "https://plyr.anikage.workers.dev/e/",
  "skip": { "exist": true, "intro": "12,102", "outro": "1320,1410" },
  "servers": {
    "h-sub": { "<label>": "<player link>" },   // HLS, no subtitle tracks
    "s-sub": { "<label>": "<player link>" },   // HLS with subtitle tracks
    "dub":   { "<label>": "<player link>" },   // HLS dub
    "e-sub": { "<label>": "<embed url>"  },    // embed pages (sub)
    "e-dub": { "<label>": "<embed url>"  },    // embed pages (dub)
    "v-sub": { "<name>":  "<embed url>"  },    // generated third-party embed URLs (sub)
    "v-dub": { "<name>":  "<embed url>"  }     // generated third-party embed URLs (dub)
  },
  "downloads": [{ "server": "…", "label": "…", "url": "…" }],
  "providers": { "flix": "ok", "anipm": "ok", "anikoto": "empty", "aniwaves": "down", "animegg": "ok" }
}
```

- Empty server categories are omitted.
- `providers` status is `ok` (returned sources), `empty` (responded with nothing usable) or `down` (no response).
- Player links are the payload (title, proxied stream, thumbnail, subtitles, skip times, autoplay) brotli-compressed and base64-encoded onto the `player` URL.

**Errors:** `400` invalid id/episode · `404` unknown route · `502` upstream failure.
Responses are sent with `Cache-Control: public, max-age=1000` and open CORS (`GET, OPTIONS`).

### Providers

| Source | Notes |
| --- | --- |
| Flix (ReAnime / FlixCloud) | Embed pages are resolved into HLS through `flixcloud.js`; direct embeds also listed in `e-sub` / `e-dub` |
| `anipm`, `anikoto`, `aniwaves`, `animegg` | Queried through the upstream API (`/watch/:provider/:id/:audio/:provider-:episode`) |
| Video servers (`v-sub` / `v-dub`) | URL templates in `VIDEO_SERVERS` filled with the AniList/MAL id, episode and language |

To add or remove a provider, edit `PROVIDERS` and `PROVIDER_NAMES` in `worker.js`; to add a generated embed server, add an entry to `VIDEO_SERVERS` (placeholders: `{ani}`, `{mal}`, `{ep}`, `{lang}`).

### Proxy routes

| Route | Description |
| --- | --- |
| `GET /p/<base64url>` | Packed form. The payload is NUL-separated fields: `url, ref, referer, headers, key, playlist_key, unwrap, access, audio` (trailing empty fields may be dropped) |
| `GET /proxy?url=<target>` | Query form. Also accepts `ref`, `headers` (JSON), `key`, `playlist_key`, `unwrap`, `access`, `audio` |
| `GET /health` | Returns `{"status":"ok"}` |

Behaviour:

- HLS (`.m3u8`) and DASH (`.mpd`) manifests are detected by type, extension or content sniffing, and every URL inside is rewritten to go back through the proxy.
- `playlist_key` / `key` decrypts XOR-obfuscated manifests.
- `audio=dub` (or a language code) sets the matching audio rendition as default in master playlists.
- `unwrap=flixcloud-hd2` unwraps image-disguised transport-stream segments.
- Max manifest size 2 MB, max wrapped segment 48 MB, 20 s upstream timeout, up to 8 redirects.
- Methods: `GET`, `HEAD`, `OPTIONS`.

### Debug routes

`/_debug` and `/_flix/:anilistId/:episode` return raw upstream data. They are marked temporary in the code – remove or protect them before going public.

---

## Playground

Open `/` on the deployed Worker. It includes a request playground (with anime search and a player preview), an endpoint reference, and a proxy URL builder.

---
## How to make use of the Cloudflare Edge network

If you want to deploy this backend proxy script directly to the Cloudflare Edge network (using the worker name **`hat`** with the filename `worker.js`), follow these steps:

### Create `worker.js` for the worker named hat.
use the code given below

```javascript
// Replace this with your exact backend URL (e.g., your free Render web service URL)
const BACKEND_URL = "";

export default {
  // 1. LIVE PROXY & STATUS HANDLER
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- STATUS PAGE ROUTE ----  
    // Accessing your-worker.workers.dev/status will show this health dashboard  
    if (url.pathname === "/status") {  
      const startTime = Date.now();  
      let backendStatus = "Unknown";  
      let latency = "N/A";

      try {  
        const res = await fetch(BACKEND_URL);  
        backendStatus = `${res.status} ${res.statusText}`;  
        latency = `${Date.now() - startTime}ms`;  
      } catch (err) {  
        backendStatus = `Offline / Error: ${err.message}`;  
      }

      const html = `  
        <!DOCTYPE html>  
        <html lang="en">  
        <head>  
          <meta charset="UTF-8">  
          <meta name="viewport" content="width=device-width, initial-scale=1.0">  
          <title>API Proxy Status</title>  
          <style>  
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }  
            .card { background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 100%; max-width: 450px; margin: auto; }  
            h1 { font-size: 1.5rem; margin-top: 0; color: #38bdf8; border-bottom: 1px solid #334155; padding-bottom: 0.75rem; }  
            .grid { display: grid; grid-template-columns: 120px 1fr; gap: 0.75rem; margin-top: 1rem; }  
            .label { font-weight: bold; color: #94a3b8; }  
            .value { font-family: monospace; word-break: break-all; }  
            .status-ok { color: #4ade80; }  
            .status-err { color: #f87171; }  
          </style>  
        </head>  
        <body>  
          <div class="card">  
            <h1>🌐 Proxy API Gateway Status</h1>  
            <div class="grid">  
              <div class="label">Proxy URL:</div>  
              <div class="value">${url.origin}</div>  
              <div class="label">Backend Target:</div>  
              <div class="value">${BACKEND_URL}</div>  
              <div class="label">Backend Ping:</div>  
              <div class="value ${backendStatus.startsWith('2') ? 'status-ok' : 'status-err'}">${backendStatus}</div>  
              <div class="label">Latency:</div>  
              <div class="value">${latency}</div>  
              <div class="label">Timestamp:</div>  
              <div class="value">${new Date().toISOString()}</div>  
            </div>  
          </div>  
        </body>  
        </html>  
      `;  
      return new Response(html, { headers: { "Content-Type": "text/html" } });  
    }

    // ---- ALL OTHER /... NESTED URLS PROXY ROUTE ----  
    // Captures the full sub-pathing (e.g., /api/scrape?user=test)  
    const targetUrl = `${BACKEND_URL}${url.pathname}${url.search}`;

    const modifiedRequest = new Request(targetUrl, {  
      method: request.method,  
      headers: request.headers,  
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,  
      redirect: "manual"  
    });

    try {  
      const response = await fetch(modifiedRequest);  
      return response;  
    } catch (error) {  
      return new Response(`Proxy Error: Unable to reach backend. ${error.message}`, { status: 502 });  
    }  
  }
};
```
## Notes

- `npm start` points to `server.js`, which isn't in this repo; use `npm run dev:worker` / `npm run deploy`.
- `proxy/node-safety.js` and `proxy/wreq-fallback.js` are for running the proxy under Node (DNS-level private-address checks and a browser-impersonating fallback on `403`). The Worker build doesn't import them.
- Streams come from third-party providers. You're responsible for making sure your use complies with the law and those providers' terms.
