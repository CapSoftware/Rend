"use client";

import { useEffect } from "react";

export default function Effects() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll("svg").forEach((svg) => {
        (svg as SVGSVGElement).pauseAnimations?.();
      });
    }

    // Fallback: never leave content stuck hidden if the API is missing.
    if (typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("in-view"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0, rootMargin: "0px 0px -8% 0px" },
    );

    // Reveal anything already in (or above) the viewport synchronously, so a
    // missed or delayed observer callback can never leave a card invisible.
    // Only below-the-fold elements are handed to the observer for scroll reveal.
    for (const el of els) {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        el.classList.add("in-view");
      } else {
        observer.observe(el);
      }
    }

    return () => observer.disconnect();
  }, []);

  return null;
}
