/**
 * Avatar initials derived from a display name. Pure and never persisted.
 * No words → "?"; one word → its first character; otherwise the first
 * character of the first and last words. Unicode-safe (code points, not UTF-16
 * units), so a non-BMP first character is not split.
 */
export function getInitials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = (part: string) => Array.from(part)[0];
  const letters = parts.length === 1 ? first(parts[0]) : first(parts[0]) + first(parts[parts.length - 1]);
  return letters.toUpperCase();
}
