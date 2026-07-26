import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const MEDIA_EXTENSIONS = new Map([
  [".mp4", "video/mp4"],
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

async function safeFetch(initialUrl) {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validatePublicUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,video/*,application/vnd.apple.mpegurl,application/dash+xml;q=0.9,*/*;q=0.1",
          "Accept-Language": "id,en;q=0.8",
          Range: "bytes=0-1499999",
          "User-Agent": "JustWatchCleanPlayer/1.0 (+public-media-resolver)"
        }
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
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`Sumber menolak permintaan dengan status ${response.status}.`);
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error("Terlalu banyak redirect.");
}

async function readTextWithLimit(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
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

function directMediaType(contentType, finalUrl) {
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (
    mimeType.startsWith("video/") ||
    mimeType === "application/vnd.apple.mpegurl" ||
    mimeType === "application/x-mpegurl" ||
    mimeType === "application/dash+xml"
  ) {
    return mimeType;
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
  const extractedSources = [
    ...extractVidSonicCandidates(html, finalUrl),
    ...extractMediaCandidates(html, finalUrl)
  ].filter((source, index, items) => items.findIndex((item) => item.url === source.url) === index);

  const sources = [];
  for (const source of extractedSources.slice(0, 20)) {
    try {
      await validatePublicUrl(source.url);
      sources.push(source);
    } catch {
      // Ignore media candidates that resolve to local, private, or invalid addresses.
    }
  }

  if (!sources.length) {
    throw new Error("Sumber video publik tidak ditemukan pada halaman tersebut.");
  }

  return {
    ...pageMetadata(html, finalUrl),
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
