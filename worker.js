import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { Buffer } from "node:buffer";
import { handleProxyRequest } from "./proxy/proxy-core.js";
import { extractFlixcloud } from "./flixcloud.js";
import indexHtml from "./index.html";

// Config comes from Worker vars (wrangler.toml / dashboard); set once per request in fetch().
let API = "";
let STREAM_PROXY_OVERRIDE = null;
// Service binding to the "hat" Worker (same account). Avoids Cloudflare error 1042
// (Worker -> workers.dev Worker fetches are blocked). Falls back to public fetch if unbound.
let HAT = null;
const callApi = (url, init) =>
  HAT && url.startsWith(API) ? HAT.fetch(url, init) : fetch(url, init);
const ANISKIP = "https://api.aniskip.com/v2";
const ANIZIP = "https://api.ani.zip/mappings";
const PLAYER = "https://plyr.----.workers.dev/e/";

// Video servers for v-sub / v-dub categories.
const VIDEO_SERVERS = [
  { name: "Meg", url: "https://megaplay.buzz/stream/mal/{mal}/{ep}/{lang}" },
  { name: "Meg2", url: "https://megaplay.buzz/stream/ani/{ani}/{ep}/{lang}" },
  { name: "PMH1", url: "https://ani.pm/embed/ani/{ani}/{ep}/{lang}?hardsub=1" },
  { name: "PMH2", url: "https://ani.pm/embed/mal/{mal}/{ep}/{lang}?hardsub=1" },  
  { name: "PM1", url: "https://ani.pm/embed/ani/{ani}/{ep}/{lang}" },
  { name: "PM2", url: "https://ani.pm/embed/mal/{mal}/{ep}/{lang}" },
  { name: "vid1", url: "https://megavid.buzz/mal/{mal}/{ep}/{lang}?color=%2322d3a5" },
  { name: "vid2", url: "https://megavid.buzz/ani/{ani}/{ep}/{lang}?color=%2322d3a5" },
  { name: "pro1", url: "https://vidlink.pro/anime/{mal}/{ep}/{lang}" },
  { name: "pro2", url: "https://vidlink.pro/anime/{mal}/{ep}/{lang}?fallback=true" },
  { name: "nest", url: "https://vidnest.fun/anime/{ani}/{ep}/{lang}" },
  { name: "pahe", url: "https://vidnest.fun/animepahe/{ani}/{ep}/{lang}" },
  { name: "uscc", url: "https://tryembed.us.cc/embed/anime/{ani}/{ep}/{lang}" },
  { name: "easy", url: "https://player.videasy.net/anime/{mal}/{ep}?color=10B981&amp;overlay=true" },
  { name: "zoko1", url: "https://zokoanime.video/stream/ani/{ani}/{ep}/{lang}" },
  { name: "zoko2", url: "https://zokoanime.video/stream/mal/{mal}/{ep}/{lang}" },
  { name: "animo1", url: "https://cdn.4animo.xyz/embed/ani/{ani}/{ep}/{lang}?k=1" },
  { name: "animo2", url: "https://cdn.4animo.xyz/embed/mal/{mal}/{ep}/{lang}?k=1" },
  { name: "link", url: "https://anilink.cc/watch/{ani}/{ep}?variant={lang}" },
  { name: "hawk1", url: "https://vidhawk.buzz/embed/ani/{ani}/{ep}/{lang}" },
  { name: "hawk2", url: "https://vidhawk.buzz/embed/mal/{mal}/{ep}/{lang}" },
  { name: "baba", url: "https://babastream.top/embed/{mal}/{ep}/{lang}" },
  { name: "XO1", url: "https://anixo.buzz/embed/ani/{ani}/{ep}?track={lang}" },
  { name: "XO2", url: "https://anixo.buzz/embed/mal/{mal}/{ep}?track={lang}" },
];

function formatUrls(videoServers, aniId, malId, ep, lang) {
  const result = {};
  for (const server of videoServers) {
    result[server.name] = server.url
      .replaceAll("{ani}", String(aniId))
      .replaceAll("{mal}", String(malId ?? aniId))
      .replaceAll("{ep}", String(ep))
      .replaceAll("{lang}", lang);
  }
  return result;
}

