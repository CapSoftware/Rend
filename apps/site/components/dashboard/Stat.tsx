import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-line bg-card px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</p>
        {Icon ? <Icon className="size-4 text-faint" /> : null}
      </div>
      <p className="mt-2 font-mono text-[21px] font-medium leading-none tabular-nums text-ink">{value}</p>
      {hint ? <p className="mt-1.5 text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}
