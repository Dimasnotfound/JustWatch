<p align="center">
  <img src="./public/favicon.svg" width="96" height="96" alt="Just Watch logo" />
</p>

<h1 align="center">Just Watch</h1>

<p align="center">
  <strong>Just paste. Press Watch. No pop-ups.</strong><br />
  <sub>No redirects. No source-page ads. Just the media.</sub>
</p>

<p align="center">
  A lightweight universal media resolver that finds playable public video sources and opens them in a clean, focused player.
</p>

<p align="center">
  <a href="https://just-watch.primacodes.com/">
    <img src="https://img.shields.io/badge/Live_Demo-Open_Just_Watch-91DFC2?style=for-the-badge&logo=vercel&logoColor=171B1F" alt="Open live demo" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22 or newer" />
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.12" />
  <img src="https://img.shields.io/badge/yt--dlp-Universal_Resolver-FFCC00?style=flat-square" alt="yt-dlp universal resolver" />
  <img src="https://img.shields.io/badge/Deploy-Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Deployed on Vercel" />
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-91DFC2?style=flat-square" alt="MIT License" />
  </a>
</p>

---

## Preview

### Clean landing page

<p align="center">
  <img src="./docs/assets/just-watch-desktop.png" width="100%" alt="Just Watch desktop interface" />
</p>

### Resolved media playback

<p align="center">
  <img src="./docs/assets/just-watch-result.png" width="100%" alt="Just Watch displaying a resolved video source" />
</p>

### Mobile layout

<p align="center">
  <img src="./docs/assets/just-watch-mobile.png" width="320" alt="Just Watch mobile interface" />
</p>

## What is Just Watch?

Just Watch accepts a public video or media-page URL, resolves available playback sources, and returns them to the browser without hosting the media file itself.

The resolver uses a layered approach:

1. Check whether the submitted URL is already a direct media source.
2. Inspect standard HTML video metadata and structured data.
3. Detect constrained same-origin stream APIs exposed by public player JavaScript.
4. Run supported site-specific adapters.
5. Fall back to `yt-dlp` for broader website coverage.
6. Play the selected source directly from the original media host or CDN.

> **About “No pop-ups”**
>
> Just Watch does not open the original ad-heavy player page, inject advertisements, or display source-page pop-ups. It does not remove ads that are already embedded inside a media stream.

## Highlights

- **Minimal interface** focused on one action: paste a URL and press **Watch**.
- **Layered resolver** for fast direct extraction and broad fallback coverage.
- **Direct playback** from the original host instead of storing video files.
- **HLS support** through `hls.js`.
- **MPEG-DASH support** through `dash.js`.
- **Official YouTube iframe playback** for public YouTube watch, short, live, embed, and `youtu.be` URLs.
- **Generic dynamic-player adapter** for public same-origin JSON stream APIs.
- **Bounded nested-player discovery** for same-origin iframe pages and statically assembled player URLs.
- **First-party player-script inspection** for common JW Player, Video.js, Clappr, direct CDN, and retrieval-URL patterns.
- **Public share-link adapters** for patterns such as Videy CDN links and Dood-style `pass_md5` players when the page is directly accessible.
- **VidSonic adapter** for public signed HLS manifests exposed to the browser.
- **yt-dlp fallback** for many public and unprotected media websites.
- **Optional self-hosted Cobalt provider** for supported social-media workflows.
- **No application URL history** through local storage, session storage, or query-string persistence.
- **Responsive layout** for desktop and mobile screens.
- **Vercel-ready** static frontend with Node.js and Python serverless functions.

## How it works

```mermaid
flowchart LR
    A[Paste a public media URL] --> B[Direct and HTML discovery]
    B --> C{Playable source found?}
    C -->|Yes| G[Return media sources]
    C -->|No| D[Safe same-origin player API discovery]
    D --> E{Playable source found?}
    E -->|Yes| G
    E -->|No| F[Site adapter and yt-dlp fallback]
    F --> G
    G --> H[Browser player]
    H --> I[Original CDN or media host]
```

