const form = document.querySelector("#resolver-form");
const urlInput = document.querySelector("#video-url");
const submitButton = document.querySelector("#submit-button");
const submitLabel = submitButton.querySelector(".button-label");
const message = document.querySelector("#message");
const resultSection = document.querySelector("#result-section");
const resultTitle = document.querySelector("#result-title");
const sourceHost = document.querySelector("#source-host");
const mediaSwitcher = document.querySelector("#media-switcher");
const mediaSelect = document.querySelector("#media-select");
const sourceSelect = document.querySelector("#source-select");
const videoPlayer = document.querySelector("#video-player");
const embedPlayer = document.querySelector("#embed-player");
const playerPlaceholder = document.querySelector("#player-placeholder");
const playerPlaceholderText = playerPlaceholder.querySelector("p");
const openSource = document.querySelector("#open-source");
const copySource = document.querySelector("#copy-source");
const aboutOpen = document.querySelector("#about-open");
const aboutDialog = document.querySelector("#about-dialog");
const aboutClose = document.querySelector("#about-close");

const MAX_BATCH_URLS = 10;
const defaultSubmitLabel = submitLabel.textContent;
let currentResults = [];
let currentSources = [];
let activeSourceIndex = -1;
let failedSourceIndexes = new Set();
let playbackFailureHandled = false;
let hlsInstance = null;
let dashInstance = null;

const SERVER_MESSAGE_TRANSLATIONS = new Map([
  ["URL tidak valid.", "The URL is invalid."],
  ["Hanya URL HTTP atau HTTPS yang didukung.", "Only HTTP or HTTPS URLs are supported."],
  ["URL dengan kredensial tidak diizinkan.", "URLs containing credentials are not allowed."],
  ["Port URL tidak diizinkan.", "This URL port is not allowed."],
  ["Alamat lokal atau privat tidak diizinkan.", "Local or private addresses are not allowed."],
  ["Nama domain tidak dapat ditemukan.", "The domain name could not be resolved."],
  ["Domain mengarah ke alamat lokal atau privat.", "The domain resolves to a local or private address."],
  ["Sumber terlalu lama merespons.", "The source took too long to respond."],
  ["Sumber tidak dapat dihubungi.", "The source could not be reached."],
  ["Redirect sumber tidak memiliki tujuan.", "The source redirect has no destination."],
  ["Terlalu banyak redirect.", "The source returned too many redirects."],
  ["URL tidak mengarah ke halaman HTML atau media video yang didukung.", "The URL does not point to a supported HTML page or media file."],
  ["Sumber video publik tidak ditemukan pada halaman tersebut.", "No public video source was found on that page."],
  ["Gunakan metode POST.", "Use the POST method."],
  ["Body JSON tidak valid.", "The JSON request body is invalid."],
  ["Masukkan URL yang valid.", "Enter a valid URL."],
  ["Sumber tidak dapat diproses.", "The source could not be processed."],
  ["Situs atau jenis URL ini belum didukung oleh resolver universal.", "This site or URL type is not supported by the universal resolver yet."],
  ["Konten memerlukan login atau cookie akun dan tidak diproses oleh JustWatch.", "This content requires account login or cookies and cannot be processed."],
  ["Konten dilindungi DRM dan tidak dapat diproses.", "This content is DRM-protected and cannot be processed."],
  ["Konten dibatasi berdasarkan wilayah sumber.", "This content is restricted by region."],
  ["Platform meminta verifikasi anti-bot sehingga sumber tidak dapat diambil secara otomatis.", "The platform requires anti-bot verification, so the source cannot be resolved automatically."],
  ["Video tidak tersedia atau sudah dihapus.", "The video is unavailable or has been removed."],
  ["Platform terlalu lama merespons.", "The platform took too long to respond."],
  ["Sumber tidak dapat diproses oleh resolver universal.", "The universal resolver could not process this source."],
  ["Resolver tidak mengembalikan informasi media yang valid.", "The resolver did not return valid media information."],
  ["Konten tidak bersifat publik dan tidak dapat diproses.", "This content is not public and cannot be processed."],
  ["Sumber ditemukan sebagai trek video dan audio terpisah, tetapi tidak ada format gabungan yang dapat diputar langsung.", "The source uses separate video and audio tracks, and no combined format is available for direct playback."],
  ["yt-dlp mengenali halaman tersebut, tetapi tidak menemukan sumber media publik yang dapat diputar.", "yt-dlp recognized the page but found no playable public media source."],
  ["Format yang tersedia dapat memiliki trek audio dan video terpisah.", "Available formats may use separate audio and video tracks."],
  ["Sebagian URL bersifat sementara dan perlu diproses ulang setelah kedaluwarsa.", "Some URLs are temporary and must be resolved again after they expire."],
  ["Sumber Cobalt dapat berupa tunnel sementara dan perlu diproses ulang setelah kedaluwarsa.", "A Cobalt source may use a temporary tunnel and must be resolved again after it expires."],
  ["Posting ini memiliki beberapa video. Pilih sumber dari daftar.", "This post contains multiple videos. Select a source from the list."],
  ["Sumber ditemukan melalui halaman player bertingkat. Jika pemutaran langsung ditolak oleh host, gunakan Open source.", "The source was found through nested player pages. If the host rejects direct playback, use Open source."],
  ["Resolver universal mengalami kesalahan internal.", "The universal resolver encountered an internal error."],
  ["Body permintaan terlalu besar atau kosong.", "The request body is empty or too large."],
  ["Body permintaan terlalu besar.", "The request body is too large."],
  ["Server lokal mengalami kesalahan.", "The local server encountered an error."],
  ["Resolver universal melewati batas waktu 60 detik.", "The universal resolver exceeded the 60-second time limit."],
  ["Python atau yt-dlp belum tersedia. Jalankan python -m venv .venv lalu instal requirements.txt.", "Python or yt-dlp is unavailable. Create the .venv environment and install requirements.txt."],
  ["Resolver universal lokal mengalami kesalahan.", "The local universal resolver encountered an error."]
]);

