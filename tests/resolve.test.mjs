import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMediaCandidates,
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
