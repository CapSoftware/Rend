import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { expand } from "dotenv-expand";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_PROFILE = "local";
const PRODUCTION_PROFILE = "production";
const PROFILE_VALUES = new Set([LOCAL_PROFILE, PRODUCTION_PROFILE]);

const LOCAL_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "::",
  "::1",
  "postgres",
  "redis",
  "minio",
  "clickhouse",
  "rend-api",
  "rend-edge",
  "rend-edge-us-east",
  "rend-edge-london",
]);

const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH_SECRET|SIGNING_KEY|SIGNING_SECRET)$/i;
const URL_KEY_PATTERN =
  /(URL|URI|ENDPOINT|DATABASE_URL|REDIS_URL|S3_ENDPOINT|OBJECT_STORE_HEALTH_URL|BASE_URL|HEALTH_URL|INGEST_URL|CONTROL_PLANE|EXPECTED_EDGES)/i;
const EDGE_URL_KEY_PATTERN =
  /(EDGE_.*URL|PLAYBACK_BASE_URL|CONTROL_PLANE_URL|TELEMETRY_INGEST_URL|EDGE_WARM_URL|EDGE_PURGE_URL)/i;

const DEV_DEFAULTS = new Map([
  ["REND_DEV_API_KEY", new Set(["dev-api-key"])],
  ["REND_EDGE_INTERNAL_TOKEN", new Set(["dev-internal-token"])],
  ["REND_INTERNAL_TELEMETRY_TOKEN", new Set(["dev-internal-token"])],
  ["REND_PLAYBACK_SIGNING_KEY_ID", new Set(["local-dev-playback-key"])],
  ["REND_PLAYBACK_SIGNING_SECRET", new Set(["local-dev-playback-signing-secret"])],
  ["AWS_ACCESS_KEY_ID", new Set(["rend_minio"])],
  ["AWS_SECRET_ACCESS_KEY", new Set(["rend_minio_password"])],
  ["CLICKHOUSE_PASSWORD", new Set(["rend"])],
  ["REND_SITE_OPERATOR_TOKEN", new Set(["local-site-operator-token"])],
  ["REND_SITE_AUTH_SECRET", new Set(["local-site-auth-secret"])],
]);

const ENV_FILE_KEY_PATTERN =
  /^(REND_|NEXT_PUBLIC_|DATABASE_URL$|REDIS_URL$|S3_|AWS_|CLICKHOUSE_|OBJECT_STORE_|KV_|UPSTASH_)/;

export function parseCliEnvOptions(argv) {
  const options = {
    profile: process.env.REND_ENV_PROFILE || "",
    envFile: process.env.REND_ENV_FILE || "",
    args: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      options.profile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
      continue;
    }
    if (arg === "--env-file") {
      options.envFile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
      continue;
    }
    options.args.push(arg);
  }

  return options;
}

export function normalizeProfile(value, { allowEmpty = false } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized && allowEmpty) {
    return "";
  }
  if (normalized === "prod" || normalized === "trial") {
    return PRODUCTION_PROFILE;
  }
  if (PROFILE_VALUES.has(normalized)) {
    return normalized;
  }
  throw new Error("REND_ENV_PROFILE must be one of: local, production");
}

export function inferCommandProfile(args) {
  const command = args.join(" ");
  if (/\b(dev|next dev)\b/.test(command)) {
    return LOCAL_PROFILE;
  }
  if (/\b(build|start|next build|next start)\b/.test(command)) {
    return PRODUCTION_PROFILE;
  }
  if (process.env.REND_ENV) {
    return normalizeProfile(process.env.REND_ENV);
  }
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_PROFILE;
  }
  return LOCAL_PROFILE;
}

export function resolveEnvFile(pathValue, cwd = process.cwd()) {
  if (!pathValue) {
    return "";
  }
  return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
}

export function profileEnvFiles({ profile, envFile, appRoot = process.cwd(), cwd = process.cwd() }) {
  if (envFile) {
    return [resolveEnvFile(envFile, cwd)];
  }

  const files =
    profile === PRODUCTION_PROFILE
      ? [join(repoRoot, ".env.production"), join(repoRoot, ".env.production.local")]
      : [join(repoRoot, ".env.local")];

  if (appRoot !== repoRoot) {
    if (profile === PRODUCTION_PROFILE) {
      files.push(join(appRoot, ".env.production"), join(appRoot, ".env.production.local"));
    } else {
      files.push(join(appRoot, ".env.local"));
    }
  }

  return files;
}

export function parseEnvFile(file) {
  if (!existsSync(file)) {
    return {};
  }
  return parse(readFileSync(file));
}

