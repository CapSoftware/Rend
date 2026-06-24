const numberFormatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

export function formatNumber(value: number) {
  return numberFormatter.format(Math.round(value));
}

export function formatCompact(value: number) {
  return compactFormatter.format(value);
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

export function formatMs(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
}

export function formatPercent(value: number, fractionDigits?: number) {
  const digits = fractionDigits ?? (value >= 0.995 || value === 0 ? 0 : 1);
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatWatchTime(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
  const days = hours / 24;
  return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
}

/** Compact watch-time for axis/tooltip ("2.4h", "13m"). */
export function watchHours(ms: number) {
  return ms / 3_600_000;
}

export type Delta = { label: string; direction: "up" | "down" | "flat" } | null;

/**
 * Period-over-period change. Returns null when there is no comparable prior
 * value so the UI can omit the chip instead of rendering a misleading +100%.
 */
export function computeDelta(current: number, previous: number | undefined): Delta {
  if (previous === undefined) return null;
  if (previous === 0) {
    if (current === 0) return null;
    return { label: "New", direction: "up" };
  }
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { label: "0%", direction: "flat" };
  const pct = Math.abs(change) * 100;
  const rounded = pct >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const capped = rounded > 999 ? ">999" : `${rounded}`;
  return {
    label: `${change > 0 ? "+" : "-"}${capped}%`,
    direction: change > 0 ? "up" : "down",
  };
}

export const CHANNEL_LABELS: Record<string, string> = {
  direct: "Direct",
  referral: "Referral",
  organic_search: "Organic Search",
  social: "Social",
  email: "Email",
  paid: "Paid",
  campaign: "Campaign",
};

export function channelLabel(slug: string) {
  return CHANNEL_LABELS[slug] ?? titleCase(slug);
}

export function titleCase(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** DuckDuckGo favicon proxy (privacy-friendly, no Google beacon). */
export function faviconUrl(host: string) {
  const clean = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://icons.duckduckgo.com/ip3/${clean}.ico`;
}

/** Initial used for monogram fallbacks. */
export function monogram(value: string) {
  const match = value.replace(/^https?:\/\//, "").match(/[a-z0-9]/i);
  return match ? match[0].toUpperCase() : "•";
}
