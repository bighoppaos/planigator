// Raise the hero line cap in the planigator Worker.
//
// Do not deploy this until the owner approves the pull request.
// In the Worker's cleanHeroLines, change `.slice(0, 6)` to `.slice(0, 12)`.
// That is the same cap as HERO_LINE_MAX in js/hero-tiles.js.
// Until that ships, a save still keeps only the first six lines.
// The tile layout itself does not need a Worker change.

export const HERO_LINE_MAX = 12;

export function cleanHeroLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, HERO_LINE_MAX);
}