function translateServerText(value) {
  if (typeof value !== "string" || !value) return value;
  if (SERVER_MESSAGE_TRANSLATIONS.has(value)) return SERVER_MESSAGE_TRANSLATIONS.get(value);

  return value
    .replace(/^Sumber menolak permintaan dengan status (\d+)\.$/, "The source rejected the request with status $1.")
    .replace(/^Media dari (.+)$/, "Media from $1")
    .replaceAll("Sumber media", "Media source")
    .replaceAll("Sumber video", "Video source")
    .replaceAll("video saja", "video only")
    .replaceAll("audio saja", "audio only")
    .replaceAll("tanpa audio", "no audio");
}

function setLoading(isLoading, label = defaultSubmitLabel) {
  submitButton.disabled = isLoading;
  submitButton.classList.toggle("is-loading", isLoading);
  submitButton.setAttribute("aria-label", isLoading ? label : defaultSubmitLabel);
  submitLabel.textContent = label;
  urlInput.disabled = isLoading;
}

function showMessage(text, type = "error") {
  message.textContent = translateServerText(text);
  message.className = `message ${type}`;
  message.hidden = false;
}

function clearMessage() {
  message.hidden = true;
  message.textContent = "";
  message.className = "message";
}

function parseInputUrls(value) {
  const tokens = String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const urls = [];
  const invalid = [];

  for (const token of tokens) {
    try {
      const parsed = new URL(token);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        invalid.push(token);
        continue;
      }
      if (!urls.includes(parsed.href)) urls.push(parsed.href);
    } catch {
      invalid.push(token);
    }
  }

  return { urls, invalid };
}

function sourceActionUrl(source) {
  if (!source || typeof source.url !== "string") return "";
  if (source.kind === "embed" && typeof source.openUrl === "string") return source.openUrl;
  return source.url;
}

function updateSourceActions(source) {
  const actionUrl = sourceActionUrl(source);
  if (actionUrl) {
    openSource.href = actionUrl;
    openSource.removeAttribute("aria-disabled");
  } else {
    openSource.removeAttribute("href");
    openSource.setAttribute("aria-disabled", "true");
  }
}

function destroyPlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if (dashInstance) {
    dashInstance.reset();
    dashInstance = null;
  }

  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.removeAttribute("type");
  videoPlayer.load();
  videoPlayer.classList.remove("is-ready");

  embedPlayer.removeAttribute("src");
  embedPlayer.classList.remove("is-ready");
  playerPlaceholderText.textContent = "Select a source to start playback.";
  playerPlaceholder.hidden = false;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function describeSource(source, index) {
  const kindLabels = {
    hls: "HLS stream",
    dash: "MPEG-DASH",
    embed: "Embedded player",
    audio: "Audio",
    file: source.mimeType || "Media file"
  };

  let hostname = "Media source";
  try {
    hostname = new URL(source.url).hostname;
  } catch {
    // Keep the fallback hostname.
  }

  const sourceLabel = translateServerText(source.label || kindLabels[source.kind] || "Media");
  const details = [sourceLabel];
  const fileSize = formatFileSize(source.fileSize);
  if (fileSize) details.push(fileSize);
  if (source.hasVideo && source.hasAudio === false && !sourceLabel.toLowerCase().includes("video only")) {
    details.push("no audio");
  }

  return `${index + 1}. ${details.join(" · ")} · ${hostname}`;
}

function markPlayerReady() {
  videoPlayer.classList.add("is-ready");
  playerPlaceholder.hidden = true;
}

function findFallbackSourceIndex() {
  return currentSources.findIndex((source, index) => (
    index !== activeSourceIndex &&
    !failedSourceIndexes.has(index) &&
    source &&
    typeof source.url === "string"
  ));
}

function handlePlaybackFailure(reason) {
  if (playbackFailureHandled || activeSourceIndex < 0) return;
  playbackFailureHandled = true;
  failedSourceIndexes.add(activeSourceIndex);

  const nextIndex = findFallbackSourceIndex();
  if (nextIndex >= 0) {
    sourceSelect.value = String(nextIndex);
    showMessage(
      `${reason} Trying source ${nextIndex + 1} of ${currentSources.length} automatically.`,
      "info"
    );
    window.setTimeout(() => {
      attachSource(currentSources[nextIndex], nextIndex, { keepMessage: true });
    }, 0);
    return;
  }

  const failedSource = currentSources[activeSourceIndex];
  updateSourceActions(failedSource);
  destroyPlayer();
  playerPlaceholderText.textContent = "Direct playback is blocked. Open the exact media source in a new tab.";
  showMessage(
    "The browser could not play the available sources directly. Open source now points to the exact media URL, not the original video page.",
    "info"
  );
}

function attachSource(source, sourceIndex = currentSources.indexOf(source), options = {}) {
  destroyPlayer();
  if (!options.keepMessage) clearMessage();

  activeSourceIndex = sourceIndex;
  playbackFailureHandled = false;
  updateSourceActions(source);

  if (source.kind === "embed") {
    let embedUrl;
    try {
      embedUrl = new URL(source.url);
      const allowedHosts = new Set([
        "youtube.com",
        "www.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com"
      ]);
      if (
        !allowedHosts.has(embedUrl.hostname.toLowerCase()) ||
        !/^\/embed\/[A-Za-z0-9_-]{11}$/.test(embedUrl.pathname)
      ) {
        throw new Error("Unsupported embed URL");
      }
      embedUrl.searchParams.set("origin", window.location.origin);
    } catch {
      handlePlaybackFailure("The embedded player URL is invalid.");
      return;
    }

    embedPlayer.src = embedUrl.href;
    embedPlayer.classList.add("is-ready");
    playerPlaceholder.hidden = true;
    return;
  }

  if (source.kind === "hls") {
    if (videoPlayer.canPlayType("application/vnd.apple.mpegurl")) {
      videoPlayer.src = source.url;
      return;
    }

    if (window.Hls?.isSupported()) {
      hlsInstance = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        manifestLoadingTimeOut: 12_000,
        levelLoadingTimeOut: 12_000,
        fragLoadingTimeOut: 20_000
      });
      hlsInstance.loadSource(source.url);
      hlsInstance.attachMedia(videoPlayer);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, markPlayerReady);
      hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          handlePlaybackFailure("The HLS source could not be loaded in this browser.");
        }
      });
      return;
    }

    handlePlaybackFailure("This browser does not support HLS playback.");
    return;
  }

  if (source.kind === "dash") {
    if (window.dashjs?.MediaPlayer) {
      dashInstance = window.dashjs.MediaPlayer().create();
      dashInstance.initialize(videoPlayer, source.url, false);
      dashInstance.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, markPlayerReady);
      dashInstance.on(window.dashjs.MediaPlayer.events.ERROR, () => {
        handlePlaybackFailure("The MPEG-DASH source could not be loaded in this browser.");
      });
      return;
    }

    handlePlaybackFailure("The MPEG-DASH player is unavailable.");
    return;
  }

  videoPlayer.src = source.url;
  if (source.mimeType) videoPlayer.setAttribute("type", source.mimeType);
  videoPlayer.load();

  if (source.hasVideo && source.hasAudio === false && !options.keepMessage) {
    showMessage("This format contains video only. Select another format to include audio.", "info");
  } else if (source.kind === "audio" && !options.keepMessage) {
    showMessage("The selected source contains audio only.", "info");
  }
}

