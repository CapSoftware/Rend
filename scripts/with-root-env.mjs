import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { expand } from "dotenv-expand";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/with-root-env.mjs <command> [...args]");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = process.cwd();
const mode = process.env.NODE_ENV || (args.includes("dev") ? "development" : "production");
const inheritedKeys = new Set(Object.keys(process.env));
const loaded = {};

function applyEnvFile(file) {
  if (!existsSync(file)) {
    return;
  }

  const parsed = parse(readFileSync(file));

  for (const [key, value] of Object.entries(parsed)) {
    if (!inheritedKeys.has(key)) {
      loaded[key] = value;
    }
  }
}

function loadEnvFiles(root) {
  applyEnvFile(join(root, ".env"));
  applyEnvFile(join(root, `.env.${mode}`));

  if (mode !== "test") {
    applyEnvFile(join(root, ".env.local"));
  }

  applyEnvFile(join(root, `.env.${mode}.local`));
}

loadEnvFiles(repoRoot);

if (appRoot !== repoRoot) {
  loadEnvFiles(appRoot);
}

const expanded = expand({
  parsed: loaded,
  processEnv: { ...process.env }
}).parsed ?? loaded;
const env = {
  ...process.env,
  ...expanded,
  NODE_ENV: process.env.NODE_ENV || mode
};

const child = spawn(args[0], args.slice(1), {
  env,
  shell: process.platform === "win32",
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
