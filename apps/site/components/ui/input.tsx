import type { ComponentProps } from "react";
import { cn } from "@/components/ui/cn";

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-line bg-bg-sunken px-2.5 text-[13px] text-ink-soft outline-none transition-colors placeholder:text-faint focus-visible:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/15 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
