export type RendMcpConfig = {
  apiKey?: string;
  apiBaseUrl: string;
  siteBaseUrl: string;
  maxUploadBytes: number;
};

const DEFAULT_API_BASE_URL = "https://api.rend.so";
const DEFAULT_SITE_BASE_URL = "https://rend.so";
const DEFAULT_MAX_UPLOAD_BYTES = 536_870_912;

type Env = Record<string, string | undefined>;

export function configFromEnv(env: Env = process.env, args = process.argv.slice(2)): RendMcpConfig {
  const parsedArgs = parseArgs(args);
  const apiKeyEnvName = parsedArgs.apiKeyEnv ?? stringEnv(env, "REND_MCP_API_KEY_ENV");
  const apiKey = apiKeyEnvName
    ? stringEnv(env, apiKeyEnvName)
    : stringEnv(env, "REND_MCP_API_KEY") ?? stringEnv(env, "REND_API_KEY");

  return {
    apiKey,
    apiBaseUrl: normalizeBaseUrl(
      parsedArgs.apiBaseUrl ??
        stringEnv(env, "REND_MCP_API_BASE_URL") ??
        stringEnv(env, "REND_API_BASE_URL") ??
        DEFAULT_API_BASE_URL
    ),
    siteBaseUrl: normalizeBaseUrl(
      parsedArgs.siteBaseUrl ??
        stringEnv(env, "REND_MCP_SITE_BASE_URL") ??
        stringEnv(env, "REND_SITE_BASE_URL") ??
        DEFAULT_SITE_BASE_URL
    ),
    maxUploadBytes: parsePositiveInt(
      parsedArgs.maxUploadBytes ??
        stringEnv(env, "REND_MCP_MAX_UPLOAD_BYTES") ??
        stringEnv(env, "REND_MAX_UPLOAD_BYTES"),
      DEFAULT_MAX_UPLOAD_BYTES
    ),
  };
}

function parseArgs(args: string[]) {
  const parsed: {
    apiBaseUrl?: string;
    siteBaseUrl?: string;
    maxUploadBytes?: string;
    apiKeyEnv?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (!arg.startsWith("--")) continue;

    if (inlineValue === undefined && value !== undefined && !value.startsWith("--")) {
      index += 1;
    }

    if (name === "--api-base-url") parsed.apiBaseUrl = value;
    if (name === "--site-base-url") parsed.siteBaseUrl = value;
    if (name === "--max-upload-bytes") parsed.maxUploadBytes = value;
    if (name === "--api-key-env") parsed.apiKeyEnv = value;
  }

  return parsed;
}

function stringEnv(env: Env, name: string) {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeBaseUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