export function loadProfileEnv({ profile, envFile, appRoot = process.cwd(), cwd = process.cwd() }) {
  const files = profileEnvFiles({ profile, envFile, appRoot, cwd });
  const inheritedKeys = new Set(Object.keys(process.env));
  const loaded = {};
  const loadedFiles = [];

  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    const parsed = parseEnvFile(file);
    loadedFiles.push(file);
    for (const [key, value] of Object.entries(parsed)) {
      if (!inheritedKeys.has(key)) {
        loaded[key] = value;
      }
    }
  }

  const expanded = expand({
    parsed: loaded,
    processEnv: { ...process.env, ...loaded },
  }).parsed ?? loaded;

  const env = {
    ...process.env,
    ...expanded,
    REND_ENV_PROFILE: profile,
  };

  return {
    env,
    files,
    loadedFiles,
  };
}

export function validateEnvironment({ profile, env, files = [], allowPlaceholders = false }) {
  const errors = [];
  const warnings = [];

  validateFileSelection({ profile, files, errors });
  validateRendEnv({ profile, env, errors });
  validateNextPublic(env, errors);
  validateClientEnvExposure(errors);

  if (profile === LOCAL_PROFILE) {
    validateLocalEnv(env, errors);
  } else {
    validateProductionEnv(env, errors, { allowPlaceholders });
  }

  return { errors, warnings };
}

export function printValidationResult({ errors, warnings }) {
  for (const warning of warnings) {
    console.warn(`[warn] ${warning}`);
  }
  if (errors.length === 0) {
    return;
  }
  for (const error of errors) {
    console.error(`[env] ${error}`);
  }
}

export function npmScriptExists(scriptName) {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return Boolean(packageJson.scripts?.[scriptName]);
}

export function runEnvCommand(command, args, env) {
  return spawnSync(command, args, {
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
}

function validateFileSelection({ profile, files, errors }) {
  const existing = files.filter((file) => existsSync(file));
  const usesDefaultLocalFile = files.some((file) => file.endsWith(".env.local"));
  if (
    profile === LOCAL_PROFILE &&
    usesDefaultLocalFile &&
    !existing.some((file) => file.endsWith(".env.local"))
  ) {
    errors.push("local profile requires .env.local; copy .env.local.example to .env.local");
  }
  if (profile === PRODUCTION_PROFILE) {
    for (const file of existing) {
      if (file.endsWith(".env.local") && !file.endsWith(".env.production.local")) {
        errors.push(`production profile must not load ${relativePath(file)}`);
      }
    }
  }
}

function validateRendEnv({ profile, env, errors }) {
  const rendEnv = String(env.REND_ENV || "").trim().toLowerCase();
  if (profile === LOCAL_PROFILE && rendEnv !== LOCAL_PROFILE) {
    errors.push("local profile requires REND_ENV=local");
  }
  if (profile === PRODUCTION_PROFILE && rendEnv !== PRODUCTION_PROFILE) {
    errors.push("production profile requires REND_ENV=production");
  }
}

function validateLocalEnv(env, errors) {
  for (const [key, value] of relevantEnvEntries(env)) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      continue;
    }
    if (isUrlKey(key)) {
      validateLocalUrlishValue(key, normalized, errors);
    }
    if (isSecretKey(key) && isProductionSecretLike(key, normalized)) {
      errors.push(`${key} looks like a production secret; local profile must use dev/local-only secrets`);
    }
  }
}

function validateProductionEnv(env, errors, { allowPlaceholders }) {
  for (const [key, value] of relevantEnvEntries(env)) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      continue;
    }
    if (!allowPlaceholders && isPlaceholder(normalized)) {
      errors.push(`${key} contains a placeholder value`);
    }
    if (isKnownDevDefault(key, normalized)) {
      errors.push(`${key} contains a local/dev default`);
    }
    if (isUrlKey(key)) {
      validateProductionUrlishValue(key, normalized, errors);
    }
  }
}

function validateLocalUrlishValue(key, value, errors) {
  for (const candidate of splitUrlCandidates(value)) {
    const parsed = parseUrlCandidate(candidate);
    if (!parsed) {
      continue;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!isLocalHost(host)) {
      errors.push(`${key} must point to localhost, loopback, .local, or a Docker service in local profile`);
    }
  }
}

