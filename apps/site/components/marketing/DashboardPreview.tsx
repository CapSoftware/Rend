import { cn } from "@/components/ui/cn";
import { BrowserFrame } from "./BrowserFrame";

type AssetRow = {
  name: string;
  status: "Ready" | "Processing";
  res: string;
  duration: string;
};

const assets: AssetRow[] = [
  { name: "product-demo.mp4", status: "Ready", res: "1080p", duration: "2:14" },
  { name: "onboarding-v3.mp4", status: "Ready", res: "4K", duration: "0:48" },
  { name: "webinar-q2.mp4", status: "Processing", res: "1080p", duration: "1:02:30" },
  { name: "changelog-jul.mp4", status: "Ready", res: "720p", duration: "0:36" },
];

const nav = [
  { label: "Assets", active: true },
  { label: "API keys", active: false },
  { label: "Analytics", active: false },
  { label: "Billing", active: false },
];

const stats = [
  { label: "Assets", value: "1,284" },
  { label: "Delivered", value: "4.2M min" },
  { label: "p50 start", value: "0.18s" },
];

function StatusPill({ status }: { status: AssetRow["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        status === "Ready"
          ? "border-[#cfe7d6] bg-[#f1faf4] text-[#2f6b46]"
          : "border-[#ead9b0] bg-[#fbf4e3] text-[#8a6d22]",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "Ready" ? "bg-[#3f8f5b]" : "bg-[#c79a2e]",
        )}
      />
      {status}
    </span>
  );
}

export function DashboardPreview({ className }: { className?: string }) {
  return (
    <BrowserFrame
      kind="browser"
      title="app.rend.so/assets"
      className={className}
      bodyClassName="bg-card"
    >
      <div className="flex" aria-hidden="true">
        {/* Sidebar */}
        <aside className="hidden w-[168px] shrink-0 flex-col border-r border-line-soft bg-bg-sunken/40 p-4 sm:flex">
          <div className="mb-6 flex items-center gap-2">
            <svg width="13" height="22" viewBox="0 0 75 135" fill="none" aria-hidden="true">
              <path d="M0 27L30.3 44.17V90.64L0 107.8V27Z" fill="var(--color-ink)" />
              <path d="M41.42 48.21L74.75 67.4L41.42 86.6V48.21Z" fill="var(--color-ink)" />
            </svg>
            <span className="text-[13px] font-semibold tracking-tight text-ink">Rend</span>
          </div>
          <nav className="flex flex-col gap-0.5">
            {nav.map((item) => (
              <span
                key={item.label}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px]",
                  item.active
                    ? "bg-card font-medium text-ink shadow-[0_1px_2px_rgba(22,21,19,0.06)]"
                    : "text-muted",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    item.active ? "bg-ink" : "bg-line",
                  )}
                />
                {item.label}
              </span>
            ))}
          </nav>
          <div className="mt-auto flex items-center gap-2 pt-6">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-[10px] font-semibold text-bg">
              C
            </span>
            <span className="text-[11.5px] text-muted">cap.so</span>
          </div>
        </aside>

        {/* Main */}
        <div className="min-w-0 flex-1 p-4 sm:p-5">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                Library
              </p>
              <p className="font-head text-[19px] leading-tight text-ink">Assets</p>
            </div>
            <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12px] font-medium text-bg">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              Upload
            </span>
          </div>

          <div className="mb-4 grid grid-cols-3 gap-2.5">
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl border border-line-soft bg-bg-sunken/40 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-[0.1em] text-faint">{s.label}</p>
                <p className="mt-0.5 font-mono text-[15px] font-medium tabular-nums text-ink">{s.value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-line-soft">
            <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line-soft bg-bg-sunken/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint sm:grid-cols-[1fr_auto_auto_auto]">
              <span>Name</span>
              <span className="hidden sm:block">Status</span>
              <span className="hidden text-right sm:block">Res</span>
              <span className="text-right">Length</span>
            </div>
            {assets.map((a, i) => (
              <div
                key={a.name}
                className={cn(
                  "grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2.5 sm:grid-cols-[1fr_auto_auto_auto]",
                  i !== assets.length - 1 && "border-b border-line-soft",
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-7 w-10 shrink-0 place-items-center rounded-md bg-ink">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--color-bg)" aria-hidden="true">
                      <path d="M8 5.5l11 6.5-11 6.5z" />
                    </svg>
                  </span>
                  <span className="truncate font-mono text-[12.5px] text-ink">{a.name}</span>
                </span>
                <span className="hidden sm:block">
                  <StatusPill status={a.status} />
                </span>
                <span className="hidden text-right font-mono text-[12px] text-muted sm:block">{a.res}</span>
                <span className="text-right font-mono text-[12px] tabular-nums text-muted">{a.duration}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}
