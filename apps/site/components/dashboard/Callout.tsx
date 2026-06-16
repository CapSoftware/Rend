import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export type CalloutTone = "success" | "warn" | "danger" | "info";

const toneStyles: Record<CalloutTone, { wrap: string; icon: string; defaultIcon: LucideIcon }> = {
  success: {
    wrap: "border-[#cfe7d6] bg-[#f4faf6] text-[#2f6b46]",
    icon: "text-[#3f8f5b]",
    defaultIcon: CircleCheck,
  },
  warn: {
    wrap: "border-[#ecd9ad] bg-[#fcf7ea] text-[#7a5e1a]",
    icon: "text-[#c79a2e]",
    defaultIcon: TriangleAlert,
  },
  danger: {
    wrap: "border-[#eccac6] bg-[#fcf3f1] text-[#8f281f]",
    icon: "text-[#b54033]",
    defaultIcon: CircleAlert,
  },
  info: {
    wrap: "border-line bg-bg-sunken text-ink-soft",
    icon: "text-faint",
    defaultIcon: Info,
  },
};

export function Callout({
  tone = "info",
  title,
  children,
  action,
  icon,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Pass `null` to hide the icon entirely. */
  icon?: LucideIcon | null;
  className?: string;
}) {
  const styles = toneStyles[tone];
  const Icon = icon === null ? null : (icon ?? styles.defaultIcon);

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-[13.5px]",
        styles.wrap,
        className,
      )}
    >
      {Icon ? <Icon className={cn("mt-0.5 size-[18px] shrink-0", styles.icon)} /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold leading-tight">{title}</p> : null}
        {children ? <div className={cn("min-w-0", title && "mt-0.5 opacity-90")}>{children}</div> : null}
      </div>
      {action ? <div className="ml-auto flex shrink-0 items-center self-center">{action}</div> : null}
    </div>
  );
}