function validateProductionUrlishValue(key, value, errors) {
  for (const candidate of splitUrlCandidates(value)) {
    const parsed = parseUrlCandidate(candidate);
    if (!parsed) {
      continue;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (isLocalHost(host)) {
      errors.push(`${key} must not point to localhost, loopback, .local, or Docker service names in production profile`);
    }
    if (isEdgeUrlKey(key) && parsed.protocol !== "https:") {
      errors.push(`${key} must use https in production profile`);
    }
  }
}

function validateNextPublic(env, errors) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) {
      continue;
    }
    if (isSecretKey(key) || isProductionSecretLike(key, String(value || ""))) {
      errors.push(`${key} is public but has a secret-like name or value`);
    }
  }
}

function validateClientEnvExposure(errors) {
  const appRoot = join(repoRoot, "apps", "site");
  if (!existsSync(appRoot)) {
    return;
  }
  const result = spawnSync(
    "rg",
    ["-l", "process\\.env\\.", appRoot, "--glob", "!node_modules", "--glob", "!.next"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && !result.stdout) {
    return;
  }
  for (const file of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const source = readFileSync(file, "utf8");
    const isClientFile = /^\s*["']use client["'];?/m.test(source);
    if (!isClientFile) {
      continue;
    }
    const matches = source.matchAll(/process\.env\.([A-Z0-9_]+)/g);
    for (const match of matches) {
      const key = match[1];
      if (!key.startsWith("NEXT_PUBLIC_")) {
        errors.push(`${relativePath(file)} reads server-only ${key} in a client component`);
      }
    }
  }

  const nextConfig = join(appRoot, "next.config.ts");
  if (existsSync(nextConfig)) {
    const source = readFileSync(nextConfig, "utf8");
    if (/\benv\s*:/.test(source)) {
      const matches = source.matchAll(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\b/g);
      for (const match of matches) {
        if (!match[1].startsWith("NEXT_PUBLIC_")) {
          errors.push(`apps/site/next.config.ts may expose server-only ${match[1]} via next.config env`);
        }
      }
    }
  }
}

function relevantEnvEntries(env) {
  return Object.entries(env).filter(([key]) => ENV_FILE_KEY_PATTERN.test(key));
}

function splitUrlCandidates(value) {
  return value
    .split(",")
    .flatMap((entry) => {
      const trimmed = entry.trim();
      if (!trimmed.includes("=")) {
        return [trimmed];
      }
      return [trimmed.split("=").at(-1).trim()];
    })
    .filter(Boolean);
}

function parseUrlCandidate(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isUrlKey(key) {
  return URL_KEY_PATTERN.test(key);
}

function isEdgeUrlKey(key) {
  return EDGE_URL_KEY_PATTERN.test(key);
}

function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key);
}

function isLocalHost(host) {
  return (
    LOCAL_HOSTS.has(host) ||
    host.startsWith("127.") ||
    host.endsWith(".local") ||
    host === "host.docker.internal"
  );
}

function isKnownDevDefault(key, value) {
  const lowered = value.toLowerCase();
  if (DEV_DEFAULTS.get(key)?.has(lowered)) {
    return true;
  }
  return [
    "postgres://rend:rend@localhost:5432/rend",
    "postgres://rend:rend@postgres:5432/rend",
    "redis://localhost:6379",
    "redis://redis:6379",
    "http://localhost:8123",
    "http://clickhouse:8123",
    "http://localhost:9100",
    "http://minio:9000",
    "rend-local",
    "local",
    "local-edge-001",
    "docker-media-worker-001",
  ].includes(lowered);
}

function isProductionSecretLike(key, value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isKnownDevDefault(key, trimmed)) {
    return false;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.includes("local") || lowered.includes("dev") || lowered.includes("test")) {
    return false;
  }
  return (
    /^sk_live_/i.test(trimmed) ||
    /^pk_live_/i.test(trimmed) ||
    /^whsec_/i.test(trimmed) ||
    /^AKIA[0-9A-Z]{16}$/.test(trimmed) ||
    /^ASIA[0-9A-Z]{16}$/.test(trimmed) ||
    /^eyJ[A-Za-z0-9_-]+\./.test(trimmed) ||
    /^-----BEGIN /.test(trimmed) ||
    /^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed)
  );
}

function isPlaceholder(value) {
  const lowered = value.trim().toLowerCase();
  return (
    lowered.includes("replace-me") ||
    lowered.includes("changeme") ||
    lowered.includes("change-me") ||
    lowered.includes("placeholder") ||
    lowered.startsWith("<") && lowered.endsWith(">")
  );
}

function relativePath(file) {
  return file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
}

export function assertRegularFile(file, errors) {
  if (!existsSync(file)) {
    errors.push(`missing env file: ${relativePath(file)}`);
    return;
  }
  if (!statSync(file).isFile()) {
    errors.push(`env path is not a file: ${relativePath(file)}`);
  }
}
