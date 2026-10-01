// Hero bullets become small tiles. A line is "label: short line".
// The part before the first colon is the bold label. No colon means the
// whole line is the label. Icons are picked from the words, not typed in.

export const HERO_LINE_MAX = 12;

const ICON_RULES = [
  ["delay", /\b(delays?|hourglass|waiting)\b/],
  ["compass", /\b(gps|navigation|navigate|navigating|compass)\b/],
  ["gauge", /\b(governed|speeds?|settings?|mph|gauge)\b/],
  ["clock", /\b(leeway|times?|clocks?|hours?)\b/],
  ["person", /\b(drivers?|drives|person|people)\b/],
  ["sun", /\b(cooler|sunglasses|cool)\b/],
  ["truck", /\b(trucks?|trailers?)\b/],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function cleanHeroLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => String(line ?? "").replace(/\s+/g, " ").trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, HERO_LINE_MAX);
}

export function splitHeroLine(line) {
  const text = String(line ?? "").replace(/\s+/g, " ").trim();
  const colon = text.indexOf(":");
  if (colon <= 0) return { label: text, detail: "" };
  const label = text.slice(0, colon).trim();
  const detail = text.slice(colon + 1).trim();
  if (!label) return { label: text, detail: "" };
  return { label, detail };
}

export function heroIconKind(line) {
  const hay = String(line ?? "").toLowerCase();
  for (const [kind, rule] of ICON_RULES) {
    if (rule.test(hay)) return kind;
  }
  return "mark";
}

function svg(paths) {
  return `<svg class="pitch-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  clock: svg(`<circle cx="12" cy="12" r="7.2" ${stroke}/><path d="M12 8.2V12l2.6 1.8" ${stroke}/>`),
  delay: svg(`<path d="M8 4h8M8 20h8M8.2 4.2c.2 3.2 3.8 3.6 3.8 7.8s-3.6 4.4-3.8 7.8M15.8 4.2c-.2 3.2-3.8 3.6-3.8 7.8s3.6 4.4 3.8 7.8" ${stroke}/>`),
  gauge: svg(`<path d="M5.2 16.2a6.8 6.8 0 0 1 13.6 0" ${stroke}/><path d="M12 16.2 15.2 11" ${stroke}/><circle cx="12" cy="16.2" r="1.15" fill="currentColor"/>`),
  compass: svg(`<circle cx="12" cy="12" r="7.2" ${stroke}/><path d="M14.8 9.2 13.2 13.2 9.2 14.8 10.8 10.8Z" fill="currentColor"/>`),
  person: svg(`<circle cx="12" cy="8" r="2.3" ${stroke}/><path d="M7.4 18.6c.7-2.8 2.4-4.2 4.6-4.2s3.9 1.4 4.6 4.2" ${stroke}/>`),
  sun: svg(`<path d="M4 11.2h2.2M17.8 11.2H20M8.2 11.2h7.6" ${stroke}/><circle cx="8.1" cy="13.4" r="2.5" ${stroke}/><circle cx="15.9" cy="13.4" r="2.5" ${stroke}/>`),
  truck: svg(`<path d="M3.5 15.2V8.2h8.2v7M11.7 10.4h3.6l2.8 2.8v2H11.7" ${stroke}/><circle cx="7" cy="16.6" r="1.25" fill="currentColor"/><circle cx="16.2" cy="16.6" r="1.25" fill="currentColor"/>`),
  mark: svg(`<path d="M12 3.8 13.5 9l5.4.2-4.3 3.2 1.5 5.1L12 14.7 8 17.5l1.5-5.1L5.2 9.2 10.6 9Z" fill="currentColor"/>`),
};

export function heroIconSvg(kind) {
  return ICONS[kind] || ICONS.mark;
}

export function heroTileHtml(line) {
  const { label, detail } = splitHeroLine(line);
  const icon = heroIconSvg(heroIconKind(line));
  const detailHtml = detail ? `<span class="pitch-detail">${escapeHtml(detail)}</span>` : "";
  // Keep the colon after the bold label when the saved line has one.
  const labelHtml = escapeHtml(detail ? `${label}:` : label);
  return `<li class="pitch-tile">${icon}<span class="pitch-text"><span class="pitch-label">${labelHtml}</span>${detailHtml}</span></li>`;
}
