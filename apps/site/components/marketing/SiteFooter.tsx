import Link from "next/link";
import { Container } from "@/components/ui/Container";

type FooterLink = { label: string; href: string; external?: boolean };

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/features" },
      { label: "Performance", href: "/performance" },
      { label: "Benchmarks", href: "/benchmarks" },
      { label: "Pricing", href: "/pricing" },
      { label: "Compare", href: "/compare" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "OpenAPI", href: "/openapi.json", external: true },
      {
        label: "TypeScript SDK",
        href: "https://github.com/CapSoftware/Rend/tree/main/packages/sdk",
        external: true,
      },
      { label: "llms.txt", href: "/llms.txt", external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Cap", href: "https://cap.so", external: true },
      { label: "GitHub", href: "https://github.com/CapSoftware/Rend", external: true },
      { label: "rend.so", href: "https://rend.so", external: true },
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

function FooterAnchor({ link }: { link: FooterLink }) {
  const className = "text-sm text-muted transition-colors hover:text-ink";
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-line bg-bg-sunken">
      <Container size="wide" className="py-14 md:py-16">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div className="max-w-[320px]">
            <Link href="/" aria-label="Rend home" className="inline-block">
              <img src="/rend-logo.svg" alt="Rend" className="h-8 w-auto" />
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Video infrastructure for developers. One API call to upload, one URL that plays
              instantly anywhere. Open source, on hardware we own.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11.5px] font-medium text-muted">
                Server <span className="text-faint">AGPL</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11.5px] font-medium text-muted">
                SDKs <span className="text-faint">MIT</span>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 md:contents">
            {columns.map((col) => (
              <div key={col.title}>
                <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.1em] text-faint">
                  {col.title}
                </p>
                <ul className="flex flex-col gap-3">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <FooterAnchor link={link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 border-t border-line pt-6 text-sm text-muted">
          <p>© {year} Rend. Made by Cap Software, the team behind Cap.</p>
        </div>
      </Container>
    </footer>
  );
}