The application does not proxy the full video through Vercel. The API returns source metadata and playable URLs, while the browser requests the media from its original location.

## Supported source types

### Direct media

- MP4
- WebM
- Ogg Video
- HLS playlists (`.m3u8`)
- MPEG-DASH manifests (`.mpd`)

### Standard page discovery

- `og:video`
- `twitter:player:stream`
- HTML5 `<video>` and `<source>` elements
- JSON-LD `contentUrl`
- Relative media URLs resolved against the source page

### Extended providers

- Public YouTube URLs through the official embedded player rather than temporary `googlevideo.com` extraction URLs
- Public player pages that expose a same-origin stream, media, source, video, player, manifest, or file API in their JavaScript
- Same-origin first-party bundles containing common player configuration or retrieval URLs
- Common JSON response fields such as `streaming_url`, `manifest_url`, `playlist`, `sources`, `file`, and `src`
- Vidara-style and similar `/api/stream` player flows
- Videy public share links backed by `cdn.videy.co`
- Dood-style `pass_md5` player flows when their public page is available without a browser challenge
- VidSonic public signed manifests
- Websites supported by the installed `yt-dlp` release
- Optional self-hosted Cobalt instance

Dynamic API discovery does not execute arbitrary page JavaScript. It only follows a small number of same-origin retrieval endpoints, derives non-sensitive public identifiers from the submitted URL, and validates every returned media URL. Hostnames are not treated as universal guarantees because player implementations change frequently.

Cloudflare challenges, CAPTCHA, login gates, DRM, private content, and source URLs that require browser-only headers or unsupported CORS policies are not bypassed. Some hosts may therefore be detected but still refuse direct browser playback.

## Architecture

```text
public/
  index.html          Minimal interface, metadata, and JSON-LD
  styles.css          Responsive visual system
  app.js              Resolver flow and media player logic
  favicon.svg         Shared browser and application icon
  og-image.png        1200 × 630 social sharing preview
  robots.txt          Search crawler rules
  sitemap.xml         Canonical production URL sitemap
  site.webmanifest    Installable web application metadata

api/
  resolve.js          Fast Node.js resolver and safe dynamic player adapters
  universal.py        Python resolver powered by yt-dlp and optional Cobalt

scripts/
  setup-universal.mjs Local Python environment setup
  python-runner.mjs   Cross-platform Python command runner
  ui-smoke.mjs        Browser smoke test

tests/
  resolve.test.mjs    Fast resolver tests
  seo.test.mjs        Canonical, metadata, sitemap, and OG tests
  test_universal.py   Universal resolver tests

docs/assets/
  just-watch-desktop.png
  just-watch-result.png
  just-watch-mobile.png

server.mjs            Local development server
requirements.txt      Python dependencies
vercel.json           Vercel Functions and response-header configuration
```

## Privacy behavior

Just Watch is designed not to keep a local URL history.

- The URL input uses `autocomplete="off"`.
- The input is cleared after a successful resolve.
- The application does not write URLs to `localStorage` or `sessionStorage`.
- Submitted URLs are not placed in the page query string or browser History API.
- Resolver API responses use `Cache-Control: no-store`.
- Media files are not uploaded to or stored by the application.

Submitted URLs are still sent to the deployed serverless resolver and then requested from the relevant upstream website. Hosting providers and upstream services may maintain their own operational logs.

## Security controls

The resolver includes protections intended to reduce misuse and server-side request forgery risks:

- Only HTTP and HTTPS URLs are accepted.
- URLs containing embedded credentials are rejected.
- Localhost, private IP ranges, and reserved addresses are blocked.
- DNS results and redirects are validated before use.
- Redirect depth, request size, response size, playlist entries, and processing time are limited.
- Dynamic player API calls are restricted to the source page's exact origin and retrieval-oriented endpoint paths.
- Nested player pages are restricted to the exact source origin, blocked from unsafe path categories, and capped by depth and request count.
- A public anonymous session cookie set by the submitted page may be reused only for that same-origin API request and is never returned to the browser.
- Browser cookies and account credentials are not imported.
- Fields associated with authentication, signatures, CAPTCHA, DRM, licenses, passwords, or secrets are not synthesized.
- Geo-bypass and DRM circumvention are not implemented.
- Sensitive request headers are not returned to the client.

