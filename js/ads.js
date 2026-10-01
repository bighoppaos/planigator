// First-party ad labels from our own links. Totals are counted on the Worker.
// Nothing here is sent to Google, Meta, or any other ad company.

export const AD_STORE_KEY = "planigator.web.utm";
const LANDING_KEY = "planigator.web.utmLanding";
const FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const MAX = 80;

export function cleanUtm(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);
  if (!text || text.includes("@")) return "";
  return text;
}

export function touchFromParams(params) {
  const touch = {};
  for (const field of FIELDS) {
    const value = cleanUtm(params.get(field));
    if (value) touch[field] = value;
  }
  return Object.keys(touch).length ? touch : null;
}

function sameTouch(saved, incoming) {
  return FIELDS.every((field) => cleanUtm(saved?.[field]) === (incoming[field] || ""));
}

export function captureAds(search = globalThis.location?.search || "") {
  const incoming = touchFromParams(new URLSearchParams(search));
  if (!incoming) return null;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AD_STORE_KEY) || "null");
  } catch {
    saved = null;
  }
  const next = { ...incoming };
  if (saved?.counted && sameTouch(saved, incoming)) next.counted = true;
  try {
    localStorage.setItem(AD_STORE_KEY, JSON.stringify(next));
  } catch {
    // Private mode can refuse storage. The landing can still be counted.
  }
  return next;
}

export function utmForLogin() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AD_STORE_KEY) || "null");
  } catch {
    return null;
  }
  if (!saved || saved.counted) return null;
  const touch = {};
  for (const field of FIELDS) {
    const value = cleanUtm(saved[field]);
    if (value) touch[field] = value;
  }
  return Object.keys(touch).length ? touch : null;
}

export function markAdCounted() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AD_STORE_KEY) || "null");
  } catch {
    return;
  }
  if (!saved || typeof saved !== "object") return;
  saved.counted = true;
  try {
    localStorage.setItem(AD_STORE_KEY, JSON.stringify(saved));
  } catch {
    // The server already counted this sign-up.
  }
}

export function claimLanding(search = globalThis.location?.search || "") {
  const incoming = touchFromParams(new URLSearchParams(search));
  if (!incoming) return null;
  const stamp = FIELDS.map((field) => incoming[field] || "").join("\n");
  try {
    if (sessionStorage.getItem(LANDING_KEY) === stamp) return null;
  } catch {
    // Count this load if the tab cannot remember it.
  }
  return { incoming, stamp };
}

export function rememberLanding(stamp) {
  try {
    sessionStorage.setItem(LANDING_KEY, stamp);
  } catch {
    // A refresh may count the landing again.
  }
}
