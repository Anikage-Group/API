<div align="center">

<img src="public/logo.png" alt="AniKage Player" width="120" />

# AniKage Player

**A serverless HLS video player and downloader, configured entirely by the URL and served from a Cloudflare Worker.**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/plyr)

</div>

---

## Overview

AniKage Player is a single-file web app (`public/index.html`) with a thin Cloudflare Worker (`src/index.js`) in front of it. There is no backend and no database. Every link carries its own config: a JSON object that is brotli-compressed and base64url-encoded into the path.

- **Player** at `/e/<data>`, built on [Artplayer](https://github.com/zhw2590582/ArtPlayer) and hls.js
- **Downloader** at `/d/<data>`, which saves HLS streams segment by segment, or direct mp4/webm/mkv files as a single download
- **Docs and decode tool** at any other route, with a config reference, a live "try it" box, and a decoder for existing links

## Features

- HLS (`.m3u8`) playback with quality and audio track selection
- Auto-detects progressive `mp4` / `webm` / `mkv` streams by content sniffing, not file extension
- Multiple WebVTT subtitle tracks, each toggled from the Subtitles menu
- Intro and outro markers on the seek bar, with skip buttons and optional auto-skip
- Poster image and autoplay support
- Embeddable in an `<iframe>` from any origin, with a `postMessage` bridge for host control
- Downloader saves every subtitle track as its own `.vtt` file
- Worker adds CORS, `Permissions-Policy` (fullscreen, PiP, autoplay) and embed-friendly headers

## One-click deploy

Click the button at the top of this README. Cloudflare will clone the repo into your account, set up the Worker and deploy it. No environment variables or secrets are needed.

> **Note:** after you push this project to GitHub, edit the button URL at the top of this file and replace `YOUR_USERNAME/plyr` with your own `owner/repo`.

## Manual deploy

Requirements: [Node.js](https://nodejs.org/) 18+ and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
git clone https://github.com/YOUR_USERNAME/plyr.git
cd plyr
npm install

# run locally at http://localhost:8787
npm run dev

# log in once, then deploy
npx wrangler login
npm run deploy
```

To use a custom domain, add a route or custom domain to the Worker in the Cloudflare dashboard, or in `wrangler.jsonc`.

## Project structure

```
plyr/
├── public/
│   ├── index.html      # player, downloader and docs views in one file
│   ├── logo.png
│   └── favicon.ico
├── src/
│   └── index.js        # Worker: routing + response headers
├── package.json
└── wrangler.jsonc      # Worker + static assets config
```

## Routes

| Route | Result |
| --- | --- |
| `/e/<data>` or `/e/?=<data>` | Player |
| `/d/<data>` or `/d/?=<data>` | Downloader |
| anything else without a file extension | Docs and decode tool |

The page reads `location.pathname` to decide which view to show. The Worker makes sure `/e/*` and `/d/*` always resolve to the app instead of 404ing, and maps nested asset paths such as `/e/logo.png` back to `/logo.png`.

## Config schema

The decoded payload is one JSON object:

```json
{
  "vid": {
    "stream": "https://example.com/path/playlist.m3u8"
  },
  "thumb": {
    "exist": true,
    "thumb": "https://example.com/path/poster.jpg"
  },
  "subs": {
    "exist": true,
    "tracks": [
      {
        "id": "en_full",
        "label": "English",
        "url": "https://example.com/path/en.vtt",
        "default": true
      }
    ]
  },
  "skip": {
    "exist": true,
    "intro": "0,43",
    "outro": "1305,1320"
  },
  "auto": {
    "ski": false,
    "sko": false,
    "autoplay": true
  },
  "meta": {
    "title": "Episode title shown in the downloader",
    "filename": "download.ts"
  }
}
```

| Field | Required | Used by | Notes |
| --- | --- | --- | --- |
| `vid.stream` | Yes | Player, Downloader | HLS master or media playlist, or a direct mp4/webm/mkv URL |
| `thumb` | No | Player, Downloader | Poster image; omit or set `exist: false` to skip |
| `subs` | No | Player, Downloader | Any number of WebVTT tracks |
| `skip` | No | Player | `"start,end"` in seconds for `intro` and `outro` |
| `auto` | No | Player | `ski` and `sko` auto-skip intro/outro; `autoplay` starts playback |
| `meta` | No | Downloader | Display title and suggested filename |

## Generating links

Browsers can decompress brotli but can't compress it, so links are generated server-side or at build time. Any language with a brotli library works. Reference Node.js snippet:

```js
const zlib = require('zlib');

function encode(config) {
  const compressed = zlib.brotliCompressSync(
    Buffer.from(JSON.stringify(config), 'utf8'),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }
  );
  return compressed.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''); // base64url, unpadded
}

console.log('https://your-worker.workers.dev/e/' + encode(myConfig));
console.log('https://your-worker.workers.dev/d/' + encode(myConfig));
```

Standard or URL-safe base64, padded or not, all decode fine. To inspect an existing link, open the docs page and use the **Decode tool**.

## Embedding

```html
<iframe
  src="https://your-worker.workers.dev/e/<data>"
  allow="fullscreen; picture-in-picture; autoplay"
  allowfullscreen
  style="width:100%; aspect-ratio:16/9; border:0;"
></iframe>
```

The embedding page must grant `fullscreen`, `picture-in-picture` and `autoplay` through the `allow` attribute, because iframe permissions can't be widened from inside.

### postMessage API

**Player to host.** Messages have `source: "anikage-player"` and a `type`:

| `type` | Payload |
| --- | --- |
| `ready` | `duration` |
| `status` | `ok`, `attempt` |
| `play` / `pause` | `currentTime` |
| `time` | `currentTime`, `duration`, `reason` (`interval` or `seek`) |
| `ended` | `currentTime`, `duration` |
| `skipped` | `segment` (`intro` or `outro`), `auto`, `to` |

**Host to player.** Send messages with `source: "anikage-player-host"`:

```js
const player = iframe.contentWindow;

player.postMessage({ source: 'anikage-player-host', type: 'seek', time: 120 }, '*');
player.postMessage({ source: 'anikage-player-host', type: 'togglePlay' }, '*');
```

Available commands: `seek` (`time`), `play`, `pause`, `togglePlay`, `skipIntro`, `skipOutro`, `setAutoSkipIntro` (`value`), `setAutoSkipOutro` (`value`), `setAutoplay` (`value`).

## Configuration

`wrangler.jsonc` holds the Worker config:

```jsonc
{
  "name": "plyr",                     // change this to rename your Worker
  "main": "src/index.js",
  "compatibility_date": "2025-09-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": true          // so /e/* and /d/* never hit the static router
  }
}
```

## Notes

- Stream, thumbnail and subtitle hosts must allow cross-origin requests (CORS) for the player and downloader to fetch them from the browser.
- Only `GET`, `HEAD` and `OPTIONS` requests are accepted; anything else returns `405`.
- Third-party libraries (Artplayer, hls.js, Tailwind, Font Awesome) load from CDNs at runtime.

## License

[MIT](https://choosealicense.com/licenses/mit/) License