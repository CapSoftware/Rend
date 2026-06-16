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
  ["BETTER_AUTH_SECRET", new Set(["local-better-auth-secret-only-for-rend-development"])],
  ["REND_SITE_INTERNAL_TOKEN", new Set(["local-site-internal-token"])],
]);

const ENV_FILE_KEY_PATTERN =
  /^(REND_|NEXT_PUBLIC_|BETTER_AUTH_|AUTH_SECRET$|RESEND_|AUTUMN_|DATABASE_URL$|REDIS_URL$|S3_|AWS_|CLICKHOUSE_|OBJECT_STORE_|KV_|UPSTASH_)/;

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
  if (normalized === "prod") {
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
  validateBillingEnv(env, errors, LOCAL_PROFILE);
  for (const [key, value] of relevantEnvEntries(env)) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      continue;
    }
    if (isUrlKey(key)) {
      validateLocalUrlishValue(key, normalized, errors, env);
    }
    if (isSecretKey(key) && isProductionSecretLike(key, normalized)) {
      errors.push(`${key} looks like a production secret; local profile must use dev/local-only secrets`);
    }
  }
}

function validateProductionEnv(env, errors, { allowPlaceholders }) {
  validateProductionAuthEnv(env, errors);
  validateBillingEnv(env, errors, PRODUCTION_PROFILE);
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

function validateProductionAuthEnv(env, errors) {
  const devApiKey = String(env.REND_DEV_API_KEY || "").trim();
  if (devApiKey) {
    errors.push("REND_DEV_API_KEY is local/dev only and must not be set in production profile");
  }

  const selfServeEnabled = ["1", "true", "yes", "on"].includes(
    String(env.REND_SELF_SERVE_SIGNUP_ENABLED || "").trim().toLowerCase(),
  );
  if (!selfServeEnabled) {
    errors.push("production profile requires REND_SELF_SERVE_SIGNUP_ENABLED=true for public self-serve signup");
  }

  const betterAuthSecret = String(env.BETTER_AUTH_SECRET || env.AUTH_SECRET || "").trim();
  if (!betterAuthSecret) {
    errors.push("production profile requires BETTER_AUTH_SECRET");
  }

  const betterAuthUrl = String(env.BETTER_AUTH_URL || env.REND_AUTH_BASE_URL || "").trim();
  if (!betterAuthUrl) {
    errors.push("production profile requires BETTER_AUTH_URL or REND_AUTH_BASE_URL");
  }

  const emailDisabled = ["1", "true", "yes", "on"].includes(
    String(env.REND_AUTH_EMAIL_DISABLED || "").trim().toLowerCase(),
  );
  if (emailDisabled) {
    errors.push("production self-serve signup requires REND_AUTH_EMAIL_DISABLED=false");
  }
  if (!String(env.RESEND_API_KEY || "").trim()) {
    errors.push("production self-serve signup requires RESEND_API_KEY");
  }
  if (!String(env.REND_AUTH_EMAIL_FROM || "").trim()) {
    errors.push("production self-serve signup requires REND_AUTH_EMAIL_FROM");
  }
  if (!String(env.REND_AUTH_OTP_PROBE_EMAIL || "").trim()) {
    errors.push("production self-serve signup requires REND_AUTH_OTP_PROBE_EMAIL for launch OTP health probes");
  }

  if (!String(env.REND_OPERATOR_EMAIL_ALLOWLIST || "").trim()) {
    errors.push("production profile requires REND_OPERATOR_EMAIL_ALLOWLIST");
  }
  if (!String(env.REND_SITE_INTERNAL_TOKEN || "").trim()) {
    errors.push("production profile requires REND_SITE_INTERNAL_TOKEN");
  }
}

function validateBillingEnv(env, errors, profile) {
  const mode = String(env.REND_BILLING_MODE || "")
    .trim()
    .toLowerCase();
  const normalizedMode = mode || (profile === PRODUCTION_PROFILE ? "autumn" : "local");
  if (!["local", "autumn"].includes(normalizedMode)) {
    errors.push("REND_BILLING_MODE must be one of: local, autumn");
    return;
  }
  if (profile === PRODUCTION_PROFILE && normalizedMode !== "autumn") {
    errors.push("production profile requires REND_BILLING_MODE=autumn");
  }
  if (normalizedMode === "autumn") {
    const autumnSecretKey = String(env.AUTUMN_SECRET_KEY || "").trim();
    if (!autumnSecretKey) {
      errors.push("REND_BILLING_MODE=autumn requires AUTUMN_SECRET_KEY");
    } else if (profile === PRODUCTION_PROFILE && !isPlaceholder(autumnSecretKey) && classifyAutumnKey(autumnSecretKey) !== "live") {
      errors.push("production profile requires AUTUMN_SECRET_KEY to be visibly marked as live");
    }
  }
  if (profile === PRODUCTION_PROFILE) {
    const failurePolicy = String(env.REND_BILLING_ENTITLEMENT_FAILURE_POLICY || "fail_closed")
      .trim()
      .toLowerCase();
    if (!["fail_closed", "closed"].includes(failurePolicy)) {
      errors.push("production profile requires REND_BILLING_ENTITLEMENT_FAILURE_POLICY=fail_closed");
    }
  }
}

function classifyAutumnKey(secretKey) {
  if (/^am_sk_live_/i.test(secretKey) || /(?:^|[_-])live(?:[_-])/i.test(secretKey)) return "live";
  if (
    /^am_sk_test_/i.test(secretKey) ||
    /(?:^|[_-])test(?:[_-])/i.test(secretKey) ||
    /(?:^|[_-])sandbox(?:[_-])/i.test(secretKey)
  ) {
    return "sandbox";
  }
  return "unknown";
}

function validateLocalUrlishValue(key, value, errors, env) {
  if (key === "AUTUMN_API_URL" && localAutumnTestingEnabled(env) && isAutumnApiUrl(value)) {
    return;
  }
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

function localAutumnTestingEnabled(env) {
  return String(env.REND_BILLING_MODE || "")
    .trim()
    .toLowerCase() === "autumn";
}

function isAutumnApiUrl(value) {
  const parsed = parseUrlCandidate(value);
  return Boolean(parsed && parsed.protocol === "https:" && parsed.hostname === "api.useautumn.com");
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
    if (key.startsWith("NEXT_PUBLIC_VERCEL_")) {
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
    /^am_sk_live_/i.test(trimmed) ||
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
