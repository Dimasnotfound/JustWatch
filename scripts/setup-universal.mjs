import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvPython = process.platform === "win32"
  ? path.join(rootDirectory, ".venv", "Scripts", "python.exe")
  : path.join(rootDirectory, ".venv", "bin", "python");

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: rootDirectory,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    }
  });

  if (result.error) return { ok: false, missing: result.error.code === "ENOENT" };
  return { ok: result.status === 0, missing: false };
}

if (!existsSync(venvPython)) {
  const candidates = process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"];
  let created = false;

  for (const executable of candidates) {
    const result = run(executable, ["-m", "venv", ".venv"]);
    if (result.missing) continue;
    if (!result.ok) process.exit(1);
    created = true;
    break;
  }

  if (!created) {
    console.error("Python tidak ditemukan. Instal Python 3.10 atau lebih baru.");
    process.exit(1);
  }
}

if (!run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]).ok) process.exit(1);
if (!run(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"]).ok) process.exit(1);

console.log("Resolver universal siap digunakan.");
