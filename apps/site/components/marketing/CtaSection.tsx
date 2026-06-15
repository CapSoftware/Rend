import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { Section } from "@/components/ui/Section";
import { ArrowRight } from "./Icons";
import { START_HREF } from "@/lib/marketing-pages";

/** Shared closing call to action. Mirrors the homepage's inked final section. */
export function CtaSection({
  title = "Start shipping video today",
  primary = { label: "Open the dashboard", href: START_HREF },
  secondary = { label: "Read the docs", href: "/docs" },
}: {
  title?: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  return (
    <Section tone="ink" container={false} aria-label="Get started with Rend" className="overflow-hidden">
      <div aria-hidden="true" className="bg-line-grid pointer-events-none absolute inset-0 opacity-[0.06]" />
      <Container size="wide" className="relative">
        <h2 className="max-w-[640px] text-[clamp(29px,7vw,52px)] leading-[1.06] text-bg sm:leading-[1.05]">
          {title}
        </h2>
        <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button href={primary.href} size="lg" variant="inverse" className="w-full sm:w-auto">
            {primary.label} <ArrowRight />
          </Button>
          <Button href={secondary.href} size="lg" variant="inverse-outline" className="w-full sm:w-auto">
            {secondary.label}
          </Button>
        </div>
      </Container>
    </Section>
  );
}
