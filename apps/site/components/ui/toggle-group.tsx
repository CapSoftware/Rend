"use client";

import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, useContext, type ComponentProps } from "react";
import { cn } from "@/components/ui/cn";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-muted transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-card data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
  {
    variants: {
      size: {
        sm: "h-8 px-2.5 text-[12.5px]",
        md: "h-9 px-3 text-[13px]",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants>>({ size: "sm" });

function ToggleGroup({
  className,
  size,
  children,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex w-fit items-center rounded-lg border border-line bg-bg-sunken p-0.5", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  size,
  children,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleVariants({ size: context.size ?? size }), className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
