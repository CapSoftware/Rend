export type ClassValue = string | number | false | null | undefined;

/** Tiny classnames joiner: filters falsy values and joins with spaces. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
