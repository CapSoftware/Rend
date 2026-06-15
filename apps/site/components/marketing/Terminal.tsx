import { cn } from "@/components/ui/cn";
import { BrowserFrame } from "./BrowserFrame";

export type TerminalLine = {
  text: string;
  kind?: "prompt" | "comment" | "out" | "ok";
};

function Check() {
  return (
    <svg
      className="mt-[3px] inline-block shrink-0"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 13l5 5L20 6"
        stroke="var(--color-live)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Terminal({
  title = "bash",
  lines,
  className,
  cursor = true,
}: {
  title?: string;
  lines: TerminalLine[];
  className?: string;
  cursor?: boolean;
}) {
  return (
    <BrowserFrame
      kind="terminal"
      title={title}
      className={className}
      bodyClassName="bg-card px-5 py-4 font-mono text-[12.5px] leading-[1.95] sm:text-[13px]"
    >
      {lines.map((line, i) => {
        const kind = line.kind ?? "out";
        return (
          <div
            key={i}
            className={cn(
              "flex gap-2",
              kind === "comment" && "text-faint",
              kind === "out" && "text-muted",
              kind === "ok" && "text-ink",
            )}
          >
            {kind === "prompt" ? <span className="select-none text-faint">$</span> : null}
            {kind === "comment" ? <span className="select-none text-faint">#</span> : null}
            {kind === "ok" ? <Check /> : null}
            <span className={cn(kind === "prompt" && "text-ink", "min-w-0")}>
              {line.text}
              {cursor && i === lines.length - 1 ? (
                <span className="ml-1 inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-pulse bg-ink/70 align-middle" />
              ) : null}
            </span>
          </div>
        );
      })}
    </BrowserFrame>
  );
}
