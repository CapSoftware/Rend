#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadProfileEnv,
  parseEnvFile,
  repoRoot,
  validateEnvironment,
} from "./env-policy.mjs";

const launchDir = path.join(repoRoot, ".rend", "launch");
const publicFiles = [
  "apps/site/app/page.tsx",
  "apps/site/app/docs/page.tsx",
  "apps/site/app/docs/docs-content.ts",
  "apps/site/app/llms.txt/route.ts",
  "packages/sdk/README.md",
  "packages/sdk/examples/upload-and-embed.ts",
];
const dryRunRequiredSteps = [
  "self-serve-otp-sign-in",
  "self-serve-org-provision",
  "autumn-customer-plan",
  "dashboard-api-key",
  "upload",
  "playable",
  "public-playback",
  "billing-usage-track",
  "delete",
  "cleanup-verification",
  "self-serve-cleanup",
];

function usage() {
  return `Usage: node scripts/self-serve-readiness.mjs [options]

Writes a redacted public V1 self-serve readiness artifact under .rend/launch/.

Options:
  --env-file FILE
      Production env file. Defaults to .env.production.local when present.
  --dry-run-artifact FILE
      Production dry-run artifact. Defaults to .rend/launch/production-dry-run-latest.json.
  --otp-diagnostics-artifact FILE
      Auth OTP diagnostics artifact. Defaults to .rend/launch/auth-otp-diagnostics-latest.json.
  --launch-gate-artifact FILE
      Launch gate artifact. Defaults to .rend/launch/launch-readiness-latest.json.
  --require-otp-health
      Fail if the auth OTP diagnostics artifact is missing or not passing.
  --require-otp-probe
      Fail if the auth OTP diagnostics artifact does not include an accepted probe.
  --require-dry-run
      Fail if the dry-run artifact is missing or not passing.
  --require-launch-gate
      Fail if the launch-gate artifact is missing or not passing.
  --allow-placeholders
      Permit placeholder values in the env file. Use only for checked-in examples.
  -h, --help
      Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    envFile: process.env.REND_SELF_SERVE_READINESS_ENV_FILE || "",
    dryRunArtifact:
      process.env.REND_SELF_SERVE_DRY_RUN_ARTIFACT ||
      path.join(".rend", "launch", "production-dry-run-latest.json"),
    otpDiagnosticsArtifact:
      process.env.REND_SELF_SERVE_OTP_DIAGNOSTICS_ARTIFACT ||
      path.join(".rend", "launch", "auth-otp-diagnostics-latest.json"),
    launchGateArtifact:
      process.env.REND_SELF_SERVE_LAUNCH_GATE_ARTIFACT ||
      path.join(".rend", "launch", "launch-readiness-latest.json"),
    requireOtpHealth: truthy(process.env.REND_SELF_SERVE_REQUIRE_OTP_HEALTH),
    requireOtpProbe: truthy(process.env.REND_SELF_SERVE_REQUIRE_OTP_PROBE),
    requireDryRun: truthy(process.env.REND_SELF_SERVE_REQUIRE_DRY_RUN),
    requireLaunchGate: truthy(process.env.REND_SELF_SERVE_REQUIRE_LAUNCH_GATE),
    allowPlaceholders: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--env-file") args.envFile = next();
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else if (arg === "--dry-run-artifact") args.dryRunArtifact = next();
    else if (arg.startsWith("--dry-run-artifact=")) args.dryRunArtifact = arg.slice("--dry-run-artifact=".length);
    else if (arg === "--otp-diagnostics-artifact") args.otpDiagnosticsArtifact = next();
    else if (arg.startsWith("--otp-diagnostics-artifact=")) args.otpDiagnosticsArtifact = arg.slice("--otp-diagnostics-artifact=".length);
    else if (arg === "--launch-gate-artifact") args.launchGateArtifact = next();
    else if (arg.startsWith("--launch-gate-artifact=")) args.launchGateArtifact = arg.slice("--launch-gate-artifact=".length);
    else if (arg === "--require-otp-health") args.requireOtpHealth = true;
    else if (arg === "--require-otp-probe") args.requireOtpProbe = true;
    else if (arg === "--require-dry-run") args.requireDryRun = true;
    else if (arg === "--require-launch-gate") args.requireLaunchGate = true;
    else if (arg === "--allow-placeholders") args.allowPlaceholders = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.envFile && existsSync(path.join(repoRoot, ".env.production.local"))) {
    args.envFile = ".env.production.local";
  }
  return args;
}

function truthy(value) {
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

function isoNow() {
  return new Date().toISOString();
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolvePath(file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
}

function displayPath(file) {
  const relative = path.relative(repoRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, "/")
    : file;
}

function step(id, title, status, summary, data = {}) {
  return {
    id,
    title,
    status,
    summary,
    data,
  };
}

async function productionEnvStep(args) {
  const loaded = loadProfileEnv({
    profile: "production",
    envFile: args.envFile,
    appRoot: repoRoot,
    cwd: repoRoot,
  });
  const files = args.envFile
    ? [resolvePath(args.envFile)]
    : [path.join(repoRoot, ".env.production"), path.join(repoRoot, ".env.production.local")];
  const result = validateEnvironment({
    profile: "production",
    env: loaded.env,
    files,
    allowPlaceholders: args.allowPlaceholders,
  });
  return step(
    "production-env",
    "production self-serve env",
    result.errors.length > 0 ? "fail" : "pass",
    result.errors.length > 0 ? `${result.errors.length} env error(s)` : "production self-serve env passed",
    {
      env_file: args.envFile ? displayPath(resolvePath(args.envFile)) : null,
      loaded_files: loaded.loadedFiles.map(displayPath),
      checks: {
        self_serve_signup_enabled: truthy(loaded.env.REND_SELF_SERVE_SIGNUP_ENABLED),
        better_auth_configured: Boolean(loaded.env.BETTER_AUTH_SECRET || loaded.env.AUTH_SECRET),
        resend_configured: Boolean(loaded.env.RESEND_API_KEY && loaded.env.REND_AUTH_EMAIL_FROM),
        autumn_configured: Boolean(loaded.env.AUTUMN_SECRET_KEY),
        operator_allowlist_configured: Boolean(loaded.env.REND_OPERATOR_EMAIL_ALLOWLIST),
        dev_auth_disabled: !loaded.env.REND_DEV_API_KEY,
      },
      errors: result.errors,
    },
  );
}

async function publicCopyStep() {
  const failures = [];
  const scanned = [];
  const forbidden = [
    /\bwaitlist\b/i,
    /\binvite(?:s|d| only)?\b/i,
    /\bmanual approval\b/i,
    /\bprivate[- ]trial\b/i,
    /\bjoin the beta\b/i,
  ];
  for (const relative of publicFiles) {
    const file = path.join(repoRoot, relative);
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    scanned.push(relative);
    for (const pattern of forbidden) {
      if (pattern.test(text)) failures.push({ file: relative, pattern: String(pattern) });
    }
  }
  return step(
    "public-copy",
    "public self-serve copy",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? `${failures.length} waitlist/invite-like reference(s)` : "public copy is self-serve",
    { scanned_files: scanned, failures },
  );
}

async function artifactStep(id, title, file, required, validator) {
  const resolved = resolvePath(file);
  if (!existsSync(resolved)) {
    return step(
      id,
      title,
      required ? "fail" : "pass",
      required ? `${displayPath(resolved)} is missing` : `${displayPath(resolved)} not provided; optional check skipped`,
      { artifact: displayPath(resolved), required, skipped: !required },
    );
  }
  try {
    const artifact = JSON.parse(await readFile(resolved, "utf8"));
    const failures = validator(artifact);
    return step(
      id,
      title,
      failures.length > 0 ? "fail" : "pass",
      failures.length > 0 ? `${failures.length} artifact validation error(s)` : "artifact passed",
      { artifact: displayPath(resolved), status: artifact.status, failures },
    );
  } catch (error) {
    return step(id, title, "fail", "artifact could not be parsed", {
      artifact: displayPath(resolved),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateDryRunArtifact(artifact) {
  const failures = [];
  if (artifact.status !== "pass") failures.push("production dry-run status is not pass");
  const stepIds = new Set(Array.isArray(artifact.steps) ? artifact.steps.map((entry) => entry.id) : []);
  for (const requiredStep of dryRunRequiredSteps) {
    if (!stepIds.has(requiredStep)) failures.push(`missing dry-run step ${requiredStep}`);
  }
  if (!artifact.self_serve_account?.organization_id) failures.push("missing self-serve organization id");
  return failures;
}

function validateOtpDiagnosticsArtifact(artifact, requireProbe) {
  const failures = [];
  if (artifact.status !== "pass") failures.push("auth OTP diagnostics status is not pass");
  const stepIds = new Set(Array.isArray(artifact.steps) ? artifact.steps.map((entry) => entry.id) : []);
  for (const requiredStep of ["otp-config", "otp-db", "otp-send-probe"]) {
    if (!stepIds.has(requiredStep)) failures.push(`missing auth OTP diagnostics step ${requiredStep}`);
  }
  if (requireProbe && artifact.otp_probe?.accepted !== true) {
    failures.push("auth OTP diagnostics did not confirm an accepted OTP send probe");
  }
  return failures;
}

function validateLaunchGateArtifact(artifact, requireOtpHealth) {
  const failures = [];
  if (artifact.status !== "pass") failures.push("launch gate status is not pass");
  const stepIds = new Set(Array.isArray(artifact.steps) ? artifact.steps.map((entry) => entry.id) : []);
  const requiredSteps = ["launch-mode-policy", "production-env-validation", "autumn-catalog-parity"];
  if (requireOtpHealth) requiredSteps.push("auth-otp-diagnostics");
  for (const requiredStep of requiredSteps) {
    if (!stepIds.has(requiredStep)) failures.push(`missing launch gate step ${requiredStep}`);
  }
  return failures;
}

function overallStatus(steps) {
  return steps.some((entry) => entry.status === "fail")
    ? "fail"
    : steps.some((entry) => entry.status === "warn")
      ? "warn"
      : "pass";
}

async function writeArtifact(document) {
  await mkdir(launchDir, { recursive: true });
  const outputPath = path.join(launchDir, `self-serve-readiness-${document.run_id}.json`);
  const latestPath = path.join(launchDir, "self-serve-readiness-latest.json");
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  await copyFile(outputPath, latestPath);
  return { outputPath, latestPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const id = runId();
  const startedAt = isoNow();
  const steps = [
    await productionEnvStep(args),
    await publicCopyStep(),
    await artifactStep(
      "auth-otp-diagnostics-artifact",
      "auth OTP diagnostics artifact",
      args.otpDiagnosticsArtifact,
      args.requireOtpHealth,
      (artifact) => validateOtpDiagnosticsArtifact(artifact, args.requireOtpProbe),
    ),
    await artifactStep(
      "production-dry-run-artifact",
      "self-serve production dry-run artifact",
      args.dryRunArtifact,
      args.requireDryRun,
      validateDryRunArtifact,
    ),
    await artifactStep(
      "launch-gate-artifact",
      "launch gate artifact",
      args.launchGateArtifact,
      args.requireLaunchGate,
      (artifact) => validateLaunchGateArtifact(artifact, args.requireOtpHealth),
    ),
  ];
  const status = overallStatus(steps);
  const document = {
    schema_version: 1,
    kind: "rend-public-v1-self-serve-readiness",
    run_id: id,
    status,
    started_at: startedAt,
    ended_at: isoNow(),
    artifact_policy: {
      redacted: true,
      secrets: false,
      otps: false,
      api_keys: false,
      cookies: false,
      checkout_internals: false,
      signed_urls: false,
      internal_endpoints: false,
    },
    steps,
  };
  const written = await writeArtifact(document);
  console.log(`Self-serve readiness ${status.toUpperCase()}`);
  console.log(`Artifact: ${displayPath(written.outputPath)}`);
  console.log(`Latest: ${displayPath(written.latestPath)}`);
  return status === "fail" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
