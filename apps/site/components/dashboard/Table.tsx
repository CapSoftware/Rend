import type { ComponentProps } from "react";
import { cn } from "@/components/ui/cn";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-[13px]", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("bg-bg-sunken/40", className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn(
        "[&>tr]:transition-colors [&>tr:hover]:bg-bg-sunken/50 [&>tr:last-child>td]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={className} {...props} />;
}

export function TH({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-line px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-faint",
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn("border-b border-line-soft px-4 py-3.5 align-middle text-ink-soft", className)}
      {...props}
    />
  );
}
