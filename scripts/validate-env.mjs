#!/usr/bin/env node

import { join } from "node:path";
import {
  assertRegularFile,
  loadProfileEnv,
  normalizeProfile,
  parseCliEnvOptions,
  printValidationResult,
  profileEnvFiles,
  repoRoot,
  validateEnvironment,
} from "./env-policy.mjs";

const rawArgs = process.argv.slice(2);
const options = parseCliEnvOptions(rawArgs);
let allowPlaceholders = false;
let requireFiles = false;
let appRoot = process.cwd();

for (const arg of options.args) {
  if (arg === "--allow-placeholders") {
    allowPlaceholders = true;
  } else if (arg === "--require-files") {
    requireFiles = true;
  } else if (arg.startsWith("--app-root=")) {
    appRoot = arg.slice("--app-root=".length);
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else {
    console.error(`error: unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
}

if (!options.profile && !options.envFile) {
  console.error("error: pass --profile local, --profile production, or --env-file FILE");
  usage();
  process.exit(2);
}

const profile = normalizeProfile(options.profile || process.env.REND_ENV || "local");
const files = profileEnvFiles({
  profile,
  envFile: options.envFile,
  appRoot,
  cwd: process.cwd(),
});
const missingFileErrors = [];
if (options.envFile || requireFiles) {
  for (const file of files) {
    assertRegularFile(file, missingFileErrors);
  }
}

const { env, loadedFiles } = loadProfileEnv({
  profile,
  envFile: options.envFile,
  appRoot,
  cwd: process.cwd(),
});

const result = validateEnvironment({
  profile,
  env,
  files,
  allowPlaceholders,
});
result.errors.unshift(...missingFileErrors);
printValidationResult(result);

if (result.errors.length > 0) {
  process.exit(1);
}

const fileList = loadedFiles.length
  ? loadedFiles.map((file) => file.replace(`${repoRoot}/`, "")).join(", ")
  : "platform environment only";
console.log(`Env validation passed for ${profile} profile (${fileList})`);

function usage() {
  console.error(`Usage: node scripts/validate-env.mjs --profile local|production [options]

Options:
  --env-file FILE          Validate one explicit env file.
  --allow-placeholders     Permit placeholder values for checked-in examples.
  --require-files          Fail if the selected profile files are missing.
  --app-root PATH          Include an app env root. Default: current directory.

Examples:
  node scripts/validate-env.mjs --profile local --require-files
  node scripts/validate-env.mjs --profile production
  node scripts/validate-env.mjs --profile production --env-file .env.production.example --allow-placeholders
  node scripts/validate-env.mjs --profile production --app-root ${join("apps", "site")}
`);
}
