import type { MarketingFaq } from "@/lib/marketing-pages";
import { Section } from "@/components/ui/Section";
import { SectionHeading } from "@/components/ui/SectionHeading";

/**
 * Plain, semantic FAQ section. Questions are real <h3>s and answers are
 * paragraphs, so both search engines and LLMs can extract the Q&A directly.
 * Pair with faqLd() for the FAQPage JSON-LD twin.
 */
export function Faq({
  faqs,
  title = "Frequently asked questions",
  lede,
  tone = "sunken",
}: {
  faqs: MarketingFaq[];
  title?: string;
  lede?: string;
  tone?: "default" | "sunken";
}) {
  return (
    <Section tone={tone} aria-label="Frequently asked questions">
      <SectionHeading title={title} lede={lede} />
      <dl className="mt-12 grid gap-px overflow-hidden rounded-[18px] border border-line bg-line sm:mt-14">
        {faqs.map((faq) => (
          <div key={faq.q} className="bg-card p-6 sm:p-7">
            <dt className="font-head text-[20px] leading-snug text-ink">{faq.q}</dt>
            <dd className="mt-2.5 max-w-[760px] text-[15px] leading-[1.65] text-muted">{faq.a}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
