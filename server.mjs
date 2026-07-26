import http from "node:http";
import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import resolveHandler from "./api/resolve.js";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(rootDirectory, ".env"));
  } catch {
    // Environment file is optional.
  }
}

const publicDirectory = path.join(rootDirectory, "public");
const universalScript = path.join(rootDirectory, "api", "universal.py");
const localPython = process.platform === "win32"
  ? path.join(rootDirectory, ".venv", "Scripts", "python.exe")
  : path.join(rootDirectory, ".venv", "bin", "python");
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) || process.env.PORT || 3000);
const MAX_BODY_BYTES = 16_384;
const MAX_PYTHON_OUTPUT_BYTES = 4 * 1024 * 1024;
const UNIVERSAL_TIMEOUT_MS = 60_000;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Port server tidak valid.");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pythonExecutable() {
  if (process.env.JUSTWATCH_PYTHON) return process.env.JUSTWATCH_PYTHON;
  if (await fileExists(localPython)) return localPython;
  return process.platform === "win32" ? "python.exe" : "python3";
}

async function runUniversalResolver(payload) {
  const executable = await pythonExecutable();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [universalScript, "--stdin"], {
      cwd: rootDirectory,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("UNIVERSAL_TIMEOUT"));
    }, UNIVERSAL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PYTHON_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(reject, new Error("UNIVERSAL_OUTPUT_TOO_LARGE"));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });

    child.on("error", (error) => finish(reject, error));
    child.on("close", () => {
      if (settled) return;

      const rawOutput = Buffer.concat(stdout).toString("utf8").trim();
      const lastLine = rawOutput.split(/\r?\n/).filter(Boolean).at(-1) || "";

      try {
        const parsed = JSON.parse(lastLine);
        const status = Number(parsed.status || (parsed.ok ? 200 : 422));
        delete parsed.status;
        finish(resolve, { status, payload: parsed });
      } catch {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        const error = new Error("UNIVERSAL_INVALID_RESPONSE");
        error.detail = detail.slice(0, 1_000);
        finish(reject, error);
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

async function serveStatic(urlPath, res) {
  const requestedPath = urlPath === "/" ? "/index.html" : urlPath;
  const decodedPath = decodeURIComponent(requestedPath);
  const absolutePath = path.resolve(publicDirectory, `.${decodedPath}`);

  if (!absolutePath.startsWith(`${publicDirectory}${path.sep}`)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) throw new Error("NOT_FILE");

    const content = await readFile(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[extension] || "application/octet-stream");
    res.setHeader("Cache-Control", extension === ".html" ? "no-store, max-age=0" : "public, max-age=3600");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (requestUrl.pathname === "/api/resolve") {
    try {
      req.body = await readJsonBody(req);
      await resolveHandler(req, res);
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "Body JSON tidak valid." });
      } else if (error?.message === "REQUEST_TOO_LARGE") {
        sendJson(res, 413, { ok: false, error: "Body permintaan terlalu besar." });
      } else {
        sendJson(res, 500, { ok: false, error: "Server lokal mengalami kesalahan." });
      }
    }
    return;
  }

  if (requestUrl.pathname === "/api/universal") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { ok: false, error: "Gunakan metode POST." });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await runUniversalResolver(body);
      sendJson(res, result.status, result.payload);
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "Body JSON tidak valid." });
      } else if (error?.message === "REQUEST_TOO_LARGE") {
        sendJson(res, 413, { ok: false, error: "Body permintaan terlalu besar." });
      } else if (error?.message === "UNIVERSAL_TIMEOUT") {
        sendJson(res, 504, { ok: false, error: "Resolver universal melewati batas waktu 60 detik." });
      } else if (error?.code === "ENOENT") {
        sendJson(res, 503, {
          ok: false,
          error: "Python atau yt-dlp belum tersedia. Jalankan python -m venv .venv lalu instal requirements.txt."
        });
      } else {
        sendJson(res, 500, { ok: false, error: "Resolver universal lokal mengalami kesalahan." });
      }
    }
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "justwatch",
      mode: "local",
      providers: {
        generic: true,
        vidsonic: true,
        cobalt: Boolean(process.env.COBALT_API_URL),
        ytdlp: await fileExists(localPython)
      }
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method not allowed");
    return;
  }

  await serveStatic(requestUrl.pathname, res);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${port} sedang digunakan oleh aplikasi lain.`);
    console.error("Hentikan proses tersebut atau jalankan: node server.mjs --port=3001");
    process.exit(1);
  }

  console.error("Server gagal dijalankan:", error);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`JustWatch berjalan di http://localhost:${port}`);
  console.log("Resolver aktif: direct/generic, VidSonic, yt-dlp.");
  console.log("Tekan Ctrl+C untuk menghentikan server.");
});
