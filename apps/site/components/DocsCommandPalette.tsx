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
        className="docs-command-trigger"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <span>Search docs</span>
        <kbd>⌘K</kbd>
      </button>

      {open ? (
        <div
          aria-labelledby="docs-command-title"
          aria-modal="true"
          className="docs-command-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          role="dialog"
        >
          <div className="docs-command-dialog">
            <div className="docs-command-head">
              <h2 id="docs-command-title">Search docs</h2>
              <button aria-label="Close search" onClick={close} type="button">
                ×
              </button>
            </div>
            <input
              aria-controls="docs-command-results"
              aria-label="Search docs"
              className="docs-command-input"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Type a section or command..."
              ref={inputRef}
              type="search"
              value={query}
            />
            <div className="docs-command-list" id="docs-command-results" role="listbox">
              {filteredItems.length === 0 ? (
                <div className="docs-command-empty">No results found.</div>
              ) : (
                filteredItems.map((item, index) => (
                  <button
                    aria-selected={index === activeIndex}
                    className="docs-command-item"
                    key={`${item.group}-${item.href}`}
                    onClick={() => navigateTo(item)}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                    <em>{item.group}</em>
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
