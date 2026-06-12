"use client";

import { useEffect } from "react";

export default function Effects() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.2 }
    );

    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll("svg").forEach((svg) => {
        (svg as SVGSVGElement).pauseAnimations?.();
      });
    }

    return () => observer.disconnect();
  }, []);

  return null;
}