function describeResult(result, index) {
  const title = translateServerText(result.title || `Video ${index + 1}`);
  const host = result.sourceHost || "Media source";
  return `${index + 1}. ${title} · ${host}`;
}

function renderSelectedResult(index) {
  const result = currentResults[index];
  if (!result) return;

  mediaSelect.value = String(index);
  currentSources = Array.isArray(result.sources) ? result.sources : [];
  activeSourceIndex = -1;
  failedSourceIndexes = new Set();
  playbackFailureHandled = false;
  sourceSelect.replaceChildren();
  clearMessage();

  currentSources.forEach((source, sourceIndex) => {
    const option = document.createElement("option");
    option.value = String(sourceIndex);
    option.textContent = describeSource(source, sourceIndex);
    sourceSelect.append(option);
  });

  resultTitle.textContent = translateServerText(result.title || "Video found");
  const provider = result.provider || result.extractor;
  sourceHost.textContent = translateServerText(
    [result.sourceHost || "Video source", provider].filter(Boolean).join(" · ")
  );
  resultSection.hidden = false;

  if (currentSources[0]) attachSource(currentSources[0], 0);

  if (Array.isArray(result.warnings) && result.warnings.length && message.hidden) {
    showMessage(result.warnings.map(translateServerText).join(" "), "info");
  }
}

function renderResults(results) {
  currentResults = results;
  mediaSelect.replaceChildren();

  currentResults.forEach((result, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = describeResult(result, index);
    mediaSelect.append(option);
  });

  mediaSwitcher.hidden = currentResults.length <= 1;
  renderSelectedResult(0);

  requestAnimationFrame(() => {
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function postResolver(endpoint, url) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ url })
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      error: "The server returned an invalid response."
    };
  }

  return {
    ok: response.ok && payload.ok,
    status: response.status,
    result: payload.result,
    error: translateServerText(payload.error || "The video could not be found.")
  };
}

function resolverProgressLabel(label, index, total) {
  return total > 1 ? `${label} ${index + 1}/${total}` : label;
}

