"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsCommandItem } from "../app/docs/docs-content";

type DocsCommandPaletteProps = {
  items: DocsCommandItem[];
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export default function DocsCommandPalette({ items }: DocsCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const filteredItems = useMemo(() => {
    const normalized = normalize(query);
    if (!normalized) return items;
    return items.filter((item) =>
      `${item.title} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized)
    );
  }, [items, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filteredItems.length) {
      setActiveIndex(Math.max(filteredItems.length - 1, 0));
    }
  }, [activeIndex, filteredItems.length]);

  function close() {
    setOpen(false);
    setQuery("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function navigateTo(item: DocsCommandItem) {
    close();
    window.location.assign(item.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, filteredItems.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filteredItems[activeIndex];
      if (item) navigateTo(item);
    }
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-3 border border-line bg-card px-4 text-[14px] font-medium text-muted transition hover:border-ink/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M21 21l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>Search docs</span>
        <kbd className="ml-auto border border-line bg-bg-sunken px-1.5 py-1 font-mono text-[11px] font-medium leading-none text-faint">
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div
          aria-labelledby="docs-command-title"
          aria-modal="true"
          className="fixed inset-0 z-[60] grid items-start justify-items-center bg-ink/30 px-4 pb-6 pt-[12vh] backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          role="dialog"
        >
          <div className="w-[min(620px,100%)] overflow-hidden rounded-2xl border border-line bg-card shadow-[0_30px_80px_-24px_rgba(22,21,19,0.4)]">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 id="docs-command-title" className="text-[14px] font-medium text-ink">
                Search docs
              </h2>
              <button
                aria-label="Close search"
                onClick={close}
                type="button"
                className="grid h-7 w-7 place-items-center rounded-md border border-line bg-card text-[18px] leading-none text-muted transition hover:border-ink/30 hover:text-ink"
              >
                ×
              </button>
            </div>
            <input
              aria-controls="docs-command-results"
              aria-label="Search docs"
              className="w-full border-b border-line bg-card px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-faint"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Type a section or command..."
              ref={inputRef}
              type="search"
              value={query}
            />
            <div
              className="max-h-[min(380px,56vh)] overflow-y-auto p-2"
              id="docs-command-results"
              role="listbox"
            >
              {filteredItems.length === 0 ? (
                <div className="px-3 py-5 text-[14px] text-muted">No results found.</div>
              ) : (
                filteredItems.map((item, index) => (
                  <button
                    aria-selected={index === activeIndex}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors aria-selected:bg-bg-sunken hover:bg-bg-sunken/70 focus-visible:bg-bg-sunken focus-visible:outline-none"
                    key={`${item.group}-${item.href}`}
                    onClick={() => navigateTo(item)}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <strong className="text-[14px] font-medium leading-tight text-ink">
                        {item.title}
                      </strong>
                      <small className="truncate text-[12px] leading-tight text-muted">
                        {item.description}
                      </small>
                    </span>
                    <em className="shrink-0 text-[11px] font-medium uppercase not-italic tracking-[0.06em] text-faint">
                      {item.group}
                    </em>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
