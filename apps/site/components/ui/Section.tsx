import type { ReactNode } from "react";
import { cn } from "./cn";
import { Container, type ContainerSize } from "./Container";

const tones = {
  default: "",
  sunken: "bg-bg-sunken",
  ink: "bg-ink text-bg",
} as const;

const spacings = {
  default: "py-[clamp(60px,9vw,104px)]",
  tight: "py-[clamp(44px,7vw,80px)]",
  none: "",
} as const;

export function Section({
  id,
  tone = "default",
  spacing = "default",
  container = true,
  size = "wide",
  className,
  innerClassName,
  children,
  ...rest
}: {
  id?: string;
  tone?: keyof typeof tones;
  spacing?: keyof typeof spacings;
  container?: boolean;
  size?: ContainerSize;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <section
      id={id}
      className={cn("relative", spacings[spacing], tones[tone], className)}
      {...rest}
    >
      {container ? (
        <Container size={size} className={innerClassName}>
          {children}
        </Container>
      ) : (
        children
      )}
    </section>
  );
}
