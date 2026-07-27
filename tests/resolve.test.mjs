import test from "node:test";
import assert from "node:assert/strict";
import {
  directMediaType,
  extractDoodStyleDescriptor,
  extractDynamicApiDescriptors,
  extractMediaCandidates,
  extractMediaCandidatesFromJson,
  extractSameOriginScriptUrls,
  extractScriptMediaCandidates,
  extractVideyCandidates,
  extractVidSonicCandidates,
  isPrivateOrReservedIP
} from "../api/resolve.js";

test("blocks common private and reserved IP ranges", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.10.2",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1"
  ];

  for (const address of blocked) {
    assert.equal(isPrivateOrReservedIP(address), true, `${address} should be blocked`);
  }
});

test("allows representative public IP addresses", () => {
  assert.equal(isPrivateOrReservedIP("1.1.1.1"), false);
  assert.equal(isPrivateOrReservedIP("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIP("2606:4700:4700::1111"), false);
});

test("does not mistake an HTML page ending in a media extension for direct media", () => {
  assert.equal(
    directMediaType("text/html; charset=utf-8", "https://host.example/d/file/video.mp4"),
    ""
  );
  assert.equal(
    directMediaType("video/mp4", "https://cdn.example.com/content?id=123"),
    "video/mp4"
  );
  assert.equal(
    directMediaType("application/octet-stream", "https://cdn.example.com/video.mp4"),
    "video/mp4"
  );
});

test("extracts metadata, HTML5, relative, and structured media URLs", () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:video" content="https://cdn.example.com/hero.mp4?token=a&amp;b=2">
      </head>
      <body>
        <video src="/media/trailer.webm"></video>
        <video><source src="streams/master.m3u8" type="application/vnd.apple.mpegurl"></video>
        <script type="application/ld+json">
          {"contentUrl":"https:\\/\\/cdn.example.com\\/movie.ogv"}
        </script>
      </body>
    </html>
  `;

  const sources = extractMediaCandidates(html, "https://example.com/watch/123");
  assert.deepEqual(
    sources.map(({ url, kind }) => ({ url, kind })),
    [
      { url: "https://cdn.example.com/hero.mp4?token=a&b=2", kind: "file" },
      { url: "https://example.com/media/trailer.webm", kind: "file" },
      { url: "https://example.com/watch/streams/master.m3u8", kind: "hls" },
      { url: "https://cdn.example.com/movie.ogv", kind: "file" }
    ]
  );
});

test("deduplicates identical sources", () => {
  const html = `
    <meta property="og:video" content="https://cdn.example.com/video.mp4">
    <video src="https://cdn.example.com/video.mp4"></video>
  `;

  const sources = extractMediaCandidates(html, "https://example.com/page");
  assert.equal(sources.length, 1);
});

test("ignores embed URLs without a recognized media type", () => {
  const html = `
    <meta property="og:video" content="https://www.youtube.com/embed/example">
    <meta name="twitter:player:stream" content="https://player.example/embed/123">
  `;

  assert.deepEqual(extractMediaCandidates(html, "https://example.com/page"), []);
});

test("ignores data, blob, and non-http sources", () => {
  const html = `
    <video src="data:video/mp4;base64,AAAA"></video>
    <source src="blob:https://example.com/123">
    <source src="file:///private/video.mp4">
  `;

  assert.deepEqual(extractMediaCandidates(html, "https://example.com/page"), []);
});

test("decodes VidSonic reverse-hex HLS sources", () => {
  const directUrl = "https://st-us-01.vidsonic.net/secure/81/example/master.m3u8?server_id=2&expires=1893456000&file_id=example&md5=test";
  const reversedHex = Buffer.from(directUrl.split("").reverse().join(""), "utf8").toString("hex");
  const encoded = reversedHex.match(/.{1,10}/g).join("|");
  const html = `<script>const _0x1 = '${encoded}';</script>`;

  assert.deepEqual(
    extractVidSonicCandidates(html, "https://vidsonic.net/e/example"),
    [{
      url: directUrl,
      mimeType: "application/vnd.apple.mpegurl",
      kind: "hls",
      origin: "vidsonic-player",
      expiresAt: "2030-01-01T00:00:00.000Z"
    }]
  );
});

test("does not decode VidSonic-style data on unrelated domains", () => {
  const directUrl = "https://st-us-01.vidsonic.net/secure/81/example/master.m3u8";
  const reversedHex = Buffer.from(directUrl.split("").reverse().join(""), "utf8").toString("hex");
  const html = `<script>const sourceData = '${reversedHex}';</script>`;

  assert.deepEqual(extractVidSonicCandidates(html, "https://example.com/watch"), []);
});

test("detects a generic same-origin stream API and its public request fields", () => {
  const html = `
    <script>
      const params = new URLSearchParams(window.location.search);
      const apiURL = "/api/stream" + (params.toString() ? "?" + params : "");
      fetch(apiURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filecode: filecode, device: detectDevice() })
      });
    </script>
  `;

  const descriptors = extractDynamicApiDescriptors(html, "https://player.example/e/abc123");
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].url, "https://player.example/api/stream");
  assert.equal(descriptors[0].method, "POST");
  assert.equal(descriptors[0].preserveQuery, true);
  assert.deepEqual(descriptors[0].fields.map((field) => field.name), ["filecode", "device"]);
});

test("detects similar ajax source endpoints without hardcoding a domain", () => {
  const html = `
    <script>
      $.ajax({
        url: "/ajax/get-video",
        method: "POST",
        data: { video_id: currentId, platform: "web" }
      });
    </script>
  `;

  const [descriptor] = extractDynamicApiDescriptors(html, "https://another.example/embed/987");
  assert.equal(descriptor.url, "https://another.example/ajax/get-video");
  assert.equal(descriptor.method, "POST");
  assert.deepEqual(descriptor.fields.map((field) => field.name), ["video_id", "platform"]);
  assert.equal(descriptor.fields[1].hasLiteral, true);
  assert.equal(descriptor.fields[1].value, "web");
});

test("rejects cross-origin and telemetry endpoints from dynamic API discovery", () => {
  const html = `
    <script>
      fetch("https://api.other.example/api/stream", { method: "POST", body: JSON.stringify({ id }) });
      fetch("/api/player-error", { method: "POST", body: JSON.stringify({ id }) });
      fetch("/api/heartbeat", { method: "POST", body: JSON.stringify({ id }) });
      fetch("/api/delete-video", { method: "POST", body: JSON.stringify({ id }) });
    </script>
  `;

  assert.deepEqual(extractDynamicApiDescriptors(html, "https://player.example/e/abc"), []);
});

test("extracts HLS, DASH, and direct files from dynamic JSON responses", () => {
  const result = extractMediaCandidatesFromJson({
    title: "Example video",
    thumbnail: "https://cdn.example.com/poster.jpg",
    streaming_url: "https://media.example.com/hls/abc/master.m3u8?token=temporary",
    playback: {
      sources: [
        { file: "/media/video.mp4", type: "video/mp4" },
        { src: "https://media.example.com/play?id=2", type: "video/webm" },
        { manifest_url: "https://media.example.com/dash/manifest.mpd" }
      ]
    },
    subtitles: [{ file: "https://cdn.example.com/subtitles/en.vtt" }],
    vast_ads: "https://ads.example.com/tag"
  }, "https://player.example/api/stream");

  assert.equal(result.title, "Example video");
  assert.equal(result.thumbnail, "https://cdn.example.com/poster.jpg");
  assert.deepEqual(
    result.sources.map(({ url, mimeType, kind, origin, needsProbe }) => ({
      url,
      mimeType,
      kind,
      origin,
      needsProbe
    })),
    [
      {
        url: "https://media.example.com/hls/abc/master.m3u8?token=temporary",
        mimeType: "application/vnd.apple.mpegurl",
        kind: "hls",
        origin: "dynamic-api",
        needsProbe: false
      },
      {
        url: "https://player.example/media/video.mp4",
        mimeType: "video/mp4",
        kind: "file",
        origin: "dynamic-api",
        needsProbe: false
      },
      {
        url: "https://media.example.com/play?id=2",
        mimeType: "video/webm",
        kind: "file",
        origin: "dynamic-api",
        needsProbe: false
      },
      {
        url: "https://media.example.com/dash/manifest.mpd",
        mimeType: "application/dash+xml",
        kind: "dash",
        origin: "dynamic-api",
        needsProbe: false
      }
    ]
  );
});

test("discovers only safe same-origin first-party scripts", () => {
  const html = `
    <script src="/assets/player.js"></script>
    <script src="https://player.example/assets/app.js"></script>
    <script src="https://cdn.other.example/player.js"></script>
    <script src="/assets/analytics.js"></script>
  `;

  assert.deepEqual(
    extractSameOriginScriptUrls(html, "https://player.example/e/abc"),
    [
      "https://player.example/assets/player.js",
      "https://player.example/assets/app.js"
    ]
  );
});

test("extracts common player-script media and retrieval URLs", () => {
  const script = `
    jwplayer("player").setup({
      sources: [
        { file: "https:\\/\\/cdn.example.com\\/movie\\/master.m3u8?token=abc" },
        { file: "/media/fallback.mp4" }
      ]
    });
    document.querySelector("video").src = "//cdn.example.com/direct.webm";
    const unresolvedTemplate = "https://cdn.example.com/\${videoId}.mp4";
    const robotlink = "https://player.example/get_video?id=abc&token=public";
  `;

  assert.deepEqual(
    extractScriptMediaCandidates(script, "https://player.example/e/abc").map(({ url, kind, needsProbe }) => ({
      url,
      kind,
      needsProbe
    })),
    [
      {
        url: "https://cdn.example.com/movie/master.m3u8?token=abc",
        kind: "hls",
        needsProbe: false
      },
      {
        url: "https://player.example/media/fallback.mp4",
        kind: "file",
        needsProbe: false
      },
      {
        url: "https://cdn.example.com/direct.webm",
        kind: "file",
        needsProbe: false
      },
      {
        url: "https://player.example/get_video?id=abc&token=public",
        kind: "file",
        needsProbe: true
      }
    ]
  );
});

test("derives public Videy CDN sources from current share-link IDs", () => {
  assert.deepEqual(
    extractVideyCandidates(
      "https://videy.co/v/?id=Xkn8XTQk",
      "const src = `https://cdn.videy.co/${id}.mp4`;"
    ),
    [{
      url: "https://cdn.videy.co/Xkn8XTQk.mp4",
      mimeType: "video/mp4",
      kind: "file",
      origin: "videy-public-cdn"
    }]
  );

  assert.equal(extractVideyCandidates("https://example.com/v/?id=Xkn8XTQk", "cdn.videy.co").length, 0);
});

test("recognizes Dood-style public pass endpoints without a domain allowlist", () => {
  const html = `
    <script>
      const playerUrl = "/pass_md5/abc123/public-token";
      const source = "?token=public-token&expiry=";
    </script>
  `;

  assert.deepEqual(
    extractDoodStyleDescriptor(html, "https://player-clone.example/e/video123"),
    {
      endpoint: "https://player-clone.example/pass_md5/abc123/public-token",
      token: "public-token"
    }
  );

  assert.equal(
    extractDoodStyleDescriptor(
      `<script>const path = "https://other.example/pass_md5/abc"; const source = "?token=abcd&";</script>`,
      "https://player.example/e/video123"
    ),
    null
  );
});
