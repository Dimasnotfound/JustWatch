import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CANONICAL_URL = "https://just-watch.primacodes.com/";
const OLD_DEPLOYMENT = "https://just-watch-alpha.vercel.app/";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/site.webmanifest", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("publishes complete canonical and social metadata", () => {
  assert.match(indexHtml, /<title>Just Watch – Clean Public Video Resolver &amp; Online Player<\/title>|<title>Just Watch – Clean Public Video Resolver & Online Player<\/title>/);
  assert.match(indexHtml, new RegExp(`<link rel="canonical" href="${CANONICAL_URL}"`));
  assert.match(indexHtml, new RegExp(`<meta property="og:url" content="${CANONICAL_URL}"`));
  assert.match(indexHtml, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(indexHtml, /name="robots"[\s\S]*?index, follow/);
  assert.doesNotMatch(indexHtml, new RegExp(OLD_DEPLOYMENT.replaceAll(".", "\\.")));
});

test("publishes valid application manifest metadata", () => {
  assert.equal(manifest.short_name, "Just Watch");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.theme_color, "#171b1f");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
});

test("publishes valid WebSite and WebApplication JSON-LD", () => {
  const match = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "JSON-LD script must be present");

  const structuredData = JSON.parse(match[1]);
  assert.equal(structuredData["@context"], "https://schema.org");
  assert.ok(Array.isArray(structuredData["@graph"]));

  const types = structuredData["@graph"].map((entry) => entry["@type"]);
  assert.ok(types.includes("WebSite"));
  assert.ok(types.includes("WebApplication"));
  assert.ok(structuredData["@graph"].every((entry) => entry.url === CANONICAL_URL));
});

test("robots and sitemap point to the canonical production domain", () => {
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${CANONICAL_URL}sitemap\\.xml$`, "m"));

  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap, new RegExp(`<loc>${CANONICAL_URL}</loc>`));
  assert.doesNotMatch(sitemap, new RegExp(OLD_DEPLOYMENT.replaceAll(".", "\\.")));
});

test("README uses the custom domain and documents indexing endpoints", () => {
  assert.match(readme, new RegExp(CANONICAL_URL.replaceAll(".", "\\.")));
  assert.match(readme, /Google Search Console/);
  assert.match(readme, /sitemap\.xml/);
  assert.doesNotMatch(readme, new RegExp(OLD_DEPLOYMENT.replaceAll(".", "\\.")));
});

test("keeps the homepage minimal with an accessible About dialog", () => {
  assert.match(indexHtml, /<dialog id="about-dialog"/);
  assert.match(indexHtml, /id="about-open"/);
  assert.match(indexHtml, /id="about-close"/);
  assert.doesNotMatch(indexHtml, /class="seo-content"/);
  assert.doesNotMatch(indexHtml, /class="site-footer"/);
});

test("Open Graph image is a 1200 by 630 PNG", () => {
  const image = readFileSync(new URL("../public/og-image.png", import.meta.url));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});
