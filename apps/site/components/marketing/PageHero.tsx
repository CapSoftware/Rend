import type { ReactNode } from "react";
import { Container } from "@/components/ui/Container";

/**
 * Shared hero for marketing subpages. Mirrors the homepage hero rhythm: a large
 * serif h1, a calm lede, then actions, with an optional product shot alongside.
 */
export function PageHero({
  title,
  lede,
  actions,
  aside,
}: {
  title: ReactNode;
  lede: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="relative pb-12 pt-10 sm:pt-14 md:pb-16 md:pt-20">
      <Container size="wide">
        <div className={aside ? "grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14" : ""}>
          <div className="max-w-[760px]">
            <h1 className="animate-rise text-[clamp(32px,6.4vw,54px)] leading-[1.05] tracking-[-0.02em]">
              {title}
            </h1>
            <div className="animate-rise animate-rise-2 mt-6 max-w-[640px] text-[17px] leading-[1.62] text-muted sm:mt-7">
              {lede}
            </div>
            {actions ? (
              <div className="animate-rise animate-rise-3 mt-8 flex flex-col gap-3 sm:flex-row">
                {actions}
              </div>
            ) : null}
          </div>
          {aside ? <div className="animate-rise animate-rise-3 min-w-0">{aside}</div> : null}
        </div>
      </Container>
    </section>
  );
}