// Streams are served through the bundled proxy (see ./proxy). Set STREAM_PROXY_URL to point
// at an externally hosted copy instead; otherwise it is derived from the incoming request.
const proxyBaseOf = (request) =>
  STREAM_PROXY_OVERRIDE || `${new URL(request.url).origin}/p/`;

// Updated providers array for Anivexa API 2.3
const PROVIDERS = [
  "anipm",
  "anikoto",
  "aniwaves",
  "animegg",
];

const PROVIDER_NAMES = {
  mkissa: "MKissa",
  reanime: "Flix",
  anikoto: "Koto",
  animegg: "GG",
  animenosub: "ANS",
  anizone: "Zone",
  aniwaves: "Waves",
  senshi: "Sen",
  kaa: "KAA",
  animedunya: "Dunya",
  animeonsen: "Onsen",
  anipm: "PM",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-max-age": "86400",
};

// Packed field order understood by the proxy: url, ref, referer, headers, key, playlist_key, unwrap
const encodedUrlWithReferer = (url, referer = "", extra = []) => {
  const fields = [url, referer, "", ...extra];
  while (fields.length && !fields.at(-1)) fields.pop();
  return Buffer.from(fields.join("\0"), "utf8").toString("base64url");
};
const proxiedUrl = (proxyBase, url, referer = "", extra = []) =>
  `${proxyBase}${encodedUrlWithReferer(url, referer, extra)}`;
const bool = (value, fallback) =>
  value === null
    ? fallback
    : ["true", "1", "yes", "y"].includes(value.toLowerCase())
      ? true
      : ["false", "0", "no", "n"].includes(value.toLowerCase())
        ? false
        : fallback;

const hostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown";
  }
};

const UPSTREAM_HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