## Local development

### Requirements

- Node.js 22 or newer
- Python 3.12

FFmpeg is not required for the current metadata-only resolver flow because Just Watch does not download, merge, or transcode media on the server.

### Install the universal resolver

```bash
npm run setup:universal
```

This creates an isolated `.venv` and installs the dependencies from `requirements.txt`.

### Start the application

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### Run validation and tests

```bash
npm run check
```

## Deploy to Vercel

Use these project settings:

```text
Framework Preset: Other
Root Directory:   repository root
Build Command:    leave empty
Output Directory: public
Install Command:  default
```

Vercel detects:

- `api/resolve.js` as a Node.js Function.
- `api/universal.py` as a Python Function.
- `requirements.txt` as the Python dependency file.
- `.python-version` as the requested Python runtime version.

The current production deployment is available at:

**https://just-watch.primacodes.com/**

### Search indexing and SEO

The production domain is the canonical URL used by the HTML metadata, Open Graph tags, Twitter Card, JSON-LD structured data, robots file, and sitemap.

```text
Canonical: https://just-watch.primacodes.com/
Robots:    https://just-watch.primacodes.com/robots.txt
Sitemap:   https://just-watch.primacodes.com/sitemap.xml
OG image:  https://just-watch.primacodes.com/og-image.png
```

After deployment, add the domain property to Google Search Console, inspect the canonical homepage URL, request indexing, and submit `/sitemap.xml`. Search rankings are determined by Google and cannot be guaranteed by technical metadata alone.

### Optional Cobalt configuration

Just Watch only uses Cobalt when a self-hosted instance is explicitly configured.

```env
COBALT_API_URL=https://your-cobalt-instance.example.com
COBALT_API_KEY=your-api-key
```

Alternative authorization variables:

```env
COBALT_API_AUTHORIZATION=Api-Key your-api-key
# or
COBALT_BEARER_TOKEN=your-bearer-token
```

## API endpoints

### Fast resolver

```http
POST /api/resolve
Content-Type: application/json

{
  "url": "https://example.com/video-page"
}
```

### Universal resolver

```http
POST /api/universal
Content-Type: application/json

{
  "url": "https://example.com/video-page"
}
```

### Health check

```http
GET /api/health
```

A successful resolver response contains page metadata and one or more source entries:

```json
{
  "ok": true,
  "result": {
    "title": "Example video",
    "sourceHost": "cdn.example.com",
    "sources": [
      {
        "url": "https://cdn.example.com/video/master.m3u8",
        "kind": "hls",
        "mimeType": "application/vnd.apple.mpegurl"
      }
    ]
  }
}
```

## Limitations

“Universal” means broad coverage, not guaranteed access to every video website.

Just Watch intentionally does not bypass:

- DRM systems such as Widevine, FairPlay, or PlayReady
- Login requirements or private account cookies
- Paywalls, subscriptions, or members-only access
- CAPTCHA and anti-bot verification
- Region restrictions
- Private, deleted, or unavailable media
- Tokens tied to a specific account, device, IP address, or browser session

Playback can also fail when:

- A platform changes its website or API.
- The installed extractor is temporarily outdated.
- The source blocks Vercel data-center IP addresses.
- The media host rejects cross-origin playback.
- Audio and video are only available as separate tracks with no directly playable combined format.
- A signed media URL expires before playback begins.

## Responsible use

Use Just Watch only with media that you are authorized to access and play. Respect copyright, platform terms, creator rights, and applicable law.

Just Watch is an independent portfolio project and is not affiliated with any similarly named streaming guide, hosting provider, or media platform.

## License

This project is licensed under the [MIT License](./LICENSE).

Copyright © 2026 Dimas Juli Pratama.
