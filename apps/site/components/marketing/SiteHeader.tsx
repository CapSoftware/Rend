"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { cn } from "@/components/ui/cn";

type NavLink = { label: string; href: string; external?: boolean };

const defaultNav: NavLink[] = [
  { label: "Features", href: "/features" },
  { label: "Performance", href: "/performance" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: "https://github.com/CapSoftware/Rend", external: true },
];

const defaultCta = { label: "Get started", href: "/login?next=%2Fdashboard%2Fassets" };

function NavAnchor({
  link,
  onClick,
  block = false,
}: {
  link: NavLink;
  onClick?: () => void;
  block?: boolean;
}) {
  const className = block
    ? "block rounded-lg px-3 py-3 text-[15px] font-medium text-ink transition-colors hover:bg-bg-sunken focus-visible:bg-bg-sunken focus-visible:outline-none"
    : "text-sm font-medium text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none";
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className} onClick={onClick}>
      {link.label}
    </Link>
  );
}

export function SiteHeader({
  nav = defaultNav,
  cta = defaultCta,
  children,
}: {
  nav?: NavLink[];
  cta?: { label: string; href: string };
  children?: React.ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,border-color,box-shadow] duration-300",
        scrolled || open
          ? "border-b border-line bg-bg/85 backdrop-blur-md"
          : "border-b border-transparent",
      )}
    >
      <Container size="wide" className="flex items-center justify-between gap-4 py-3.5">
        <div className="flex flex-col items-start gap-0.5">
          <Link href="/" aria-label="Rend home" className="block">
            <img src="/rend-logo.svg" alt="Rend" className="block h-[34px] w-auto" />
          </Link>
          <a
            href="https://cap.so"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 flex items-center gap-[5px] text-[9px] font-medium leading-none text-faint transition-colors hover:text-ink"
          >
            A
            <img src="/cap-logo.svg" alt="Cap" className="block h-[10px] w-auto" />
            company
          </a>
        </div>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Primary">
          {nav.map((link) => (
            <NavAnchor key={link.label} link={link} />
          ))}
        </nav>

        <div className="flex items-center gap-2.5">
          {children}
          <Button href={cta.href} size="sm" className="hidden sm:inline-flex">
            {cta.label}
          </Button>
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-none border border-line bg-card text-ink transition hover:border-ink/30 md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="site-mobile-menu"
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {open ? (
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </Container>

      {open ? (
        <div id="site-mobile-menu" className="md:hidden">
          <Container size="wide" className="pb-5 pt-1">
            <nav className="flex flex-col rounded-2xl border border-line bg-card p-2 shadow-[0_24px_50px_-30px_rgba(22,21,19,0.4)]" aria-label="Mobile">
              {nav.map((link) => (
                <div key={link.label} className="border-b border-line-soft last:border-0">
                  <NavAnchor link={link} block onClick={() => setOpen(false)} />
                </div>
              ))}
              <div className="p-2 pt-3">
                <Button href={cta.href} size="md" className="w-full" onClick={() => setOpen(false)}>
                  {cta.label}
                </Button>
              </div>
            </nav>
          </Container>
        </div>
      ) : null}
    </header>
  );
}
