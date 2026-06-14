#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  inferCommandProfile,
  loadProfileEnv,
  normalizeProfile,
  parseCliEnvOptions,
  printValidationResult,
  validateEnvironment,
} from "./env-policy.mjs";

const options = parseCliEnvOptions(process.argv.slice(2));

if (options.args.length === 0) {
  console.error(
    "Usage: node scripts/with-root-env.mjs [--profile local|production] [--env-file FILE] <command> [...args]",
  );
  process.exit(1);
}

const profile = normalizeProfile(options.profile || inferCommandProfile(options.args));
const appRoot = process.cwd();
const { env, files, loadedFiles } = loadProfileEnv({
  profile,
  envFile: options.envFile,
  appRoot,
  cwd: process.cwd(),
});

const validation = validateEnvironment({ profile, env, files });
printValidationResult(validation);
if (validation.errors.length > 0) {
  process.exit(1);
}

if (process.env.REND_ENV_DEBUG === "1") {
  const fileList = loadedFiles.length ? loadedFiles.join(", ") : "platform environment only";
  console.error(`[env] loaded ${profile} profile from ${fileList}`);
}

const child = spawn(options.args[0], options.args.slice(1), {
  env: {
    ...env,
    NODE_ENV: process.env.NODE_ENV || (profile === "local" ? "development" : "production"),
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
