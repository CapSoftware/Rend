import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Shared window chrome for the HTML "product shots" (terminal, dashboard, player).
 * Purely presentational: callers should mark the whole shot aria-hidden where it
 * is decorative.
 */
export function BrowserFrame({
  kind = "browser",
  title,
  actions,
  className,
  bodyClassName,
  children,
}: {
  kind?: "browser" | "terminal" | "app";
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("ui-window", className)}>
      <div className="ui-window__bar">
        <span className="ui-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {kind === "browser" ? (
          <div className="flex min-w-0 flex-1 justify-center px-3">
            {title ? (
              <span className="ui-chip min-w-0 max-w-full">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M7 11V8a5 5 0 0 1 10 0v3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
                </svg>
                <span className="truncate font-mono text-[12px]">{title}</span>
              </span>
            ) : null}
          </div>
        ) : (
          <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{title}</span>
        )}
        {actions ? <span className="ml-auto flex items-center gap-2">{actions}</span> : null}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
