import type { ElementType, ReactNode } from "react";
import { cn } from "./cn";

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "left",
  as: Tag = "h2",
  className,
  headingClassName,
  ledeClassName,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  align?: "left" | "center";
  as?: ElementType;
  className?: string;
  headingClassName?: string;
  ledeClassName?: string;
}) {
  const center = align === "center";
  return (
    <div className={cn(center ? "mx-auto max-w-[720px] text-center" : "max-w-[680px]", className)}>
      {eyebrow ? (
        <p className={cn("eyebrow mb-5", center && "eyebrow-center justify-center")}>{eyebrow}</p>
      ) : null}
      <Tag className={cn("text-[clamp(27px,5.6vw,44px)] leading-[1.12] sm:leading-[1.08]", headingClassName)}>{title}</Tag>
      {lede ? (
        <p
          className={cn(
            "mt-5 max-w-[620px] text-[17px] leading-[1.6] text-muted",
            center && "mx-auto",
            ledeClassName,
          )}
        >
          {lede}
        </p>
      ) : null}
    </div>
  );
}
