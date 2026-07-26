import { writeFile } from "node:fs/promises";

const debuggerPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const appUrl = process.env.APP_URL || "http://127.0.0.1:3000/";
const sampleVideo = process.env.SAMPLE_VIDEO || "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const saveScreenshots = process.env.SAVE_SCREENSHOTS === "1";

async function createTarget(url) {
  const endpoint = `http://127.0.0.1:${debuggerPort}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) throw new Error(`Cannot create Chrome target: ${response.status}`);
  return response.json();
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = this.pending.get(message.id);
        if (!callback) return;
        this.pending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
        return;
      }

      const callbacks = this.listeners.get(message.method) || [];
      for (const callback of callbacks) callback(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  once(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const callback = (params) => {
        clearTimeout(timer);
        const callbacks = this.listeners.get(method) || [];
        this.listeners.set(method, callbacks.filter((item) => item !== callback));
        resolve(params);
      };
      this.on(method, callback);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Evaluation failed");
  }
  return response.result.value;
}

async function waitFor(client, expression, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Condition timed out: ${expression}`);
}

async function saveScreenshot(client, filename) {
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  await writeFile(filename, Buffer.from(data, "base64"));
}

const target = await createTarget("about:blank");
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();

const runtimeErrors = [];
const logErrors = [];
const networkFailures = [];

client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  runtimeErrors.push(exceptionDetails.text || "Runtime exception");
});
client.on("Log.entryAdded", ({ entry }) => {
  if (entry.level === "error") logErrors.push(entry.text);
});
client.on("Network.loadingFailed", ({ errorText, type, blockedReason }) => {
  if (type !== "Image") networkFailures.push({ errorText, type, blockedReason: blockedReason || null });
});

await Promise.all([
  client.send("Page.enable"),
  client.send("Runtime.enable"),
  client.send("Log.enable"),
  client.send("Network.enable")
]);

const desktopLoaded = client.once("Page.loadEventFired");
await client.send("Page.navigate", { url: appUrl });
await desktopLoaded;
await new Promise((resolve) => setTimeout(resolve, 1200));

const desktop = await evaluate(client, `(() => {
  const requiredIds = [
    "resolver-form", "video-url", "submit-button", "result-section",
    "source-select", "video-player", "open-source", "copy-source"
  ];
  const faviconHref = document.querySelector('link[rel~="icon"]')?.href || "";
  const logoHref = document.querySelector(".title-logo")?.src || "";
  return {
    title: document.title,
    missingIds: requiredIds.filter((id) => !document.getElementById(id)),
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    resolverVisible: Boolean(document.querySelector(".resolver")?.getBoundingClientRect().height),
    formVisible: Boolean(document.querySelector("#resolver-form")?.getBoundingClientRect().height),
    resultInitiallyHidden: document.querySelector("#result-section")?.hidden === true,
    iconConsistent: Boolean(faviconHref && logoHref && faviconHref === logoHref),
    formAutocomplete: document.querySelector("#resolver-form")?.autocomplete,
    inputAutocomplete: document.querySelector("#video-url")?.autocomplete,
    localStorageEntries: localStorage.length,
    sessionStorageEntries: sessionStorage.length
  };
})()`);

await evaluate(client, `(() => {
  const input = document.querySelector("#video-url");
  input.value = ${JSON.stringify(sampleVideo)};
  document.querySelector("#resolver-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true })
  );
  return true;
})()`);

await waitFor(
  client,
  `(() => !document.querySelector("#result-section").hidden || !document.querySelector("#message").hidden)()`,
  70_000
);
await waitFor(
  client,
  `(() => document.querySelector("#video-player").classList.contains("is-ready") || !document.querySelector("#message").hidden)()`,
  15_000
);

const resultState = await evaluate(client, `(() => ({
  resultVisible: !document.querySelector("#result-section").hidden,
  message: document.querySelector("#message").hidden ? "" : document.querySelector("#message").textContent.trim(),
  resultTitle: document.querySelector("#result-title").textContent.trim(),
  selectedSource: document.querySelector("#source-select").selectedOptions[0]?.textContent || "",
  playerReady: document.querySelector("#video-player").classList.contains("is-ready"),
  sourceUrl: document.querySelector("#open-source").href,
  inputValueAfterResolve: document.querySelector("#video-url").value
}))()`);
if (saveScreenshots) await saveScreenshot(client, "ui-result-desktop.png");

await client.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true
});
const mobileLoaded = client.once("Page.loadEventFired");
await client.send("Page.reload", { ignoreCache: true });
await mobileLoaded;
await new Promise((resolve) => setTimeout(resolve, 900));

const mobile = await evaluate(client, `(() => ({
  viewport: { width: innerWidth, height: innerHeight },
  documentWidth: document.documentElement.scrollWidth,
  horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  formWidth: Math.round(document.querySelector("#resolver-form").getBoundingClientRect().width),
  submitWidth: Math.round(document.querySelector("#submit-button").getBoundingClientRect().width),
  titleVisible: Boolean(document.querySelector("#page-title")?.getBoundingClientRect().height)
}))()`);
if (saveScreenshots) await saveScreenshot(client, "ui-smoke-mobile.png");

client.close();

const report = {
  desktop,
  resultState,
  mobile,
  runtimeErrors,
  logErrors,
  networkFailures
};

console.log(JSON.stringify(report, null, 2));

if (
  desktop.missingIds.length ||
  desktop.horizontalOverflow ||
  !desktop.resolverVisible ||
  !desktop.formVisible ||
  !desktop.iconConsistent ||
  desktop.formAutocomplete !== "off" ||
  desktop.inputAutocomplete !== "off" ||
  desktop.localStorageEntries !== 0 ||
  desktop.sessionStorageEntries !== 0 ||
  !resultState.resultVisible ||
  resultState.inputValueAfterResolve !== "" ||
  mobile.horizontalOverflow ||
  !mobile.titleVisible ||
  runtimeErrors.length ||
  logErrors.length
) {
  process.exitCode = 1;
}