async function resolveUrl(url, index = 0, total = 1) {
  setLoading(true, resolverProgressLabel("Checking direct source", index, total));
  const fastResult = await postResolver("/api/resolve", url);
  if (fastResult.ok) return fastResult.result;

  setLoading(true, resolverProgressLabel("Running universal resolver", index, total));
  const universalResult = await postResolver("/api/universal", url);
  if (universalResult.ok) return universalResult.result;

  if ([404, 405, 503].includes(universalResult.status)) {
    throw new Error(
      `${fastResult.error} The universal resolver is unavailable on this server. Install requirements.txt or review the deployment configuration.`
    );
  }

  throw new Error(universalResult.error || fastResult.error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  const value = urlInput.value.trim();
  if (!value) {
    showMessage("Enter at least one video or page URL first.");
    urlInput.focus();
    return;
  }

  const { urls, invalid } = parseInputUrls(value);
  if (invalid.length) {
    showMessage(`Invalid URL: ${invalid[0]}. Use complete HTTP or HTTPS addresses.`);
    urlInput.focus();
    return;
  }
  if (!urls.length) {
    showMessage("No valid HTTP or HTTPS URL was found.");
    urlInput.focus();
    return;
  }
  if (urls.length > MAX_BATCH_URLS) {
    showMessage(`A maximum of ${MAX_BATCH_URLS} URLs can be processed at once.`);
    urlInput.focus();
    return;
  }

  setLoading(true, resolverProgressLabel("Processing", 0, urls.length));
  resultSection.hidden = true;
  mediaSwitcher.hidden = true;
  currentResults = [];
  currentSources = [];
  destroyPlayer();

  const resolved = [];
  const failures = [];

  try {
    for (let index = 0; index < urls.length; index += 1) {
      try {
        const result = await resolveUrl(urls[index], index, urls.length);
        resolved.push({ ...result, inputUrl: urls[index] });
      } catch (error) {
        failures.push({
          index,
          url: urls[index],
          error: error instanceof Error ? error.message : "The URL could not be processed."
        });
      }
    }

    if (!resolved.length) {
      throw new Error(failures[0]?.error || "None of the submitted URLs could be resolved.");
    }

    renderResults(resolved);
    urlInput.value = "";

    if (failures.length) {
      const failedNumbers = failures.map((item) => item.index + 1).join(", ");
      showMessage(
        `Resolved ${resolved.length} of ${urls.length} URLs. Failed item${failures.length > 1 ? "s" : ""}: ${failedNumbers}.`,
        "info"
      );
    } else if (resolved.length > 1) {
      showMessage(`Resolved all ${resolved.length} URLs. Use Resolved media to switch videos.`, "info");
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "An error occurred while processing the URLs.");
  } finally {
    setLoading(false);
  }
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    form.requestSubmit();
  }
});

mediaSelect.addEventListener("change", () => {
  renderSelectedResult(Number(mediaSelect.value));
});

sourceSelect.addEventListener("change", () => {
  const sourceIndex = Number(sourceSelect.value);
  const source = currentSources[sourceIndex];
  if (!source) return;
  failedSourceIndexes = new Set();
  attachSource(source, sourceIndex);
});

copySource.addEventListener("click", async () => {
  const source = currentSources[Number(sourceSelect.value)];
  const actionUrl = sourceActionUrl(source);
  if (!actionUrl) return;

  try {
    await navigator.clipboard.writeText(actionUrl);
    const originalLabel = copySource.textContent;
    copySource.textContent = "Copied";
    setTimeout(() => {
      copySource.textContent = originalLabel;
    }, 1400);
  } catch {
    showMessage("The URL could not be copied automatically.", "info");
  }
});

function openAboutDialog() {
  if (typeof aboutDialog.showModal === "function") {
    aboutDialog.showModal();
    return;
  }
  aboutDialog.setAttribute("open", "");
}

function closeAboutDialog() {
  if (typeof aboutDialog.close === "function") {
    aboutDialog.close();
    return;
  }
  aboutDialog.removeAttribute("open");
  aboutOpen.focus();
}

aboutOpen.addEventListener("click", openAboutDialog);
aboutClose.addEventListener("click", closeAboutDialog);
aboutDialog.addEventListener("click", (event) => {
  const bounds = aboutDialog.getBoundingClientRect();
  const isBackdropClick =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (isBackdropClick) closeAboutDialog();
});
aboutDialog.addEventListener("close", () => aboutOpen.focus());

videoPlayer.addEventListener("loadedmetadata", markPlayerReady);
videoPlayer.addEventListener("canplay", markPlayerReady);
videoPlayer.addEventListener("error", () => {
  if (!videoPlayer.currentSrc || videoPlayer.error?.code === 1) return;
  handlePlaybackFailure("The selected source could not be played directly.");
});

function clearTransientSession() {
  if (aboutDialog.open) aboutDialog.close();
  urlInput.value = "";
  currentResults = [];
  currentSources = [];
  activeSourceIndex = -1;
  failedSourceIndexes = new Set();
  mediaSelect.replaceChildren();
  sourceSelect.replaceChildren();
  mediaSwitcher.hidden = true;
  openSource.removeAttribute("href");
  resultSection.hidden = true;
  clearMessage();
  destroyPlayer();
}

window.addEventListener("pagehide", clearTransientSession);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    clearTransientSession();
    return;
  }
  urlInput.value = "";
});
