import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export function Panel({
  title,
  description,
  actions,
  footer,
  flush = false,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Remove body padding (use for full-bleed tables). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const hasHeader = Boolean(title || actions || description);
  return (
    <section className={cn("overflow-hidden rounded-xl border border-line bg-card", className)}>
      {hasHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="font-head text-[16px] leading-tight text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className={cn(!flush && "p-4 sm:p-5", bodyClassName)}>{children}</div>
      ) : null}
      {footer ? (
        <footer className="border-t border-line-soft bg-bg-sunken/40 px-4 py-3 sm:px-5">{footer}</footer>
      ) : null}
    </section>
  );
}
