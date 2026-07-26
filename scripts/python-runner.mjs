import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPython = process.platform === "win32"
  ? path.join(rootDirectory, ".venv", "Scripts", "python.exe")
  : path.join(rootDirectory, ".venv", "bin", "python");

const candidates = [
  process.env.JUSTWATCH_PYTHON,
  existsSync(localPython) ? localPython : null,
  process.platform === "win32" ? "python.exe" : "python3",
  "python"
].filter(Boolean);

const args = process.argv.slice(2);
for (const executable of [...new Set(candidates)]) {
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

  if (result.error?.code === "ENOENT") continue;
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error("Python tidak ditemukan. Instal Python 3.10 atau lebih baru.");
process.exit(1);
