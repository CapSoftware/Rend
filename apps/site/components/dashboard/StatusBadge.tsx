import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export type StatusTone = "success" | "danger" | "warn" | "progress" | "neutral";

const toneStyles: Record<StatusTone, { wrap: string; dot: string }> = {
  success: { wrap: "border-[#cfe7d6] bg-[#f3faf5] text-[#2f6b46]", dot: "bg-[#3f8f5b]" },
  danger: { wrap: "border-[#eccac6] bg-[#fcf3f1] text-[#9a2b22]", dot: "bg-[#b54033]" },
  warn: { wrap: "border-[#ead9b0] bg-[#fbf5e7] text-[#866422]", dot: "bg-[#c79a2e]" },
  progress: { wrap: "border-line bg-bg-sunken text-ink-soft", dot: "bg-faint animate-pulse" },
  neutral: { wrap: "border-line bg-card text-muted", dot: "bg-line" },
};

const stateToTone: Record<string, StatusTone> = {
  ready: "success",
  pass: "success",
  hls_ready: "success",
  opener_ready: "progress",
  uploaded: "success",
  active: "success",
  ok: "success",
  succeeded: "success",
  failed: "danger",
  fail: "danger",
  deleted: "danger",
  suspended: "danger",
  revoked: "danger",
  error: "danger",
  warn: "warn",
  missing: "warn",
  processing: "progress",
  uploading: "progress",
  not_playable: "progress",
  pending: "progress",
  queued: "progress",
};

/** Map a backend state string to a visual tone, falling back to neutral. */
export function toneForState(state: string): StatusTone {
  return stateToTone[state] ?? "neutral";
}

const stateLabels: Record<string, string> = {
  ready: "Ready",
  hls_ready: "Ready",
  opener_ready: "Ready, optimizing",
  uploaded: "Uploaded",
  uploading: "Uploading",
  processing: "Processing",
  not_playable: "Processing",
  queued: "Queued",
  pending: "Pending",
  active: "Active",
  ok: "Healthy",
  succeeded: "Succeeded",
  pass: "Passed",
  failed: "Failed",
  fail: "Failed",
  error: "Error",
  deleted: "Deleted",
  suspended: "Suspended",
  revoked: "Revoked",
  warn: "Warning",
  missing: "Missing",
};

/** Human-friendly label for a backend state (e.g. `hls_ready` -> `Ready`). */
export function labelForState(state: string): string {
  const known = stateLabels[state];
  if (known) return known;
  const cleaned = state.replace(/[_\s-]+/g, " ").trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : state;
}

export function StatusBadge({
  children,
  tone,
  state,
  dot = true,
  className,
}: {
  children?: ReactNode;
  tone?: StatusTone;
  state?: string;
  dot?: boolean;
  className?: string;
}) {
  const resolvedTone = tone ?? (state ? toneForState(state) : "neutral");
  const styles = toneStyles[resolvedTone];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-5",
        styles.wrap,
        className,
      )}
    >
      {dot ? <span className={cn("size-1.5 shrink-0 rounded-full", styles.dot)} /> : null}
      <span className="truncate">{children ?? (state ? labelForState(state) : null)}</span>
    </span>
  );
}
