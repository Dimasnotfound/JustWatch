import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 1_500_000;
const MAX_JSON_BYTES = 500_000;
const MAX_SCRIPT_BYTES = 650_000;
const MAX_SCRIPT_TOTAL_BYTES = 1_500_000;
const MAX_SAME_ORIGIN_SCRIPTS = 4;
const MAX_DYNAMIC_API_ENDPOINTS = 4;
const MAX_DYNAMIC_API_REQUESTS = 6;
const REQUEST_TIMEOUT_MS = 12_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const DYNAMIC_API_PATH_PATTERN = /(?:^|[\/_-])(?:stream(?:ing)?|sources?|playback|manifest|playlist|get[-_]?(?:media|video|file)|load[-_]?(?:media|video|file)|fetch[-_]?(?:media|video|file)|(?:media|video|file)[-_]?(?:info|source|stream|url)|player[\/_-]?(?:config|source|stream))(?:[\/_.-]|$)/i;
const DYNAMIC_API_CONTEXT_PATTERN = /(?:^|\/)(?:api|ajax|embed|player)(?:\/|$)/i;
const BLOCKED_DYNAMIC_API_PATH_PATTERN = /(?:error|heartbeat|count|analytics|track|report|log|advert|vast|click|impression|subtitle|caption|delete|remove|create|update|upload|save|write|edit|purchase|payment|checkout|subscribe|follow|like|comment|vote|message|send)/i;
const DYNAMIC_ID_FIELD_PATTERN = /^(?:file_?code|file_?id|video_?id|media_?id|id|slug|code|key)$/i;
const DYNAMIC_DEVICE_FIELD_PATTERN = /^(?:device|platform|client|player_type|app)$/i;
const DYNAMIC_URL_FIELD_PATTERN = /^(?:url|page_?url|webpage_?url|referer|referrer)$/i;
const BLOCKED_DYNAMIC_FIELD_PATTERN = /(?:token|signature|secret|password|cookie|authorization|captcha|drm|license)/i;
const MEDIA_EXTENSIONS = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
  [".ogg", "video/ogg"],
  [".m3u8", "application/vnd.apple.mpegurl"],
  [".mpd", "application/dash+xml"]
]);

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeCandidate(value, baseUrl) {
  if (!value || typeof value !== "string") return null;

  const cleaned = decodeEntities(value.trim().replace(/^['"]|['"]$/g, ""));
  if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("blob:")) return null;

  try {
    const url = new URL(cleaned, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function guessMime(urlValue, declaredType = "") {
  if (declaredType) return declaredType.split(";")[0].trim().toLowerCase();

  try {
    const pathname = new URL(urlValue).pathname.toLowerCase();
    for (const [extension, mime] of MEDIA_EXTENSIONS) {
      if (pathname.endsWith(extension)) return mime;
    }
  } catch {
    return "";
  }

  return "";
}

function sourceKind(mimeType, urlValue) {
  const value = `${mimeType} ${urlValue}`.toLowerCase();
  if (value.includes("mpegurl") || value.includes(".m3u8")) return "hls";
  if (value.includes("dash+xml") || value.includes(".mpd")) return "dash";
  return "file";
}

function parseYouTubeStart(value) {
  if (!value) return 0;
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);

  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

export function extractYouTubeEmbedSource(inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let videoId = "";

  if (hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(hostname)) {
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    const segments = pathname.split("/").filter(Boolean);
    if (pathname === "/watch") {
      videoId = parsed.searchParams.get("v") || "";
    } else if (["shorts", "embed", "live"].includes(segments[0])) {
      videoId = segments[1] || "";
    }
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
  embedUrl.searchParams.set("playsinline", "1");
  embedUrl.searchParams.set("rel", "0");

  const start = parseYouTubeStart(parsed.searchParams.get("start") || parsed.searchParams.get("t"));
  if (Number.isSafeInteger(start) && start > 0) embedUrl.searchParams.set("start", String(start));

  return {
    videoId,
    canonicalUrl,
    source: {
      url: embedUrl.href,
      openUrl: canonicalUrl,
      mimeType: "text/html",
      kind: "embed",
      origin: "youtube-iframe",
      label: "YouTube player",
      hasVideo: true,
      hasAudio: true
    }
  };
}

function isVidSonicHost(urlValue) {
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase();
    return hostname === "vidsonic.net" || hostname.endsWith(".vidsonic.net");
  } catch {
    return false;
  }
}

function decodeReverseHex(value) {
  const clean = value.replaceAll("|", "");
  if (clean.length < 80 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    return "";
  }

  let decoded = "";
  for (let index = 0; index < clean.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(clean.slice(index, index + 2), 16));
  }

  return decoded.split("").reverse().join("");
}

export function extractVidSonicCandidates(html, baseUrl) {
  if (!isVidSonicHost(baseUrl)) return [];

  const candidates = [];
  const assignmentPattern = /(?:const|let|var)\s+[$\w]+\s*=\s*(["'])([0-9a-f|]{80,})\1\s*;/gi;

  for (const match of html.matchAll(assignmentPattern)) {
    const decoded = decodeReverseHex(match[2]);
    const normalized = normalizeCandidate(decoded, baseUrl);
    if (!normalized || !isVidSonicHost(normalized)) continue;

    const mimeType = guessMime(normalized);
    const kind = sourceKind(mimeType, normalized);
    if (!mimeType || !["hls", "dash", "file"].includes(kind)) continue;

    const parsed = new URL(normalized);
    const expiresValue = parsed.searchParams.get("expires");
    const expiresSeconds = expiresValue && /^\d+$/.test(expiresValue) ? Number(expiresValue) : 0;
    const expiresAt = Number.isSafeInteger(expiresSeconds) && expiresSeconds > 0
      ? new Date(expiresSeconds * 1000).toISOString()
      : null;

    if (!candidates.some((item) => item.url === normalized)) {
      candidates.push({
        url: normalized,
        mimeType,
        kind,
        origin: "vidsonic-player",
        ...(expiresAt ? { expiresAt } : {})
      });
    }
  }

  return candidates;
}

export function isPrivateOrReservedIP(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }

  return true;
}

export async function validatePublicUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("URL tidak valid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Hanya URL HTTP atau HTTPS yang didukung.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL dengan kredensial tidak diizinkan.");
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new Error("Port URL tidak diizinkan.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Alamat lokal atau privat tidak diizinkan.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIP(hostname)) {
      throw new Error("Alamat lokal atau privat tidak diizinkan.");
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Nama domain tidak dapat ditemukan.");
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIP(address))) {
    throw new Error("Domain mengarah ke alamat lokal atau privat.");
  }

  return parsed;
}

async function safeFetch(initialUrl, options = {}) {
  let currentUrl = initialUrl;
  let method = String(options.method || "GET").toUpperCase();
  let body = options.body;
  const allowedOrigin = options.allowedOrigin || "";
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const parsed = await validatePublicUrl(currentUrl);
    if (allowedOrigin && parsed.origin !== allowedOrigin) {
      throw new Error("Endpoint dinamis harus tetap berada pada origin halaman yang sama.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = {
      Accept: "text/html,application/xhtml+xml,video/*,application/vnd.apple.mpegurl,application/dash+xml;q=0.9,*/*;q=0.1",
      "Accept-Language": "id,en;q=0.8",
      "User-Agent": "JustWatchCleanPlayer/1.0 (+public-media-resolver)",
      ...options.headers
    };
    if (method === "GET" && options.range !== false && !Object.hasOwn(headers, "Range")) {
      headers.Range = "bytes=0-1499999";
    }

    let response;
    try {
      response = await fetch(currentUrl, {
        method,
        body,
        redirect: "manual",
        signal: controller.signal,
        headers
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Sumber terlalu lama merespons.");
      throw new Error("Sumber tidak dapat dihubungi.");
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect sumber tidak memiliki tujuan.");
      const nextUrl = new URL(location, currentUrl);
      if (allowedOrigin && nextUrl.origin !== allowedOrigin) {
        throw new Error("Redirect endpoint dinamis keluar dari origin halaman.");
      }
      currentUrl = nextUrl.href;
      if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`Sumber menolak permintaan dengan status ${response.status}.`);
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error("Terlalu banyak redirect.");
}

async function readTextWithLimit(response, maxBytes = MAX_HTML_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return "";
}

export function extractMediaCandidates(html, baseUrl) {
  const candidates = [];
  const add = (rawUrl, declaredType = "", origin = "page") => {
    const url = normalizeCandidate(rawUrl, baseUrl);
    if (!url) return;

    const mimeType = guessMime(url, declaredType);
    const kind = sourceKind(mimeType, url);
    if (!mimeType && kind === "file") return;

    if (!candidates.some((item) => item.url === url)) {
      candidates.push({
        url,
        mimeType,
        kind,
        origin
      });
    }
  };

  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:video(?::url|:secure_url)?["'][^>]*>/gi,
    /<meta[^>]+(?:property|name)=["']twitter:player:stream["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:player:stream["'][^>]*>/gi
  ];

  for (const pattern of metaPatterns) {
    for (const match of html.matchAll(pattern)) add(match[1], "", "metadata");
  }

  for (const match of html.matchAll(/<(?:video|source)\b([^>]*)>/gi)) {
    const attributes = match[1];
    const src = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const type = attributes.match(/\btype=["']([^"']+)["']/i)?.[1] || "";
    add(src, type, "html5");
  }

  for (const match of html.matchAll(/["']contentUrl["']\s*:\s*["']([^"']+)["']/gi)) {
    add(match[1].replaceAll("\\/", "/"), "", "structured-data");
  }

  return candidates;
}

export function extractSameOriginScriptUrls(html, baseUrl) {
  let page;
  try {
    page = new URL(baseUrl);
  } catch {
    return [];
  }

  const scripts = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const normalized = normalizeCandidate(match[1], baseUrl);
    if (!normalized) continue;
    const scriptUrl = new URL(normalized);
    if (scriptUrl.origin !== page.origin) continue;
    if (/(?:analytics|advert|ads?|gtag|captcha|challenge|pixel|tracker|telemetry)/i.test(scriptUrl.pathname)) continue;
    if (!scripts.includes(scriptUrl.href)) scripts.push(scriptUrl.href);
    if (scripts.length >= MAX_SAME_ORIGIN_SCRIPTS) break;
  }
  return scripts;
}

export function extractScriptMediaCandidates(scriptText, baseUrl) {
  const candidates = [];
  const add = (rawValue, declaredType = "") => {
    if (!rawValue || typeof rawValue !== "string") return;
    if (rawValue.includes("${") || /(?:^|[^\\])\+[A-Za-z_$]/.test(rawValue)) return;
    const decoded = rawValue
      .replaceAll("\\/", "/")
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\x2[fF]/g, "/");
    const url = normalizeCandidate(decoded, baseUrl);
    if (!url) return;

    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }
    if (/(?:thumbnail|poster|image|avatar|subtitle|caption|advert|vast|logo|preview)/i.test(pathname)) return;

    const mimeType = guessMime(url, declaredType);
    const retrievalPath = DYNAMIC_API_PATH_PATTERN.test(pathname);
    if (!mimeType && !retrievalPath) return;
    if (!candidates.some((item) => item.url === url)) {
      candidates.push({
        url,
        mimeType,
        kind: sourceKind(mimeType, url),
        origin: "player-script",
        needsProbe: !mimeType
      });
    }
  };

  const propertyPattern = /(?:file|src|source|stream(?:ing)?_?url|manifest_?url|playlist_?url|hls_?url|dash_?url|video_?url|media_?url)\s*[:=]\s*(["'`])([^"'`]{3,8192})\1/gi;
  for (const match of scriptText.matchAll(propertyPattern)) add(match[2]);

  const quotedUrlPattern = /(["'`])((?:https?:)?\/\/[^"'`<>\s]{4,8192}|\/(?:get[-_]?video|api\/(?:stream|source|manifest|playback)|ajax\/(?:get[-_]?(?:video|media|file)|stream))[^"'`<>\s]{0,8000})\1/gi;
  for (const match of scriptText.matchAll(quotedUrlPattern)) add(match[2]);

  return candidates.slice(0, 30);
}

async function loadSameOriginScripts(html, pageUrl, sessionCookie) {
  const page = new URL(pageUrl);
  const scriptUrls = extractSameOriginScriptUrls(html, pageUrl);
  const fetchedScripts = await Promise.all(scriptUrls.map(async (scriptUrl) => {
    try {
      const headers = {
        Accept: "application/javascript,text/javascript,application/ecmascript,text/plain;q=0.9,*/*;q=0.1",
        Referer: pageUrl
      };
      if (sessionCookie) headers.Cookie = sessionCookie;
      const fetched = await safeFetch(scriptUrl, {
        headers,
        range: false,
        allowedOrigin: page.origin,
        maxRedirects: 2
      });
      const contentType = (fetched.response.headers.get("content-type") || "").toLowerCase();
      if (
        contentType &&
        !contentType.includes("javascript") &&
        !contentType.includes("ecmascript") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("application/octet-stream")
      ) {
        return "";
      }
      return await readTextWithLimit(fetched.response, MAX_SCRIPT_BYTES);
    } catch {
      return "";
    }
  }));

  const scripts = [];
  let totalBytes = 0;
  for (const text of fetchedScripts) {
    if (!text) continue;
    const bytes = Buffer.byteLength(text);
    if (totalBytes + bytes > MAX_SCRIPT_TOTAL_BYTES) break;
    totalBytes += bytes;
    scripts.push(text);
  }
  return scripts.join("\n");
}

export function extractVideyCandidates(pageUrl, scriptText = "") {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  if (page.hostname !== "videy.co" && !page.hostname.endsWith(".videy.co")) return [];
  if (scriptText && !scriptText.includes("cdn.videy.co")) return [];

  const id = (page.searchParams.get("id") || "").trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return [];
  const extension = id.length === 9 && id.endsWith("2") ? "mov" : "mp4";
  const url = `https://cdn.videy.co/${id}.${extension}`;
  const mimeType = guessMime(url);
  return [{
    url,
    mimeType,
    kind: sourceKind(mimeType, url),
    origin: "videy-public-cdn"
  }];
}

export function extractDoodStyleDescriptor(html, pageUrl) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  const passPath = html.match(/(["'])(\/pass_md5\/[^"']{4,1200})\1/i)?.[2];
  const token = html.match(/[?&]token=([A-Za-z0-9_-]{4,512})(?:[&"'])/i)?.[1];
  if (!passPath || !token) return null;

  const endpoint = new URL(passPath.replaceAll("\\/", "/"), pageUrl);
  if (endpoint.origin !== page.origin) return null;
  return { endpoint: endpoint.href, token };
}

async function resolveDoodStyleSource(html, pageUrl, responseHeaders) {
  const descriptor = extractDoodStyleDescriptor(html, pageUrl);
  if (!descriptor) return null;

  const page = new URL(pageUrl);
  const endpoint = new URL(descriptor.endpoint);
  const token = descriptor.token;
  const sessionCookie = extractSessionCookie(responseHeaders);
  const headers = {
    Accept: "text/plain,*/*;q=0.1",
    Referer: pageUrl
  };
  if (sessionCookie) headers.Cookie = sessionCookie;

  try {
    const response = await safeFetch(endpoint.href, {
      headers,
      range: false,
      allowedOrigin: page.origin,
      maxRedirects: 1
    });
    const base = (await readTextWithLimit(response.response, 8192)).trim();
    const normalizedBase = normalizeCandidate(base, response.finalUrl);
    if (!normalizedBase) return null;
    const suffix = crypto.randomBytes(8).toString("base64url").slice(0, 10);
    const separator = normalizedBase.includes("?") ? "&" : "?";
    const url = `${normalizedBase}${suffix}${separator}token=${encodeURIComponent(token)}&expiry=${Date.now()}`;
    await validatePublicUrl(url);
    return {
      sources: [{
        url,
        mimeType: "video/mp4",
        kind: "file",
        origin: "dood-style-player",
        httpHeaders: { Referer: pageUrl }
      }],
      provider: "dood-style-player"
    };
  } catch {
    return null;
  }
}

function parseSafeLiteral(expression) {
  const value = String(expression || "").trim();
  if (!value) return { hasLiteral: false };

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    return {
      hasLiteral: true,
      value: value.slice(1, -1).replace(/\\([\\'"/])/g, "$1")
    };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return { hasLiteral: true, value: Number(value) };
  }
  if (/^(?:true|false)$/i.test(value)) {
    return { hasLiteral: true, value: value.toLowerCase() === "true" };
  }
  if (/^null$/i.test(value)) {
    return { hasLiteral: true, value: null };
  }
  return { hasLiteral: false };
}

function extractDynamicBodyFields(snippet) {
  const patterns = [
    /JSON\.stringify\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/i,
    /new\s+URLSearchParams\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/i,
    /(?:body|data)\s*:\s*\{([\s\S]{0,1200}?)\}/i
  ];
  const objectBody = patterns.map((pattern) => snippet.match(pattern)?.[1]).find(Boolean);
  if (!objectBody) return [];

  const fields = [];
  const propertyPattern = /(?:^|,)\s*(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))\s*(?::\s*([^,]+))?/g;
  for (const match of objectBody.matchAll(propertyPattern)) {
    const name = match[2] || match[3] || "";
    if (!name || fields.some((field) => field.name === name)) continue;
    const expression = match[4] === undefined ? name : match[4];
    fields.push({
      name,
      expression: String(expression).trim(),
      ...parseSafeLiteral(expression)
    });
  }
  return fields.slice(0, 12);
}

export function extractDynamicApiDescriptors(html, baseUrl) {
  let pageUrl;
  try {
    pageUrl = new URL(baseUrl);
  } catch {
    return [];
  }

  const descriptors = [];
  const endpointPattern = /(["'`])((?:https?:\/\/|\/)[^"'`<>\s\\]{1,300})\1/g;
  for (const match of html.matchAll(endpointPattern)) {
    const rawEndpoint = match[2].replaceAll("\\/", "/");
    const normalized = normalizeCandidate(rawEndpoint, baseUrl);
    if (!normalized) continue;

    const endpoint = new URL(normalized);
    const pathname = endpoint.pathname.toLowerCase();
    if (endpoint.origin !== pageUrl.origin) continue;
    if (!DYNAMIC_API_PATH_PATTERN.test(pathname)) continue;
    if (
      !DYNAMIC_API_CONTEXT_PATTERN.test(pathname) &&
      !/\/(?:get|load|fetch)[-_]?(?:stream|media|source|video|file)/i.test(pathname)
    ) {
      continue;
    }
    if (BLOCKED_DYNAMIC_API_PATH_PATTERN.test(pathname)) continue;

    const snippetStart = Math.max(0, match.index - 200);
    const snippet = html.slice(snippetStart, match.index + 3500);
    if (!/(?:fetch\s*\(|\$\.(?:ajax|post|get)\s*\(|XMLHttpRequest)/i.test(snippet)) continue;

    const fields = extractDynamicBodyFields(snippet);
    const explicitMethod = snippet.match(/method\s*:\s*["'](GET|POST)["']/i)?.[1]?.toUpperCase();
    const method = explicitMethod || (/\$\.post\s*\(/i.test(snippet) || fields.length ? "POST" : "GET");
    const preserveQuery = /(?:window\.)?location\.search|URLSearchParams\s*\(\s*(?:window\.)?location\.search/i.test(snippet);
    const key = `${method} ${endpoint.href} ${fields.map((field) => field.name).join(",")}`;
    if (descriptors.some((item) => item.key === key)) continue;

    descriptors.push({
      key,
      url: endpoint.href,
      method,
      preserveQuery,
      fields
    });
    if (descriptors.length >= MAX_DYNAMIC_API_ENDPOINTS) break;
  }

  return descriptors.map(({ key, ...descriptor }) => descriptor);
}

function looksLikeUrlCandidate(value) {
  const text = String(value || "").trim().replaceAll("\\/", "/");
  if (!text || text.length > 8192) return false;
  if (/^(?:https?:)?\/\//i.test(text) || /^(?:\.\.?\/|\/)/.test(text)) return true;
  return /\.(?:mp4|webm|ogv|ogg|m3u8|mpd)(?:[?#]|$)/i.test(text);
}

export function extractMediaCandidatesFromJson(value, baseUrl) {
  const sources = [];
  let title = "";
  let thumbnail = "";

  const add = (rawValue, path, declaredType = "") => {
    if (!looksLikeUrlCandidate(rawValue)) return;
    const pathText = path.join(".").toLowerCase();
    if (/(?:thumbnail|poster|image|avatar|subtitle|caption|track|advert|vast|logo|preview)/i.test(pathText)) {
      return;
    }

    const url = normalizeCandidate(String(rawValue).replaceAll("\\/", "/"), baseUrl);
    if (!url) return;
    const mimeType = guessMime(url, declaredType);
    const stronglyMediaRelated = /(?:^|\.)(?:stream(?:ing)?_?url|manifest(?:_url)?|playlist(?:_url)?|sources?|hls(?:_url)?|dash(?:_url)?|video(?:_url)?|media(?:_url)?|file|src)(?:$|\.)/i.test(pathText);
    if (!mimeType && !stronglyMediaRelated) return;

    if (!sources.some((source) => source.url === url)) {
      sources.push({
        url,
        mimeType,
        kind: sourceKind(mimeType, url),
        origin: "dynamic-api",
        needsProbe: !mimeType
      });
    }
  };

  const walk = (node, path = [], depth = 0, inheritedType = "") => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === "string") {
      add(node, path, inheritedType);
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((item, index) => walk(item, [...path, String(index)], depth + 1, inheritedType));
      return;
    }
    if (typeof node !== "object") return;

    const declaredType = typeof node.mimeType === "string"
      ? node.mimeType
      : typeof node.mime_type === "string"
        ? node.mime_type
        : typeof node.type === "string" && node.type.includes("/")
          ? node.type
          : inheritedType;

    for (const [key, item] of Object.entries(node)) {
      const nextPath = [...path, key];
      if (!title && typeof item === "string" && /^(?:title|video_?title|media_?title)$/i.test(key)) {
        title = item.trim().slice(0, 500);
      }
      if (!thumbnail && typeof item === "string" && /^(?:thumbnail|poster|image|image_?url)$/i.test(key)) {
        const candidate = normalizeCandidate(item, baseUrl);
        if (candidate) thumbnail = candidate;
      }
      walk(item, nextPath, depth + 1, declaredType);
    }
  };

  walk(value);
  return { sources, title, thumbnail };
}

function extractSessionCookie(headers) {
  let values = [];
  if (typeof headers.getSetCookie === "function") {
    values = headers.getSetCookie();
  } else {
    const raw = headers.get("set-cookie") || "";
    if (raw) values = raw.split(/,(?=[^;,\s]+=)/);
  }

  const pairs = values
    .map((value) => String(value).split(";", 1)[0].trim())
    .filter((value) => /^[^=;\s]+=[^;\r\n]*$/.test(value))
    .slice(0, 8);
  const cookie = pairs.join("; ");
  return cookie.length <= 4096 ? cookie : "";
}

function pageIdentifier(pageUrl) {
  try {
    const segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
    const value = decodeURIComponent(segments.at(-1) || "").trim();
    return value.length <= 512 ? value : "";
  } catch {
    return "";
  }
}

function buildDynamicPayload(descriptor, pageUrl) {
  const identifier = pageIdentifier(pageUrl);
  const payload = {};

  for (const field of descriptor.fields) {
    const name = field.name;
    if (!name || BLOCKED_DYNAMIC_FIELD_PATTERN.test(name)) continue;

    let value;
    if (field.hasLiteral) {
      value = field.value;
    } else if (DYNAMIC_ID_FIELD_PATTERN.test(name)) {
      value = identifier;
    } else if (DYNAMIC_DEVICE_FIELD_PATTERN.test(name)) {
      value = "web";
    } else if (DYNAMIC_URL_FIELD_PATTERN.test(name)) {
      value = pageUrl;
    } else {
      continue;
    }

    if (typeof value === "string" && (!value || value.length > 4096)) continue;
    payload[name] = value;
  }

  return payload;
}

function containsProtectedAccessSignal(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => containsProtectedAccessSignal(item, depth + 1));
  if (typeof value !== "object") return false;

  for (const [key, item] of Object.entries(value)) {
    if (/(?:drm|widevine|playready|fairplay|license_?url|requires?_?login|login_?required|captcha_?required)/i.test(key) && item) {
      return true;
    }
    if (
      /^(?:error|message|status)$/i.test(key) &&
      typeof item === "string" &&
      /(?:login required|sign in required|captcha|drm|widevine|playready|fairplay)/i.test(item)
    ) {
      return true;
    }
    if (containsProtectedAccessSignal(item, depth + 1)) return true;
  }
  return false;
}

async function finalizeDynamicSources(candidates, pageUrl, sessionCookie) {
  const sources = [];
  const pageOrigin = new URL(pageUrl).origin;

  for (const candidate of candidates.slice(0, 20)) {
    try {
      const parsed = await validatePublicUrl(candidate.url);
      let source = { ...candidate };

      if (candidate.needsProbe) {
        const headers = {
          Accept: "video/*,application/vnd.apple.mpegurl,application/dash+xml,*/*;q=0.1",
          Referer: pageUrl
        };
        if (sessionCookie && parsed.origin === pageOrigin) headers.Cookie = sessionCookie;
        const probe = await safeFetch(parsed.href, {
          headers,
          maxRedirects: 2
        });
        const contentType = probe.response.headers.get("content-type") || "";
        const mimeType = directMediaType(contentType, probe.finalUrl);
        if (!mimeType) continue;
        source = {
          ...source,
          url: probe.finalUrl,
          mimeType,
          kind: sourceKind(mimeType, probe.finalUrl)
        };
      }

      delete source.needsProbe;
      if (!sources.some((item) => item.url === source.url)) sources.push(source);
    } catch {
      // Ignore dynamic candidates that are private, invalid, expired, or not media.
    }
  }

  return sources;
}

async function resolveDynamicApiSources(html, finalUrl, responseHeaders) {
  const descriptors = extractDynamicApiDescriptors(html, finalUrl);
  if (!descriptors.length) return null;

  const page = new URL(finalUrl);
  const sessionCookie = extractSessionCookie(responseHeaders);
  let requests = 0;

  for (const descriptor of descriptors) {
    if (requests >= MAX_DYNAMIC_API_REQUESTS) break;
    const payload = buildDynamicPayload(descriptor, finalUrl);
    if (descriptor.method === "POST" && !Object.keys(payload).length) continue;

    const endpoint = new URL(descriptor.url);
    if (descriptor.preserveQuery && !endpoint.search && page.search) {
      endpoint.search = page.search;
    }
    if (descriptor.method === "GET") {
      for (const [key, value] of Object.entries(payload)) endpoint.searchParams.set(key, String(value));
    }

    const requestBody = descriptor.method === "POST" ? JSON.stringify(payload) : undefined;
    if (requestBody && requestBody.length > 8192) continue;
    requests += 1;

    try {
      const headers = {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
        Origin: page.origin,
        Referer: finalUrl
      };
      if (descriptor.method === "POST") headers["Content-Type"] = "application/json";
      if (sessionCookie) headers.Cookie = sessionCookie;

      const result = await safeFetch(endpoint.href, {
        method: descriptor.method,
        body: requestBody,
        headers,
        range: false,
        allowedOrigin: page.origin,
        maxRedirects: 2
      });
      const text = await readTextWithLimit(result.response, MAX_JSON_BYTES);
      let payloadJson;
      try {
        payloadJson = JSON.parse(text);
      } catch {
        continue;
      }
      if (containsProtectedAccessSignal(payloadJson)) continue;

      const extracted = extractMediaCandidatesFromJson(payloadJson, result.finalUrl);
      const sources = await finalizeDynamicSources(extracted.sources, finalUrl, sessionCookie);
      if (!sources.length) continue;

      return {
        sources,
        title: extracted.title,
        thumbnail: extracted.thumbnail,
        provider: "dynamic-player-api"
      };
    } catch {
      // Try the next safely detected same-origin endpoint.
    }
  }

  return null;
}

export function directMediaType(contentType, finalUrl) {
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (
    mimeType.startsWith("video/") ||
    mimeType === "application/vnd.apple.mpegurl" ||
    mimeType === "application/x-mpegurl" ||
    mimeType === "application/dash+xml"
  ) {
    return mimeType;
  }
  if (
    mimeType.includes("html") ||
    mimeType.includes("json") ||
    mimeType.includes("javascript") ||
    mimeType.includes("xml") ||
    mimeType.startsWith("text/")
  ) {
    return "";
  }
  return guessMime(finalUrl, "");
}

function pageMetadata(html, fallbackUrl) {
  const title = firstMatch(html, [
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]);

  let hostname = "";
  try {
    hostname = new URL(fallbackUrl).hostname;
  } catch {
    hostname = "Sumber video";
  }

  return {
    title: title.replace(/\s+/g, " ").trim() || hostname,
    sourceHost: hostname
  };
}

export async function resolveMedia(inputUrl) {
  const parsed = await validatePublicUrl(inputUrl);
  const youtube = extractYouTubeEmbedSource(parsed.href);
  if (youtube) {
    return {
      title: "YouTube video",
      pageUrl: parsed.href,
      finalUrl: youtube.canonicalUrl,
      sourceHost: "www.youtube.com",
      provider: "youtube-embed",
      id: youtube.videoId,
      sources: [youtube.source]
    };
  }

  const { response, finalUrl } = await safeFetch(parsed.href);
  const contentType = response.headers.get("content-type") || "";
  const mimeType = directMediaType(contentType, finalUrl);

  if (mimeType) {
    return {
      title: decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "Video"),
      pageUrl: parsed.href,
      finalUrl,
      sourceHost: new URL(finalUrl).hostname,
      sources: [{
        url: finalUrl,
        mimeType,
        kind: sourceKind(mimeType, finalUrl),
        origin: "direct"
      }]
    };
  }

  if (!contentType.toLowerCase().includes("text/html") && !contentType.toLowerCase().includes("application/xhtml+xml")) {
    throw new Error("URL tidak mengarah ke halaman HTML atau media video yang didukung.");
  }

  const html = await readTextWithLimit(response);
  const sessionCookie = extractSessionCookie(response.headers);
  const firstPartyScripts = await loadSameOriginScripts(html, finalUrl, sessionCookie);
  const playerText = `${html}\n${firstPartyScripts}`;
  const extractedSources = [
    ...extractVidSonicCandidates(playerText, finalUrl),
    ...extractMediaCandidates(html, finalUrl),
    ...extractScriptMediaCandidates(playerText, finalUrl),
    ...extractVideyCandidates(finalUrl, firstPartyScripts)
  ].filter((source, index, items) => items.findIndex((item) => item.url === source.url) === index);

  const sources = await finalizeDynamicSources(extractedSources, finalUrl, sessionCookie);

  let dynamicResult = null;
  if (!sources.length) {
    dynamicResult = await resolveDynamicApiSources(playerText, finalUrl, response.headers);
    if (dynamicResult?.sources?.length) sources.push(...dynamicResult.sources);
  }

  if (!sources.length) {
    dynamicResult = await resolveDoodStyleSource(playerText, finalUrl, response.headers);
    if (dynamicResult?.sources?.length) sources.push(...dynamicResult.sources);
  }

  if (!sources.length) {
    throw new Error("Sumber video publik tidak ditemukan pada halaman tersebut.");
  }

  const metadata = pageMetadata(html, finalUrl);
  return {
    ...metadata,
    ...(dynamicResult?.title ? { title: dynamicResult.title } : {}),
    ...(dynamicResult?.thumbnail ? { thumbnail: dynamicResult.thumbnail } : {}),
    ...(dynamicResult?.provider ? { provider: dynamicResult.provider } : {}),
    pageUrl: parsed.href,
    finalUrl,
    sources
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Gunakan metode POST." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { ok: false, error: "Body JSON tidak valid." });
    }
  }

  const inputUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!inputUrl || inputUrl.length > 4096) {
    return json(res, 400, { ok: false, error: "Masukkan URL yang valid." });
  }

  try {
    const result = await resolveMedia(inputUrl);
    return json(res, 200, { ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sumber tidak dapat diproses.";
    if (message === "Sumber video publik tidak ditemukan pada halaman tersebut.") {
      return json(res, 200, {
        ok: false,
        miss: true,
        error: message
      });
    }

    return json(res, 422, {
      ok: false,
      error: message
    });
  }
}
