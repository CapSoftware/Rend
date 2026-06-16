import { BookOpen } from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * Small rounded pill linking to a docs section. Used in page sub-headers.
 */
export function DocsPill({
  href,
  label = "Docs",
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-bg-sunken px-2 text-[12px] font-medium text-muted transition-colors hover:border-ink/20 hover:text-ink",
        className,
      )}
    >
      <BookOpen className="size-3.5 text-faint" />
      {label}
    </a>
  );
}
