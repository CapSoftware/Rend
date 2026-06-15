import { cn } from "@/components/ui/cn";

export function PlayerMock({
  className,
  label = "product-demo.mp4",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("ui-window", className)} aria-hidden="true">
      <div className="relative aspect-video overflow-hidden bg-ink">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_32%_24%,rgba(255,255,255,0.1),transparent_58%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_78%_88%,rgba(181,135,43,0.16),transparent_55%)]" />

        <div className="absolute inset-0 grid place-items-center">
          <span className="grid h-[58px] w-[58px] place-items-center rounded-full bg-bg/95 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6)] transition-transform duration-300 hover:scale-105">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 5.5l11 6.5-11 6.5z" fill="var(--color-ink)" />
            </svg>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 bg-ink px-4 py-3 text-bg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5.5l11 6.5-11 6.5z" />
        </svg>
        <div className="relative h-1 flex-1 rounded-full bg-bg/20">
          <div className="absolute inset-y-0 left-0 w-[38%] rounded-full bg-bg" />
          <span className="absolute left-[38%] top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg shadow" />
        </div>
        <span className="font-mono text-[11px] tabular-nums text-bg/70">0:12 / 2:14</span>
        <span className="hidden rounded border border-bg/25 px-1.5 py-0.5 text-[10px] font-semibold text-bg/80 sm:inline">
          1080p
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-bg/70">
          <path
            d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
