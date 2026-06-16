"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { DocsNavItem } from "../app/docs/docs-content";

/**
 * Section navigation for the docs page. Highlights the section currently in
 * view with a scroll spy, mirroring the calm, refined-light marketing nav.
 */
export function DocsSidebarNav({
  items,
  onNavigate,
}: {
  items: DocsNavItem[];
  onNavigate?: () => void;
}) {
  const [active, setActive] = useState(items[0]?.href.slice(1) ?? "");

  useEffect(() => {
    const ids = items.map((item) => item.href.slice(1));
    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const firstVisible = ids.find((id) => visible.has(id));
        if (firstVisible) setActive(firstVisible);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav aria-label="Docs sections" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isActive = item.href.slice(1) === active;
        return (
          <a
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "rounded-lg px-3 py-2 text-[14px] leading-snug transition-colors",
              isActive
                ? "bg-bg-sunken font-medium text-ink"
                : "text-muted hover:bg-bg-sunken/60 hover:text-ink",
            )}
          >
            {item.title}
          </a>
        );
      })}
    </nav>
  );
}
