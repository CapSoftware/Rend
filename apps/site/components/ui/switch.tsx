"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/components/ui/cn";

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-inner transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ink/25 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-ink data-[state=unchecked]:border-line data-[state=unchecked]:bg-[#e7e3da]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] ring-0 transition-transform data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