async function json(url, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await callApi(url, {
      signal: controller.signal,
      headers: UPSTREAM_HEADERS,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`HTTP ${response.status} ${url} :: ${body}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[${name}] ${error.name === "AbortError" ? "timed out" : error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function subtitles(stream) {
  const raw = stream.subtitles ?? stream.tracks ?? stream.subs;
  const output = [];
  const seen = new Set();
  const add = (lang, url) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    output.push({ lang: String(lang || "Subtitle"), url });
  };
  if (Array.isArray(raw))
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const kind = String(item.kind ?? item.type ?? "").toLowerCase();
      if (!kind || ["captions", "subtitles", "text"].includes(kind))
        add(
          item.lang ?? item.label ?? item.language ?? item.name,
          item.url ?? item.file ?? item.src,
        );
    }
  else if (raw && typeof raw === "object")
    for (const [lang, url] of Object.entries(raw)) add(lang, url);
  if (embedOf(stream)) {
    try {
      const embed = new URL(embedOf(stream));
      for (const key of ["sub", "subtitle", "subtitles", "caption", "captions"]) {
        for (const url of embed.searchParams.getAll(key)) add("English", url);
      }
    } catch { }
  }
  return output;
}

// Companion embed page for a stream. Some providers call it `embed`, anikoto uses `embedUrl`.
function embedOf(stream) {
  const value = stream.embed ?? stream.embedUrl;
  return typeof value === "string" && value && value !== stream.url ? value : null;
}

// Prefer the provider's own intro/outro ({start,end} seconds); fall back to aniskip.
function streamSkip(stream, fallback) {
  const range = (r) =>
    r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
      ? `${Math.round(r.start)},${Math.round(r.end)}`
      : null;
  const intro = range(stream.intro) ?? fallback.intro;
  const outro = range(stream.outro) ?? fallback.outro;
  return {
    exist: Boolean(intro || outro),
    ...(intro && { intro }),
    ...(outro && { outro }),
  };
}

function isEmbed(stream) {
  if (embedOf(stream)) {
    return false;
  }
  const type = String(stream.type || "").toLowerCase();
  return (
    ["embed", "iframe"].includes(type) ||
    (!["hls", "mp4", "m3u8"].includes(type) && !/\.(m3u8|mp4)(\?|$)/i.test(stream.url || ""))
  );
}

function subtitleId(label, index) {
  const language = label.trim().toLowerCase();
  const codes = {
    english: "en",
    spanish: "es",
    french: "fr",
    german: "de",
    italian: "it",
    portuguese: "pt",
    russian: "ru",
    arabic: "ar",
    japanese: "ja",
  };
  const code =
    codes[language] || language.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "sub";
  return `${code}_full${index ? `_${index + 1}` : ""}`;
}

function playerLink(stream, tracks, skip, auto, metadata, proxyBase) {
  const title = metadata.title || `Episode`;
  const referer = stream.referer || stream.headers?.Referer || stream.headers?.referer || "";
  const payload = {
    title: { title },
    vid: {
      stream: proxiedUrl(proxyBase, stream.url, referer, [
        "",
        stream.playlist_key || stream.key || "",
        "",
        stream.unwrap || "",
        "",
        stream.audio || "",
      ]),
    },
    thumb: metadata.thumbnail ? { exist: true, thumb: metadata.thumbnail } : { exist: false },
    subs: {
      exist: tracks.length > 0,
      tracks: tracks.map((track, index) => ({
        id: subtitleId(track.lang, index),
        label: track.lang,
        url: proxiedUrl(proxyBase, track.url, referer),
        ...(index === 0 ? { default: true } : {}),
      })),
    },
    skip: skip.exist
      ? {
        exist: true,
        ...(skip.intro && { intro: skip.intro }),
        ...(skip.outro && { outro: skip.outro }),
      }
      : { exist: false },
    auto,
  };
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(payload)), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
  });
  return `${PLAYER}${compressed.toString("base64")}`;
}

function anikoto(raw) {
  if (!raw || typeof raw !== "object") return { streams: [] };
  if (Array.isArray(raw.streams)) {
    const topLevelSubs = Array.isArray(raw.subtitles) ? raw.subtitles : [];
    const rank = (s) => (s.isActive ? 1000 : 0) + (Number(s.priority) || 0);
    const streams = raw.streams
      .filter((s) => s && typeof s.url === "string" && s.url)
      .map((s) => ({
        ...s,
        subtitles:
          Array.isArray(s.subtitles) && s.subtitles.length
            ? s.subtitles
            : topLevelSubs.filter((sub) => !sub?.source || sub.source === s.server),
      }))
      .sort((a, b) => rank(b) - rank(a));
    // Spread raw so top-level `downloads` survive (they were being dropped before).
    return { ...raw, streams };
  }
  const streams = [];
  for (const category of Object.values(raw || {})) {
    if (!category || typeof category !== "object") continue;
    const categorySubs = Array.isArray(category.subtitles) ? category.subtitles : [];
    for (const [key, values] of Object.entries(category)) {
      if (key === "subtitles" || !Array.isArray(values)) continue;
      for (const stream of values)
        if (stream?.url && typeof stream.url === "string")
          streams.push({
            ...stream,
            subtitles: categorySubs.filter((sub) => !sub?.source || sub.source === stream.server),
          });
    }
  }
  return { downloads: raw.downloads, streams };
}

async function watch(provider, id, episode, audio) {
  const result = await json(
    `${API}/watch/${provider}/${id}/${audio}/${provider}-${episode}`,
    provider,
  );
  return provider === "anikoto" && result ? anikoto(result) : result;
}

async function watchFlix(anilistId, epno) {
  const primary = `https://reanime.to/api/flix/${anilistId}/${epno}`;
  const fallback = `https://reanime.cz/api/flix/${anilistId}/${epno}`;
  let data = await json(primary, "flix:reanime.to");
  if (!data) data = await json(fallback, "flix:reanime.cz");
  return data;
}

const flixLang = (value) => {
  const v = String(value ?? "").toLowerCase();
  if (/dub/.test(v)) return "dub";
  if (/sub|raw/.test(v)) return "sub";
  return "";
};

function parseFlixServers(data) {
  const sub = [], dub = [];
  if (!data || typeof data !== "object") return { sub, dub };
  const unwrap = data.data && typeof data.data === "object" ? data.data : data;
  const entries = []; // [item, langHint]
  const collect = (value, hint = "") => {
    if (Array.isArray(value)) for (const item of value) collect(item, hint);
    else if (value && typeof value === "object") {
      if (typeof (value.dataLink ?? value.link ?? value.url ?? value.embed) === "string") entries.push([value, hint]);
      else for (const [key, child] of Object.entries(value)) collect(child, flixLang(key) || hint);
    }
  };
  for (const key of ["servers", "sources", "episodes", "sub", "dub", "raw"])
    if (unwrap[key] !== undefined) collect(unwrap[key], flixLang(key));
  if (!entries.length) collect(unwrap);

  const seen = new Set();
  for (const [item, hint] of entries) {
    const url = item.dataLink ?? item.link ?? item.url ?? item.embed;
    const name = item.serverName ?? item.name ?? item.server ?? null;
    if (typeof url !== "string" || !url) continue;
    const lang =
      [item.dataType, item.type, item.language, item.lang, item.kind, item.audio, item.category]
        .map(flixLang)
        .find(Boolean) ||
      hint ||
      flixLang(name) ||
      (/\/dub(\/|$|\?)|[?&](lang|type|audio)=dub/i.test(url) ? "dub" : "") ||
      "sub";
    // FlixCloud serves the dub track from the same embed with &a=1.
    const finalUrl = lang === "dub" && !/[?&]a=1(&|$)/.test(url) ? `${url}${url.includes("?") ? "&" : "?"}a=1` : url;
    const key = `${lang}|${finalUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (lang === "dub" ? dub : sub).push({ url: finalUrl, name });
  }
  return { sub, dub };
}

// Resolve a ReAnime/FlixCloud embed (HD-1, HD-2, ...) into a playable HLS stream.
async function flixFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  return response;
}

async function resolveFlixServer({ url, name, audio }) {
  const origin = new URL(url).origin;
  const headers = {
    accept: "text/html,application/json,*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://reanime.to/",
  };
  const page = await flixFetch(url, { headers });
  if (!page?.ok) throw new Error(`embed HTTP ${page?.status ?? "failed"}`);
  const html = await page.text();
  const data = await extractFlixcloud(html, {
    fetchImpl: flixFetch,
    apiBase: origin,
    headers: { accept: "application/json,*/*", "accept-language": "en-US,en;q=0.9" },
    referer: url,
  });
  return {
    url: data.url,
    referer: `${origin}/`,
    playlist_key: data.playlist_key,
    unwrap: /hd-?2/i.test(String(name ?? "")) ? "flixcloud-hd2" : "",
    audio: audio === "dub" ? "dub" : "",
    subtitles: data.subtitles,
    intro: data.intro_chapter,
    outro: data.outro_chapter,
  };
}

async function malId(id) {
  const map = await json(`${API}/map/${id}`, "map");
  const mapping = map?.mappings || map;
  const parsed = Number(mapping?.malId ?? mapping?.mal_id ?? mapping?.malID);
  if (Number.isFinite(parsed)) return parsed;
  const episodes = await json(`${API}/episodes/reanime/${id}`, "episodes mapping");
  const fallback = Number(episodes?.meta?.malId ?? episodes?.meta?.mal_id ?? episodes?.meta?.malID);
  return Number.isFinite(fallback) ? fallback : null;
}

async function skipTimes(id, episode) {
  if (!id) return { exist: false };
  const data = await json(
    `${ANISKIP}/skip-times/${id}/${episode}?types[]=op&types[]=ed&episodeLength=0`,
    "aniskip",
  );
  const skip = { exist: false };
  for (const item of data?.found && Array.isArray(data.results) ? data.results : []) {
    const { startTime: start, endTime: end } = item.interval || {};
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (item.skipType === "op") skip.intro = `${Math.round(start)},${Math.round(end)}`;
    if (item.skipType === "ed") skip.outro = `${Math.round(start)},${Math.round(end)}`;
  }
  skip.exist = Boolean(skip.intro || skip.outro);
  return skip;
}

function episodeRecord(episodes, episode) {
  if (Array.isArray(episodes)) {
    return (
      episodes.find((item) => Number(item?.episode ?? item?.number ?? item?.id) === episode) || null
    );
  }
  if (episodes && typeof episodes === "object") {
    return episodes[String(episode)] ?? episodes[episode] ?? null;
  }
  return null;
}

function metadataValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    for (const key of ["en", "english", "eng"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    for (const key of ["romaji", "native", "title", "name"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return "";
}

async function episodeMetadata(anilistId, episode) {
  const data = await json(`${ANIZIP}?anilist_id=${anilistId}`, "ani.zip mappings");
  const record = episodeRecord(data?.episodes, episode);
  return {
    title: metadataValue(record?.title ?? record?.name) || `Episode ${episode}`,
    thumbnail: metadataValue(record?.thumbnail ?? record?.image ?? record?.thumb),
  };
}

function add(bucket, name, url, seenUrls) {
  if (seenUrls.has(url)) return false;
  seenUrls.add(url);
  let key = name,
    suffix = 2;
  while (key in bucket) key = `${name} · ${suffix++}`;
  bucket[key] = url;
  return true;
}

function sourceName(provider, stream, type, url) {
  const providerName = PROVIDER_NAMES[provider] || provider;
  const details = [providerName];
  if (stream.server) details.push(String(stream.server));
  if (type === "HLS" && stream.quality) details.push(String(stream.quality));
  else if (type === "Embed") details.push(hostname(url));
  return details.join(" · ");
}

async function aggregate(id, episode, auto, proxyBase) {
  const [mappedId, metadata, flixRaw] = await Promise.all([
    malId(id),
    episodeMetadata(id, episode),
    watchFlix(id, episode),
  ]);
  const mal = metadata.malId ?? mappedId;
  const skip = await skipTimes(mal, episode);
  const results = await Promise.all(
    PROVIDERS.map(async (provider) =>
      [
        provider,
        await Promise.all([watch(provider, id, episode, "sub"), watch(provider, id, episode, "dub")]),
      ]
    ),
  );
  const vSub = formatUrls(VIDEO_SERVERS, id, mal, episode, "sub");
  const vDub = formatUrls(VIDEO_SERVERS, id, mal, episode, "dub");
  const servers = { "h-sub": {}, "s-sub": {}, dub: {}, "e-sub": {}, "e-dub": {}, "v-sub": vSub, "v-dub": vDub };
  const downloads = [],
    seen = new Set(),
    seenUrls = new Set(),
    providers = {};
  
  const flix = parseFlixServers(flixRaw);
  let flixCount = 0;
  const flixJobs = [
    ...flix.sub.map((server) => ({ ...server, audio: "sub" })),
    ...flix.dub.map((server) => ({ ...server, audio: "dub" })),
  ];
  const flixResolved = await Promise.all(
    flixJobs.map(async (server) => {
      try {
        return await resolveFlixServer(server);
      } catch (error) {
        console.error(`[flix:${server.name ?? hostname(server.url)}] ${error.message}`);
        return null;
      }
    }),
  );
  flixJobs.forEach(({ url, name, audio }, index) => {
    const label = `Flix · ${name ?? hostname(url)}`;
    const stream = flixResolved[index];
    const isDub = audio === "dub";
    // Direct FlixCloud embed: always listed in e-sub / e-dub.
    if (add(servers[isDub ? "e-dub" : "e-sub"], label, url, new Set())) flixCount++;
    // Resolved m3u8: s-sub for sub, dub for dub, played through the bundled proxy.
    if (stream) {
      const tracks = subtitles(stream);
      if (
        add(
          servers[isDub ? "dub" : "s-sub"],
          label,
          playerLink(stream, tracks, streamSkip(stream, skip), auto, metadata, proxyBase),
          seenUrls,
        )
      )
        flixCount++;
    }
  });
  providers["flix"] = flixRaw ? (flixCount ? "ok" : "empty") : "down";
  
  for (const [provider, [subWatch, dubWatch]] of results) {
    if (!subWatch && !dubWatch) {
      providers[provider] = "down";
      continue;
    }
    let count = 0;
    for (const [data, audio] of [
      [subWatch, "sub"],
      [dubWatch, "dub"],
    ]) {
      for (const stream of data?.streams || data?.sources || []) {
        if (!stream?.url || typeof stream.url !== "string") continue;
        if (isEmbed(stream)) {
          add(
            servers[audio === "dub" ? "e-dub" : "e-sub"],
            sourceName(provider, stream, "Embed", stream.url),
            stream.url,
            seenUrls,
          );
        } else {
          const tracks = subtitles(stream);
          add(
            servers[audio === "dub" ? "dub" : tracks.length ? "s-sub" : "h-sub"],
            sourceName(provider, stream, "HLS", stream.url),
            playerLink(stream, tracks, streamSkip(stream, skip), auto, metadata, proxyBase),
            seenUrls,
          );
        }
        count++;
        const companion = embedOf(stream);
        if (companion) {
          add(
            servers[audio === "dub" ? "e-dub" : "e-sub"],
            sourceName(provider, stream, "Embed", companion),
            companion,
            seenUrls,
          );
          count++;
        }
        if (typeof stream.backup === "string" && stream.backup) {
          add(
            servers[audio === "dub" ? "e-dub" : "e-sub"],
            sourceName(provider, stream, "Embed", stream.backup),
            stream.backup,
            seenUrls,
          );
          count++;
        }
      }
      for (const item of data?.downloads || [])
        if (item?.url && !seen.has(item.url)) {
          seen.add(item.url);
          downloads.push({
            server: `${item.server?.trim() || hostname(item.url)} · ${provider}`,
            label: item.label || "Download",
            url: item.url,
          });
        }
    }
    providers[provider] = count ? "ok" : "empty";
  }

  return {
    anilistId: id,
    malId: mappedId,
    episode,
    title: metadata.title,
    player: PLAYER,
    skip,
    servers: Object.fromEntries(
      Object.entries(servers).filter(([, sources]) => Object.keys(sources).length),
    ),
    downloads,
    providers,
  };
}

function send(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1000",
      ...CORS,
    },
  });
}

const isProxyPath = (pathname) =>
  pathname === "/proxy" || pathname === "/health" || pathname.startsWith("/proxy/") || pathname.startsWith("/p/");

export default {
  async fetch(request, env) {
    API = String(env.ANIVEXA_API_URL || "https://hat.anikage.workers.dev").replace(/\/+$/, "");
    HAT = env.HAT || null;
    STREAM_PROXY_OVERRIDE = env.STREAM_PROXY_URL ? String(env.STREAM_PROXY_URL).replace(/\/+$/, "") + "/" : null;

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Bundled stream proxy. Routes are open; set PROXY_TOKEN / ALLOWED_HOSTS / ALLOWED_ORIGINS to restrict.
    if (isProxyPath(pathname)) return handleProxyRequest(request, env);

    // Temporary diagnostic: /_debug shows exactly what the Worker gets back from the upstream API.
    const flixDbg = pathname.match(/^\/_flix\/(\d+)\/(\d+)$/);
    if (flixDbg) {
      const raw = await watchFlix(Number(flixDbg[1]), Number(flixDbg[2]));
      return new Response(JSON.stringify({ parsed: parseFlixServers(raw), raw }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (pathname === "/_debug") {
      const target = `${API}/map/21`;
      const r = await callApi(target, { headers: UPSTREAM_HEADERS }).catch((e) => ({ error: String(e) }));
      const out = r.error
        ? r
        : {
            target,
            status: r.status,
            headers: Object.fromEntries(r.headers),
            body: (await r.text()).slice(0, 500),
          };
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && pathname === "/favicon.ico") return new Response(null, { status: 204 });

    const match = pathname.match(/^(?:\/api\/public\/watch)?\/(\d+)\/(\d+)\/?$/);
    if (request.method !== "GET" || !match) {
      return send(404, {
        error: "Use GET /:anilistId/:episode or /api/public/watch/:anilistId/:episode",
      });
    }

    const id = Number(match[1]),
      episode = Number(match[2]);
    if (id < 1 || episode < 1) {
      return send(400, { error: "anilistId and episode must be positive integers" });
    }

    try {
      const data = await aggregate(
        id,
        episode,
        {
          ski: bool(url.searchParams.get("ski"), false),
          sko: bool(url.searchParams.get("sko"), false),
          autoplay: bool(url.searchParams.get("ap"), true),
        },
        proxyBaseOf(request),
      );
      return send(200, data);
    } catch (error) {
      console.error(error);
      return send(502, { error: "Upstream request failed" });
    }
  },
};